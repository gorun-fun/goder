// Package gateway — 多用户 web 网关:静态托管 + 按 API 前缀把请求路由到
// "当前用户专属的 gh server 进程"。与身份解析(identity)和进程管理
// (ghserver)组合;亦支持不托管进程的固定上游模式(直接反代外部
// gh server,令牌由浏览器携带)。
//
// 运维面:/healthz(存活)与 /healthz/ready(就绪,gh 二进制可解析);
// AdminToken 配置后开放 /admin/* 管理端点(statuses/start/stop/restart,
// headless 运维与三方后端的编程入口)。WebhookURL 配置后,用户进程
// 启停/崩溃事件 POST 回调给三方后端(会话完成等应用级事件仍走浏览器
// SSE 消费)。
package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
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
	// APIPrefix API 前缀,默认 /grf-api。
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
	// 令牌由浏览器 Authorization 头携带(兼容旧 GRF_UPSTREAM 用法)。
	FixedUpstream *url.URL
	// AdminToken 管理 API 令牌(空 = 关闭 /admin/*)。
	AdminToken string
	// WebhookURL 进程生命周期事件的 POST 回调(空 = 关闭)。
	WebhookURL string
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
		opts.APIPrefix = "/grf-api"
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

// wireWebhook 把进程生命周期回调转发到配置的 WebhookURL(POST JSON,
// 事件体 {type, uid, addr?, reason?, ts};投递尽力而为,失败记日志)。
func (g *Gateway) wireWebhook(m *ghserver.Manager) {
	hook := g.opts.WebhookURL
	if hook == "" {
		return
	}
	post := func(body map[string]any) {
		body["ts"] = time.Now().UTC().Format(time.RFC3339)
		raw, err := json.Marshal(body)
		if err != nil {
			return
		}
		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Post(hook, "application/json", bytes.NewReader(raw))
		if err != nil {
			log.Printf("webhook 投递失败: %v", err)
			return
		}
		_ = resp.Body.Close()
	}
	m.SetHooks(ghserver.ManagerHooks{
		OnStart: func(uid, addr string) { post(map[string]any{"type": "proc.started", "uid": uid, "addr": addr}) },
		OnStop:  func(uid, reason string) { post(map[string]any{"type": "proc.stopped", "uid": uid, "reason": reason}) },
		OnCrash: func(uid string) { post(map[string]any{"type": "proc.crashed", "uid": uid}) },
	})
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
	if g.opts.AccessLog {
		h = withAccessLog(h)
	}
	return h
}

// hReady 就绪探针:固定上游模式恒就绪;托管模式要求 gh 二进制可解析。
func (g *Gateway) hReady(w http.ResponseWriter, _ *http.Request) {
	if g.opts.FixedUpstream == nil && g.opts.Manager != nil {
		if ghserver.ResolveGhBin(g.opts.Manager.GhBin()) == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"ok":false,"reason":"gh binary not found"}`))
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// hWhoami 返回当前解析到的用户与后端进程地址(联调自检)。
func (g *Gateway) hWhoami(w http.ResponseWriter, r *http.Request) {
	u, err := g.opts.Resolver.Resolve(r)
	if err != nil {
		g.unauthorized(w)
		return
	}
	addr := ""
	if g.opts.Manager != nil {
		addr = g.opts.Manager.UserAddr(u.UID)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"uid":   u.UID,
		"name":  u.Name,
		"email": u.Email,
		"addr":  addr,
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
	up, err := g.opts.Manager.UserUpstream(u.UID)
	if err != nil {
		g.upstreamError(w, err)
		return
	}
	ghserver.NewProxy(ghserver.ProxyOptions{
		Prefix: g.prefix,
		Resolve: func(*http.Request) (ghserver.Upstream, error) {
			return up, nil
		},
	}).ServeHTTP(w, r)
}

// upstreamError 类型化错误 → HTTP 状态映射:容量类 429,进程未就绪/
// 冷却/启动失败 503,其余 502(调用方可程序化区分,不再一律 502)。
func (g *Gateway) upstreamError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	var se *ghserver.StartError
	switch {
	case errors.Is(err, ghserver.ErrTooManyUsers), errors.Is(err, ghserver.ErrPortExhausted):
		status = http.StatusTooManyRequests
	case errors.Is(err, ghserver.ErrStartCooling), errors.As(err, &se):
		status = http.StatusServiceUnavailable
	}
	http.Error(w, err.Error(), status)
}

// ---------- 管理 API(headless 运维与三方编程入口) ----------

// adminMux /admin/* 子路由:<prefix>/admin/statuses(GET)、
// /admin/start?uid=<>(POST,幂等拉起)、/admin/stop?uid=<>(POST)、
// /admin/restart?uid=<>(POST,停止后拉起 —— 配置变更/进程僵死时用;
// 会换端口,数据目录不变)。Bearer AdminToken 鉴权;start/restart 的
// 启动类错误走 upstreamError 的类型化状态映射。
func (g *Gateway) adminMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/statuses", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if g.opts.Manager == nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"managed": false})
			return
		}
		sts := g.opts.Manager.Statuses()
		out := make(map[string]map[string]any, len(sts))
		for uid, st := range sts {
			out[uid] = map[string]any{
				"running": st.Running, "addr": st.Addr,
				"last_error": st.LastError, "pid": st.PID,
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"managed": true, "users": out})
	})
	startHandler := func(restart bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			uid := r.URL.Query().Get("uid")
			if uid == "" {
				http.Error(w, "missing uid", http.StatusBadRequest)
				return
			}
			if g.opts.Manager == nil {
				http.Error(w, "not managed", http.StatusConflict)
				return
			}
			if restart {
				g.opts.Manager.Stop(uid)
			}
			p, err := g.opts.Manager.Get(uid)
			if err != nil {
				g.upstreamError(w, err)
				return
			}
			st := p.Status()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "uid": uid, "running": st.Running,
				"addr": st.Addr, "pid": st.PID,
			})
		}
	}
	mux.HandleFunc("/start", startHandler(false))
	mux.HandleFunc("/restart", startHandler(true))
	mux.HandleFunc("/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		uid := r.URL.Query().Get("uid")
		if uid == "" {
			http.Error(w, "missing uid", http.StatusBadRequest)
			return
		}
		if g.opts.Manager == nil {
			http.Error(w, "not managed", http.StatusConflict)
			return
		}
		g.opts.Manager.Stop(uid)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"endpoints":["statuses","start?uid=","stop?uid=","restart?uid="]}`))
	})
	return mux
}

func (g *Gateway) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer "+g.opts.AdminToken {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"管理令牌无效","type":"unauthorized"}}`))
			return
		}
		next.ServeHTTP(w, r)
	})
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

// withCORSOrigins 按白名单放行(回显命中的 Origin 并允许凭据,兼容
// cookie 会话模式;未命中不带 CORS 头,浏览器侧按同源处理)。
func withCORSOrigins(next http.Handler, origins []string) http.Handler {
	allow := make(map[string]bool, len(origins))
	for _, o := range origins {
		allow[strings.TrimRight(o, "/")] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && allow[strings.TrimRight(origin, "/")] {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder 请求日志需要的状态码捕获。
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// withAccessLog 结构化请求日志:方法 路径 状态 耗时。
func withAccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}


