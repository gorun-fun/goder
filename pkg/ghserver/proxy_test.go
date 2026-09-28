// proxy_test.go — 反代核心测试:前缀剥离与令牌注入、WKWebView 无长度
// 请求体的缓冲补齐、体积上限、Resolve 错误映射。
package ghserver

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// recordingUpstream 记录收到的请求(路径/鉴权头/体),供断言。
type recordingUpstream struct {
	*httptest.Server
	gotPath string
	gotAuth string
	gotBody []byte
	gotLen  int64
}

func newRecordingUpstream() *recordingUpstream {
	up := &recordingUpstream{}
	up.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up.gotPath = r.URL.Path
		up.gotAuth = r.Header.Get("Authorization")
		up.gotLen = r.ContentLength
		up.gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	return up
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("解析上游地址: %v", err)
	}
	return u
}

func TestProxyRewriteAndTokenInjection(t *testing.T) {
	up := newRecordingUpstream()
	defer up.Close()

	h := NewProxy(ProxyOptions{
		Prefix: "/grf-api",
		Resolve: func(*http.Request) (Upstream, error) {
			return Upstream{Target: mustURL(t, up.URL), Token: "tok-1"}, nil
		},
	})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "http://x/grf-api/v1/conversations", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("状态码 %d", w.Code)
	}
	if up.gotPath != "/v1/conversations" {
		t.Fatalf("前缀未剥离: %s", up.gotPath)
	}
	if up.gotAuth != "Bearer tok-1" {
		t.Fatalf("令牌未注入: %q", up.gotAuth)
	}
}

func TestProxyKeepsClientCredentialsOverwritten(t *testing.T) {
	// 浏览器侧凭证一律被上游令牌覆盖(多用户网关令牌边界)
	up := newRecordingUpstream()
	defer up.Close()
	h := NewProxy(ProxyOptions{
		Prefix: "/grf-api",
		Resolve: func(*http.Request) (Upstream, error) {
			return Upstream{Target: mustURL(t, up.URL), Token: "server-side"}, nil
		},
	})
	req := httptest.NewRequest(http.MethodGet, "http://x/grf-api/v1/x", nil)
	req.Header.Set("Authorization", "Bearer browser-leaked")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if up.gotAuth != "Bearer server-side" {
		t.Fatalf("浏览器令牌未被覆盖: %q", up.gotAuth)
	}
}

func TestProxyPrefixOnlyPath(t *testing.T) {
	// 请求恰为前缀本身 → 上游收到 /
	up := newRecordingUpstream()
	defer up.Close()
	h := NewProxy(ProxyOptions{
		Prefix: "/grf-api",
		Resolve: func(*http.Request) (Upstream, error) {
			return Upstream{Target: mustURL(t, up.URL)}, nil
		},
	})
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://x/grf-api", nil))
	if up.gotPath != "/" {
		t.Fatalf("空前缀应归一为 /,得到 %q", up.gotPath)
	}
}

func TestProxyBodyBackfill(t *testing.T) {
	// WKWebView 自定义 scheme 请求 ContentLength=0:体必须被缓冲补齐,
	// 否则 ReverseProxy 会把请求体置 nil(Go#16036)。
	up := newRecordingUpstream()
	defer up.Close()
	h := NewProxy(ProxyOptions{
		Prefix: "/grf-api",
		Resolve: func(*http.Request) (Upstream, error) {
			return Upstream{Target: mustURL(t, up.URL), Token: "t"}, nil
		},
	})
	body := []byte(`{"input":[{"type":"input_text","text":"你好"}]}`)
	req := httptest.NewRequest(http.MethodPost, "http://x/grf-api/v1/responses", bytes.NewReader(body))
	req.ContentLength = 0 // 模拟 wails 合成请求
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("状态码 %d", w.Code)
	}
	if !bytes.Equal(up.gotBody, body) {
		t.Fatalf("body 丢失或不符: %q", up.gotBody)
	}
	if up.gotLen != int64(len(body)) {
		t.Fatalf("Content-Length 未补齐: %d", up.gotLen)
	}
}

func TestProxyBodyLimit(t *testing.T) {
	up := newRecordingUpstream()
	defer up.Close()
	h := NewProxy(ProxyOptions{
		Prefix:       "/grf-api",
		MaxBodyBytes: 8,
		Resolve: func(*http.Request) (Upstream, error) {
			return Upstream{Target: mustURL(t, up.URL)}, nil
		},
	})
	req := httptest.NewRequest(http.MethodPost, "http://x/grf-api/v1/responses", strings.NewReader("0123456789ABCDEF"))
	req.ContentLength = 0
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超限应 413,得到 %d", w.Code)
	}
}

func TestProxyResolveError(t *testing.T) {
	h := NewProxy(ProxyOptions{
		Prefix: "/grf-api",
		Resolve: func(*http.Request) (Upstream, error) {
			return Upstream{}, io.ErrUnexpectedEOF
		},
	})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "http://x/grf-api/v1/x", nil))
	if w.Code != http.StatusBadGateway {
		t.Fatalf("Resolve 失败应 502,得到 %d", w.Code)
	}
}
