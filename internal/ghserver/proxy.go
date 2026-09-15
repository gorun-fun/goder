// proxy.go — gh server 反向代理核心:去前缀、注入 Bearer 令牌、SSE 即时
// 下发,并整体缓冲无 Content-Length 的请求体再补齐(WKWebView 自定义
// scheme 请求不带长度,直接转发会丢 POST body,见 Go#16036)。桌面壳与
// 多用户网关共用。
package ghserver

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

// Upstream 一次请求应转发到的上游(目标地址与应注入的令牌)。
type Upstream struct {
	Target *url.URL // gh server 根地址
	Token  string   // 注入的 Bearer 令牌(空 = 原样转发)
}

// ProxyOptions 反代处理器参数。
type ProxyOptions struct {
	// Prefix 被剥离的路径前缀(如 /grf-api)。
	Prefix string
	// Resolve 每请求解析上游;返回错误时以 502 响应。
	Resolve func(r *http.Request) (Upstream, error)
}

// NewProxy 构建 gh server 反代处理器。
func NewProxy(opts ProxyOptions) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WKWebView 的自定义 scheme 请求不带 Content-Length,wails 合成的
		// http.Request 因此 ContentLength=0;而 httputil.ReverseProxy 会把
		// ContentLength==0 的请求体直接置 nil,导致 POST body 丢失。
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
		up, err := opts.Resolve(r)
		if err != nil {
			http.Error(w, "bad upstream: "+err.Error(), http.StatusBadGateway)
			return
		}
		target := *up.Target // 每请求拷贝,ReverseProxy 只读
		rp := &httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.SetURL(&target)
				pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, opts.Prefix)
				if pr.Out.URL.Path == "" {
					pr.Out.URL.Path = "/"
				}
				pr.SetXForwarded()
				if up.Token != "" {
					// 用户级令牌由网关/桌面壳注入,浏览器侧凭证一律覆盖。
					pr.Out.Header.Set("Authorization", "Bearer "+up.Token)
				}
			},
			FlushInterval: -1, // SSE 流式即时下发
			Transport: &http.Transport{
				DisableCompression: true,
			},
		}
		rp.ServeHTTP(w, r)
	})
}
