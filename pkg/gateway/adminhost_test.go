// adminhost_test.go — 宿主管理端点的 HTTP 行为测试:供应商声明/指纹/
// 解析、插件安装/清单/卸载、会话索引(管理面 + 用户态)、用户目录生命
// 周期、managed:true 注入(假 gh 上游)。全程不依赖真实 gh。
package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.gorun.fun/share/goder/pkg/ghserver"
	"git.gorun.fun/share/goder/pkg/identity"
)

// newHostGateway 带 Manager(PerUserHome)+ AdminToken + 固定用户解析的
// 测试网关;返回 Manager 供断言目录布局。
func newHostGateway(t *testing.T) (*ghserver.Manager, *httptest.Server) {
	t.Helper()
	m := ghserver.NewManager(ghserver.ManagerConfig{
		GhBin:       "/definitely-not-gh",
		DataRoot:    t.TempDir(),
		PerUserHome: true,
	})
	_, srv := newTestGateway(t, Options{
		AdminToken: "secret",
		Manager:    m,
		Resolver:   &stubResolver{User: identity.User{UID: "zhang san", Name: "zhang san"}},
	})
	return m, srv
}

func adminDo(t *testing.T, srv *httptest.Server, method, path string, body any) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, raw
}

func TestHostAdminProvidersFlow(t *testing.T) {
	m, srv := newHostGateway(t)
	decl := map[string]any{
		"entries": []map[string]any{{
			"name": "OpenOS", "base_url": "http://127.0.0.1:1/api/ai/v1",
			"api_key": "pk-zhang-san", "models": []string{"m1"},
		}},
		"managed":       []string{"OpenOS"},
		"default":       "OpenOS/m1",
		"force_default": true,
	}
	resp, raw := adminDo(t, srv, http.MethodPut, "/goder-api/admin/users/zhang san/providers", decl)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"applied":true`) {
		t.Fatalf("声明应 200 且 applied: %d %s", resp.StatusCode, raw)
	}
	sp := filepath.Join(m.UserGrfHome("zhang san"), "settings.json")
	if _, err := os.Stat(sp); err != nil {
		t.Fatalf("settings.json 应已起播: %v", err)
	}
	// 指纹查询:mark 非空 + 受管名回读
	resp, raw = adminDo(t, srv, http.MethodGet, "/goder-api/admin/users/zhang san/providers", nil)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"OpenOS"`) {
		t.Fatalf("指纹查询异常: %d %s", resp.StatusCode, raw)
	}
	var got struct {
		Mark string `json:"mark"`
	}
	_ = json.Unmarshal(raw, &got)
	if got.Mark == "" {
		t.Fatal("mark 应非空")
	}
	// 解析:限定名/裸名命中、未含报 not_found
	resp, raw = adminDo(t, srv, http.MethodGet, "/goder-api/admin/users/zhang san/resolve-model?name=m1", nil)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"resolved":"OpenOS/m1"`) {
		t.Fatalf("裸名应解析: %d %s", resp.StatusCode, raw)
	}
	_, raw = adminDo(t, srv, http.MethodGet, "/goder-api/admin/users/zhang san/resolve-model?name=zz", nil)
	if !strings.Contains(string(raw), `"not_found"`) {
		t.Fatalf("未含应 not_found: %s", raw)
	}
}

func TestHostAdminPluginsFlow(t *testing.T) {
	m, srv := newHostGateway(t)
	cmd := []string{"/opt/openos-server", "mcp-shim", "http://127.0.0.1:7712/mcp", "tok", "张 三"}
	resp, raw := adminDo(t, srv, http.MethodPost, "/goder-api/admin/plugins/install", map[string]any{
		"uid": "张 三", "name": "openos", "command": cmd,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("安装失败: %d %s", resp.StatusCode, raw)
	}
	if _, err := os.Stat(filepath.Join(m.UserGrfHome("张 三"), "plugins", "openos")); err != nil {
		t.Fatalf("wrapper 应存在: %v", err)
	}
	// 清单回读原始 uid(目录名清洗不可逆,规格存档是唯一来源)
	_, raw = adminDo(t, srv, http.MethodGet, "/goder-api/admin/plugins", nil)
	if !strings.Contains(string(raw), `"uid":"张 三"`) {
		t.Fatalf("清单应含原始 uid: %s", raw)
	}
	// 卸载
	resp, raw = adminDo(t, srv, http.MethodDelete,
		"/goder-api/admin/plugins?uid="+url.QueryEscape("张 三")+"&name=openos", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("卸载失败: %d %s", resp.StatusCode, raw)
	}
	if _, err := os.Stat(filepath.Join(m.UserGrfHome("张 三"), "plugins", "openos")); !os.IsNotExist(err) {
		t.Fatal("wrapper 应删除")
	}
}

func TestHostAdminUsersAndIndex(t *testing.T) {
	m, srv := newHostGateway(t)
	// 造一个用户目录(经声明起播)
	_, _ = adminDo(t, srv, http.MethodPut, "/goder-api/admin/users/u1/providers", map[string]any{
		"entries": []map[string]any{}, "managed": []string{"OpenOS"},
	})
	resp, raw := adminDo(t, srv, http.MethodGet, "/goder-api/admin/users", nil)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"san":"u1"`) {
		t.Fatalf("用户清单异常: %d %s", resp.StatusCode, raw)
	}
	// 索引:整存 → 追加 → 回读(项目确保 + 保真)
	idx := `{"version":1,"projects":[],"sessions":{},"automation":[{"k":1}]}`
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/goder-api/admin/users/u1/index", strings.NewReader(idx))
	req.Header.Set("Authorization", "Bearer secret")
	r1, err := http.DefaultClient.Do(req)
	if err != nil || r1.StatusCode != http.StatusOK {
		t.Fatalf("索引整存失败: %v %v", err, r1)
	}
	r1.Body.Close()
	resp, raw = adminDo(t, srv, http.MethodPost, "/goder-api/admin/users/u1/index/sessions", map[string]any{
		"sid": "s1", "project_id": "fixer", "project_name": "自动修复",
		"title": "修复", "model": "P/m", "last_response_id": "r1",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("追加失败: %d %s", resp.StatusCode, raw)
	}
	_, raw = adminDo(t, srv, http.MethodGet, "/goder-api/admin/users/u1/index", nil)
	if !strings.Contains(string(raw), `"fixer"`) || !strings.Contains(string(raw), `"s1"`) ||
		!strings.Contains(string(raw), `"automation"`) {
		t.Fatalf("索引回读应含项目/会话/未知键: %s", raw)
	}
	// 用户态端点(stubResolver 恒解析为 zhang san)
	req, _ = http.NewRequest(http.MethodGet, srv.URL+"/goder-api/index", nil)
	r2, err := http.DefaultClient.Do(req)
	if err != nil || r2.StatusCode != http.StatusOK {
		t.Fatalf("用户态索引查询失败: %v", r2)
	}
	body, _ := io.ReadAll(r2.Body)
	r2.Body.Close()
	if string(body) != "null" && !strings.Contains(string(body), "zhang") {
		// zhang san 无索引 → null;不因内容断言形态,只验证端点可用
		t.Logf("用户态索引返回: %s", body)
	}
	// 删号:目录级联清理
	resp, raw = adminDo(t, srv, http.MethodDelete, "/goder-api/admin/users/u1", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("删号失败: %d %s", resp.StatusCode, raw)
	}
	if _, err := os.Stat(m.UserRoot("u1")); !os.IsNotExist(err) {
		t.Fatal("用户目录应删除")
	}
}

