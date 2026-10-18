// middleware.go — 壳层中间件与统一应答:CORS(通配/白名单两种模式)、
// 安全响应头、访问日志(含 statusRecorder 状态捕获)、401 未登录统一
// 应答(带 login_url 供前端跳登录)。
package gateway

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

// unauthorized 401 统一应答;带 login_url 时前端可据此跳登录。
func (g *Gateway) unauthorized(w http.ResponseWriter) {
	login := ""
	if g.opts.Resolver != nil {
		login = g.opts.Resolver.LoginURL()
	}
	w.Header().Set("Content-Type", "application/json")
	if login != "" {
		w.Header().Set("Goder-Login", g.prefix+login)
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

// withSecurityHeaders 统一安全响应头。刻意不设 Content-Security-Policy:
// 嵌入方宿主页面各不相同,goder 无法预知其合法资源源;需要 CSP 的部署
// 由上级反代追加。
func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
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
