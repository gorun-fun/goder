// proxy.go — /grf-api/* 同源反向代理:桌面 webview(wails:// 或
// http://wails.localhost)直连 http://127.0.0.1:7400 会被 CORS 拦截,
// gh server 也不带 CORS 头;统一经 app 自身转发(托管与远程模式都适用)。
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

const proxyPrefix = "/grf-api"

// upstream 当前应转发到的上游(托管实例优先,远程模式取配置)。
func upstreamTarget() string {
	cfg, err := (&AppConfig{}).Load()
	if err == nil && cfg.ServerMode == "remote" && cfg.RemoteURL != "" {
		return strings.TrimRight(cfg.RemoteURL, "/")
	}
	if addr, _, err := (&ServerManager{}).dirs(); err == nil {
		return "http://" + addr
	}
	return "http://127.0.0.1:7400"
}

// grfAPIHandler /grf-api 反向代理(SSE 即时 flush)。
func grfAPIHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WKWebView 的自定义 scheme 请求不带 Content-Length,wails 合成的
		// http.Request 因此 ContentLength=0;而 httputil.ReverseProxy 会把
		// ContentLength==0 的请求体直接置 nil(Go#16036),导致 POST body 丢失
		// (gh server 报 "invalid JSON body: unexpected end of JSON input")。
		// 这里先把 body 读全并补齐长度再转发。API 载荷为小 JSON,可整体缓冲。
		if r.Body != nil && r.ContentLength <= 0 {
			data, err := io.ReadAll(r.Body)
			_ = r.Body.Close()
			if err != nil {
				http.Error(w, "read request body: "+err.Error(), http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(data))
			r.ContentLength = int64(len(data))
			r.Header.Set("Content-Length", strconv.Itoa(len(data)))
		}
		target, err := url.Parse(upstreamTarget())
		if err != nil {
			http.Error(w, "bad upstream: "+err.Error(), http.StatusBadGateway)
			return
		}
		rp := &httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.SetURL(target)
				pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, proxyPrefix)
				if pr.Out.URL.Path == "" {
					pr.Out.URL.Path = "/"
				}
				pr.SetXForwarded()
			},
			FlushInterval: -1, // SSE 流式即时下发
			Transport: &http.Transport{
				DisableCompression: true,
			},
		}
		rp.ServeHTTP(w, r)
	})
}

// rootHandler 组合:/grf-api/* → 代理;/grf-api/token → 托管服务信息
// (同源直读,前端冷启动无需等 wails 调用通道);其余 → 前端静态资源。
func rootHandler(fallback http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/grf-api/token", serveManagedToken)
	mux.Handle(proxyPrefix+"/", grfAPIHandler())
	mux.Handle(proxyPrefix, grfAPIHandler())
	mux.Handle("/", fallback)
	return mux
}

// serveManagedToken 托管模式下的连接信息(仅本机 webview 的 wails:// 源可
// 访问;远程模式返回 remote 配置由前端本地掌握,不经此端点)。
func serveManagedToken(w http.ResponseWriter, r *http.Request) {
	cfg, err := (&AppConfig{}).Load()
	if err != nil {
		cfg = defaultConfig()
	}
	resp := map[string]any{"mode": cfg.ServerMode}
	if cfg.ServerMode == "managed" {
		st := GetServerManager().Status()
		resp["running"] = st.Running
		resp["addr"] = st.Addr
		resp["token"] = st.Token
	} else {
		resp["token"] = cfg.RemoteToken
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
