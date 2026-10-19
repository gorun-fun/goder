// api.go — API 主链路:就绪探针(hReady)、用户解析自检(hWhoami)、
// 用户代理主流程(hAPI:身份解析 → 懒启动用户专属进程 → 注入令牌转发)
// 与类型化错误的 HTTP 状态映射(upstreamError)。
package gateway

import (
	"encoding/json"
	"errors"
	"net/http"

	"git.gorun.fun/share/goder/pkg/ghserver"
)

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
			Prefix: g.prefix,
			Resolve: func(*http.Request) (ghserver.Upstream, error) {
				return ghserver.Upstream{Target: g.opts.FixedUpstream}, nil
			},
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
	// 平台托管供应商的 managed:true 注入(仅 GET /v1/agent/models;未声明
	// 受管名或注入失败时回落常规代理,见 adminhost.go)。
	if g.injectManagedModels(w, r, up, u.UID) {
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
