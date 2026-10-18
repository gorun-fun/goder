// Package gateway — 多用户 web 网关:静态托管 + 按 API 前缀把请求路由到
// "当前用户专属的 gh server 进程"。与身份解析(identity)和进程管理
// (ghserver)组合;亦支持不托管进程的固定上游模式(直接反代外部
// gh server,令牌由浏览器携带)。
//
// 运维面:/healthz(存活)与 /healthz/ready(就绪,gh 二进制可解析);
// AdminToken 配置后开放 /admin/* 管理端点(statuses/start/stop/restart,
// headless 运维与三方后端的编程入口)。WebhookURL 配置后,用户进程
// 启停/崩溃事件 POST 回调给三方后端(WebhookSecret 配置时附 HMAC-SHA256
// 签名头;回合级应用事件由 gh 子进程的 GRF_TURN_WEBHOOK_* 外发,见
// pkg/ghserver 的 ExtraEnv 透传)。
//
// 文件分工:本文件只做生命周期(创建/回收协程/优雅 Shutdown)与路由
// 装配;API 主链路见 api.go,管理 API 见 admin.go,中间件与统一 401 见
// middleware.go,webhook 接线见 webhook.go。
package gateway

import (
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"git.gorun.fun/share/goder/pkg/ghserver"
	"git.gorun.fun/share/goder/pkg/identity"
)

// Options 网关参数。
type Options struct {
	// APIPrefix API 前缀,默认 /goder-api。
	APIPrefix string
	// StaticDir 前端静态目录;空 = 纯 API 网关。
	StaticDir string
	// CORS 对 API 前缀放行跨域(嵌入联调用;公网收紧)。
	// 与 CORSOrigins 互斥:给出 Origins 时按列表精确放行(回显 Origin
	// 并允许凭据,适配 cookie 会话模式);CORS=true 且无 Origins 时为
	// 旧的通配模式(无凭据)。
	CORS bool
	// CORSOrigins 允许的 Origin 列表(精确匹配;空 = 不启用)。
	CORSOrigins []string
	// Resolver + Manager:托管模式 —— 一个用户一个 gh server 进程。
	Resolver identity.Resolver
	Manager  *ghserver.Manager
	// FixedUpstream 直连模式 —— 反代外部 gh server,不托管进程,
	// 令牌由浏览器 Authorization 头携带(兼容旧 GODER_UPSTREAM 用法)。
	FixedUpstream *url.URL
	// AdminToken 管理 API 令牌(空 = 关闭 /admin/*)。
	AdminToken string
	// WebhookURL 进程生命周期事件的 POST 回调(空 = 关闭)。
	WebhookURL string
	// WebhookSecret 事件体 HMAC-SHA256 签名密钥(空 = 不签名)。配置后
	// 每次回调附 X-Goder-Signature: sha256=<hex(body)>,接收方以常量
	// 时间比较校验后再信任事件体(公网/跨信任域回调必配)。
	WebhookSecret string
	// AccessLog 请求日志(stdout:方法 路径 状态 耗时)。
	AccessLog bool
}

// Gateway 多用户网关。
type Gateway struct {
	opts   Options
	prefix string
	stop   chan struct{}
	once   sync.Once
}

// New 创建网关;托管模式下按 IdleTTL 起后台空闲回收,并接进程生命周期
// webhook。
func New(opts Options) *Gateway {
	if opts.APIPrefix == "" {
		opts.APIPrefix = "/goder-api"
	}
	opts.APIPrefix = strings.TrimRight(opts.APIPrefix, "/")
	g := &Gateway{opts: opts, prefix: opts.APIPrefix, stop: make(chan struct{})}
	if opts.Manager != nil {
		g.wireWebhook(opts.Manager)
		if ttl := opts.Manager.IdleTTL(); ttl > 0 {
			interval := ttl / 4
			if interval < 30*time.Second {
				interval = 30 * time.Second
			}
			go func() {
				t := time.NewTicker(interval)
				defer t.Stop()
				for {
					select {
					case <-t.C:
						_ = opts.Manager.ReapIdle()
					case <-g.stop:
						return
					}
				}
			}()
		}
	}
	return g
}

// Shutdown 停止回收协程并回收全部用户进程(幂等)。
func (g *Gateway) Shutdown() {
	g.once.Do(func() {
		close(g.stop)
		if g.opts.Manager != nil {
			g.opts.Manager.StopAll()
		}
	})
}

// Handler 组装完整 HTTP 处理器。
func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()

	// 登录流程路由(sso 模式):<prefix>/auth/* → resolver.Routes()。
	if g.opts.Resolver != nil && g.opts.Resolver.Routes() != nil {
		authRoutes := g.opts.Resolver.Routes()
		mux.Handle(g.prefix+"/auth/", http.StripPrefix(g.prefix+"/auth", authRoutes))
	}
	// 网关健康(不带身份,探活用)。
	mux.HandleFunc(g.prefix+"/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	// 就绪探针:gh 二进制可解析(进程按用户懒启动,此处只验证可承载)。
	mux.HandleFunc(g.prefix+"/healthz/ready", g.hReady)
	// 用户解析自检:集成方验证 header/会话接线是否正确。
	if g.opts.Resolver != nil {
		mux.HandleFunc(g.prefix+"/whoami", g.hWhoami)
	}
	// 管理 API(可选;AdminToken 保护)。
	if g.opts.AdminToken != "" {
		mux.Handle(g.prefix+"/admin/", http.StripPrefix(g.prefix+"/admin", g.requireAdmin(g.adminMux())))
	}
	// 其余 API 全部进用户代理。
	api := http.Handler(http.HandlerFunc(g.hAPI))
	if len(g.opts.CORSOrigins) > 0 {
		api = withCORSOrigins(api, g.opts.CORSOrigins)
	} else if g.opts.CORS {
		api = withCORS(api)
	}
	mux.Handle(g.prefix+"/", api)
	mux.Handle(g.prefix, api)

	// 静态托管(可选)。
	if g.opts.StaticDir != "" {
		if st, err := os.Stat(g.opts.StaticDir); err == nil && st.IsDir() {
			mux.Handle("/", http.FileServer(http.Dir(g.opts.StaticDir)))
		}
	}
	h := http.Handler(mux)
	// 安全响应头(nosniff + 不外泄 Referrer):对 API 与静态页统一生效,
	// 防响应被当脚本/样式嗅探执行、嵌入方页面环境信息外泄。
	h = withSecurityHeaders(h)
	if g.opts.AccessLog {
		h = withAccessLog(h)
	}
	return h
}
