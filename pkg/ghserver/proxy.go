// proxy.go — gh server 反向代理核心:去前缀、注入 Bearer 令牌、SSE 即时
// 下发,并整体缓冲无 Content-Length 的请求体再补齐(WKWebView 自定义
// scheme 请求不带长度,直接转发会丢 POST body,见 Go#16036)。桌面壳与
// 多用户网关共用。
//
// 工程化:ReverseProxy 实例按上游(地址+令牌)缓存复用,Transport 全局
// 共享(连接池按目标主机复用,不再每请求新建);无长度请求体的缓冲加
// MaxBytesReader 上限,多用户网关上堵住内存 DoS 面。
package ghserver

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

// Upstream 一次请求应转发到的上游(目标地址与应注入的令牌)。
type Upstream struct {
	Target *url.URL // gh server 根地址
	Token  string   // 注入的 Bearer 令牌(空 = 原样转发)
}

// ProxyOptions 反代处理器参数。
type ProxyOptions struct {
	// Prefix 被剥离的路径前缀(如 /goder-api)。
	Prefix string
	// Resolve 每请求解析上游;返回错误时以 502 响应。
	Resolve func(r *http.Request) (Upstream, error)
	// MaxBodyBytes 无 Content-Length 请求体缓冲的上限;0 = 默认 64MB。
	// (API 载荷为小 JSON + 图片 base64,64MB 是宽松上限;多租户网关
	// 可按需收紧。)
	MaxBodyBytes int64
}

// sharedTransport 全局共享 Transport:连接池按目标主机复用,keep-alive
// 生效;DisableCompression 保持上游原始字节流(SSE 分帧不受压缩干扰)。
var sharedTransport = &http.Transport{
	DisableCompression: true,
}

// proxyCache 按「地址|令牌」缓存 ReverseProxy(令牌随进程重启变化,
// 变化即新键,旧实例自然淘汰;数量与用户进程数同量级)。
var proxyCache sync.Map // key string → *httputil.ReverseProxy

func proxyFor(up Upstream, prefix string) *httputil.ReverseProxy {
	key := up.Target.String() + "|" + up.Token
	if v, ok := proxyCache.Load(key); ok {
		return v.(*httputil.ReverseProxy)
	}
	target := *up.Target // 每上游拷贝,ReverseProxy 只读
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(&target)
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, prefix)
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
		Transport:     sharedTransport,
	}
	actual, _ := proxyCache.LoadOrStore(key, rp)
	return actual.(*httputil.ReverseProxy)
}

// NewProxy 构建 gh server 反代处理器(代理实例按上游缓存复用)。
func NewProxy(opts ProxyOptions) http.Handler {
	maxBody := opts.MaxBodyBytes
	if maxBody <= 0 {
		maxBody = 64 << 20
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WKWebView 的自定义 scheme 请求不带 Content-Length,wails 合成的
		// http.Request 因此 ContentLength=0;而 httputil.ReverseProxy 会把
		// ContentLength==0 的请求体直接置 nil,导致 POST body 丢失。
		// 这里先把 body 读全并补齐长度再转发。API 载荷为小 JSON,可整体
		// 缓冲;MaxBytesReader 堵住超限请求(内存 DoS 面)。
		if r.Body != nil && r.ContentLength <= 0 {
			data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
			_ = r.Body.Close()
			if err != nil {
				http.Error(w, "read request body: "+err.Error(), http.StatusRequestEntityTooLarge)
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
		proxyFor(up, opts.Prefix).ServeHTTP(w, r)
	})
}