func TestManagedModelsInjection(t *testing.T) {
	// 假 gh 上游:GET /v1/agent/models 返回两个供应商
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"path":"/x","providers":[{"name":"OpenOS","baseUrl":"b","models":["m"],"hasKey":true},{"name":"Mine","models":[]}]}`))
	}))
	defer fake.Close()
	target, _ := url.Parse(fake.URL)

	m := ghserver.NewManager(ghserver.ManagerConfig{
		GhBin: "/definitely-not-gh", DataRoot: t.TempDir(), PerUserHome: true,
	})
	g, _ := newTestGateway(t, Options{Manager: m, AdminToken: "s"})
	if err := ghserver.WriteManagedProviders(m.UserRoot("u1"), []string{"OpenOS"}); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, "/goder-api/v1/agent/models", nil)
	rec := httptest.NewRecorder()
	if !g.injectManagedModels(rec, req, ghserver.Upstream{Target: target, Token: "t"}, "u1") {
		t.Fatal("注入应命中")
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	provs := body["providers"].([]any)
	first := provs[0].(map[string]any)
	if first["managed"] != true {
		t.Fatal("受管名应注入 managed:true")
	}
	if _, ok := provs[1].(map[string]any)["managed"]; ok {
		t.Fatal("非受管名不得注入")
	}
	// 未声明受管名 → 不拦截(回落常规代理)
	rec2 := httptest.NewRecorder()
	if g.injectManagedModels(rec2, req, ghserver.Upstream{Target: target}, "nobody") {
		t.Fatal("无受管名不应命中")
	}
	// 非 models 路径 → 不拦截
	req2, _ := http.NewRequest(http.MethodGet, "/goder-api/v1/conversations", nil)
	rec3 := httptest.NewRecorder()
	if g.injectManagedModels(rec3, req2, ghserver.Upstream{Target: target}, "u1") {
		t.Fatal("非 models 路径不应命中")
	}
}
