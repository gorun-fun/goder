// gateway_test.go — 网关 HTTP 行为测试:admin 鉴权与参数校验、
// unauthorized 应答、CORS 白名单、健康探针、固定上游直通。
package gateway

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gorun-fun/goder/pkg/ghserver"
	"github.com/gorun-fun/goder/pkg/identity"
)

// stubResolver 固定解析结果的 Resolver(测 unauthorized 的 login_url 等)。
type stubResolver struct {
	identity.User
	login string
}

func (s *stubResolver) Resolve(*http.Request) (identity.User, error) { return s.User, nil }
func (s *stubResolver) LoginURL() string                             { return s.login }
func (s *stubResolver) Routes() http.Handler                         { return nil }

func newTestGateway(t *testing.T, opts Options) (*Gateway, *httptest.Server) {
	t.Helper()
	g := New(opts)
	srv := httptest.NewServer(g.Handler())
	t.Cleanup(func() {
		srv.Close()
		g.Shutdown()
	})
	return g, srv
}

func TestAdminAuth(t *testing.T) {
	_, srv := newTestGateway(t, Options{AdminToken: "secret"})
	resp, err := http.Get(srv.URL + "/goder-api/admin/statuses")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无令牌应 401,得到 %d", resp.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/goder-api/admin/statuses", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("错令牌应 401,得到 %d", resp2.StatusCode)
	}
}

func TestAdminStatusesUnmanaged(t *testing.T) {
	_, srv := newTestGateway(t, Options{AdminToken: "secret"})
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/goder-api/admin/statuses", nil)
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 %d", resp.StatusCode)
	}
	body := make([]byte, 128)
	n, _ := resp.Body.Read(body)
	if !strings.Contains(string(body[:n]), `"managed":false`) {
		t.Fatalf("无 Manager 应报 managed:false,得到 %s", body[:n])
	}
}

func TestAdminStartValidation(t *testing.T) {
	_, srv := newTestGateway(t, Options{AdminToken: "secret"})

	do := func(method, path string) int {
		req, _ := http.NewRequest(method, srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer secret")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := do(http.MethodGet, "/goder-api/admin/start?uid=u1"); code != http.StatusMethodNotAllowed {
		t.Fatalf("start GET 应 405,得到 %d", code)
	}
	if code := do(http.MethodPost, "/goder-api/admin/start"); code != http.StatusBadRequest {
		t.Fatalf("start 缺 uid 应 400,得到 %d", code)
	}
	if code := do(http.MethodPost, "/goder-api/admin/restart"); code != http.StatusBadRequest {
		t.Fatalf("restart 缺 uid 应 400,得到 %d", code)
	}
	if code := do(http.MethodPost, "/goder-api/admin/start?uid=u1"); code != http.StatusConflict {
		t.Fatalf("start 无 Manager 应 409,得到 %d", code)
	}
}

func TestAdminRestartWithBadBinary(t *testing.T) {
	// 坏 GhBin:Manager 托管但启动失败 → 503(StartError 类型化映射),
	// 全程不依赖真实 gh。
	m := ghserver.NewManager(ghserver.ManagerConfig{
		GhBin:    "/definitely-not-gh",
		DataRoot: t.TempDir(),
		PortMin:  18511, PortMax: 18519,
	})
	_, srv := newTestGateway(t, Options{AdminToken: "secret", Manager: m})

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/goder-api/admin/restart?uid=u1", nil)
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("坏二进制 restart 应 503,得到 %d", resp.StatusCode)
	}
}

func TestUnauthorizedResponse(t *testing.T) {
	// header resolver 缺头必拒 → 401;LoginURL 为空时不带 Goder-Login 头
	_, srv := newTestGateway(t, Options{
		Resolver: identity.NewHeader(identity.HeaderConfig{}),
		Manager: ghserver.NewManager(ghserver.ManagerConfig{
			GhBin: "/definitely-not-gh", DataRoot: t.TempDir(),
		}),
	})
	resp, err := http.Get(srv.URL + "/goder-api/v1/conversations")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("缺头应 401,得到 %d", resp.StatusCode)
	}
	if resp.Header.Get("Goder-Login") != "" {
		t.Fatal("无登录流程不应带 Goder-Login 头")
	}
}

func TestWhoami(t *testing.T) {
	_, srv := newTestGateway(t, Options{
		Resolver: &stubResolver{User: identity.User{UID: "u1", Name: "n"}},
		Manager:  nil,
	})
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/goder-api/whoami", nil)
	req.Header.Set("X-GRF-UID", "u1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("whoami 状态码 %d", resp.StatusCode)
	}
}

func TestHealthzAndReady(t *testing.T) {
	_, srv := newTestGateway(t, Options{})
	if resp, err := http.Get(srv.URL + "/goder-api/healthz"); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: %v %v", err, resp)
	} else {
		resp.Body.Close()
	}
	// 固定上游模式恒就绪
	_, srv2 := newTestGateway(t, Options{FixedUpstream: &url.URL{Scheme: "http", Host: "127.0.0.1:1"}})
	if resp, err := http.Get(srv2.URL + "/goder-api/healthz/ready"); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("固定上游 ready 应 200: %v", err)
	} else {
		resp.Body.Close()
	}
}

func TestCORSWhitelist(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer up.Close()
	target, _ := url.Parse(up.URL)
	_, srv := newTestGateway(t, Options{
		CORSOrigins:   []string{"https://app.example.com"},
		FixedUpstream: target,
	})

	hit, _ := http.NewRequest(http.MethodGet, srv.URL+"/goder-api/v1/x", nil)
	hit.Header.Set("Origin", "https://app.example.com")
	resp, err := http.DefaultClient.Do(hit)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Fatalf("白名单命中应回显 Origin,得到 %q", got)
	}
	if resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("白名单模式应允许凭据")
	}

	miss, _ := http.NewRequest(http.MethodGet, srv.URL+"/goder-api/v1/x", nil)
	miss.Header.Set("Origin", "https://evil.example.net")
	resp2, err := http.DefaultClient.Do(miss)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if got := resp2.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("未命中不应带 CORS 头,得到 %q", got)
	}
}

func TestFixedUpstreamProxying(t *testing.T) {
	var gotPath, gotAuth string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
	}))
	defer up.Close()
	target, _ := url.Parse(up.URL)
	_, srv := newTestGateway(t, Options{FixedUpstream: target})

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/goder-api/v1/health", nil)
	req.Header.Set("Authorization", "Bearer browser-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("直通模式状态码 %d", resp.StatusCode)
	}
	if gotPath != "/v1/health" {
		t.Fatalf("前缀未剥离: %s", gotPath)
	}
	if gotAuth != "Bearer browser-token" {
		t.Fatalf("直通模式应保留浏览器令牌,得到 %q", gotAuth)
	}
}
