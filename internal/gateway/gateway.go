// Package gateway — 多用户 web 网关:静态托管 + 按 API 前缀把请求路由到
// "当前用户专属的 gh server 进程"。与身份解析(internal/identity)和进程
// 管理(internal/ghserver)组合;亦支持不托管进程的固定上游模式(直接
// 反代外部 gh server,令牌由浏览器携带)。
package gateway

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"git.gorun.fun/share/goder/internal/ghserver"
	"git.gorun.fun/share/goder/internal/identity"
)

// Options 网关参数。
type Options struct {
	// APIPrefix API 前缀,默认 /grf-api。
	APIPrefix string
	// StaticDir 前端静态目录;空 = 纯 API 网关。
	StaticDir string
	// CORS 对 API 前缀放行跨域(嵌入联调用;公网收紧)。
	CORS bool
	// Resolver + Manager:托管模式 —— 一个用户一个 gh server 进程。
	Resolver identity.Resolver
	Manager  *ghserver.Manager
	// FixedUpstream 直连模式 —— 反代外部 gh server,不托管进程,
	// 令牌由浏览器 Authorization 头携带(兼容旧 GRF_UPSTREAM 用法)。
	FixedUpstream *url.URL
}

// Gateway 多用户网关。
type Gateway struct {
	opts   Options
	prefix string
	stop   chan struct{}
}

// New 创建网关;托管模式下按 IdleTTL 起后台空闲回收。
func New(opts Options) *Gateway {
	if opts.APIPrefix == "" {
		opts.APIPrefix = "/grf-api"
	}
	opts.APIPrefix = strings.TrimRight(opts.APIPrefix, "/")
	g := &Gateway{opts: opts, prefix: opts.APIPrefix, stop: make(chan struct{})}
	if opts.Manager != nil {
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

// Shutdown 停止回收协程并回收全部用户进程。
func (g *Gateway) Shutdown() {
	close(g.stop)
	if g.opts.Manager != nil {
		g.opts.Manager.StopAll()
	}
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
	// 用户解析自检:集成方验证 header/会话接线是否正确。
	if g.opts.Resolver != nil {
		mux.HandleFunc(g.prefix+"/whoami", g.hWhoami)
	}
	// 其余 API 全部进用户代理。
	api := http.Handler(http.HandlerFunc(g.hAPI))
	if g.opts.CORS {
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
	return mux
}

// hWhoami 返回当前解析到的用户与后端进程地址(联调自检)。
func (g *Gateway) hWhoami(w http.ResponseWriter, r *http.Request) {
	u, err := g.opts.Resolver.Resolve(r)
	if err != nil {
		g.unauthorized(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"uid":   u.UID,
		"name":  u.Name,
		"email": u.Email,
		"addr":  g.opts.Manager.UserAddr(u.UID),
	})
}

// hAPI 用户代理主流程:身份解析 → 取(懒启动)用户专属进程 → 注入该
// 进程令牌转发。浏览器不需要也不应持有各用户的 gh 令牌。
func (g *Gateway) hAPI(w http.ResponseWriter, r *http.Request) {
	// 直连模式:固定上游 + 浏览器自带令牌。
	if g.opts.FixedUpstream != nil {
		ghserver.NewProxy(ghserver.ProxyOptions{
			Prefix:  g.prefix,
			Resolve: func(*http.Request) (ghserver.Upstream, error) { return ghserver.Upstream{Target: g.opts.FixedUpstream}, nil },
		}).ServeHTTP(w, r)
		return
	}

	u, err := g.opts.Resolver.Resolve(r)
	if err != nil {
		g.unauthorized(w)
		return
	}
	proc, err := g.opts.Manager.Get(u.UID)
	if err != nil {
		http.Error(w, "gh server 不可用: "+err.Error(), http.StatusBadGateway)
		return
	}
	st := proc.Status()
	if !st.Running {
		http.Error(w, "gh server 未就绪: "+st.LastError, http.StatusBadGateway)
		return
	}
	target, _ := url.Parse("http://" + st.Addr)
	ghserver.NewProxy(ghserver.ProxyOptions{
		Prefix: g.prefix,
		Resolve: func(*http.Request) (ghserver.Upstream, error) {
			return ghserver.Upstream{Target: target, Token: st.Token}, nil
		},
	}).ServeHTTP(w, r)
}

// unauthorized 401 统一应答;带 login_url 时前端可据此跳登录。
func (g *Gateway) unauthorized(w http.ResponseWriter) {
	login := ""
	if g.opts.Resolver != nil {
		login = g.opts.Resolver.LoginURL()
	}
	w.Header().Set("Content-Type", "application/json")
	if login != "" {
		w.Header().Set("Grf-Login", g.prefix+login)
	}
	w.WriteHeader(http.StatusUnauthorized)
	body := map[string]any{"error": map[string]any{"message": "未登录或会话已过期", "type": "unauthorized"}}
	if login != "" {
		body["login_url"] = g.prefix + login
	}
	_ = json.NewEncoder(w).Encode(body)
}

// withCORS 预检 + 简单响应都带宽松 CORS 头(本地联调工具,公网部署请收紧)。
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
