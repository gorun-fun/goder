// fake_test.go — 导出 FakeUpstream 的行为面:健康协议默认、令牌校验、
// 可编程响应(JSON/状态码/SSE)、请求记录、经反代的集成路径。
package ghserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFakeUpstreamDefaults(t *testing.T) {
	f := NewFakeUpstream()
	defer f.Close()

	// gh 健康协议默认 200(网关/桌面壳就绪探测)
	res, err := http.Get(f.Addr() + "/v1/health")
	if err != nil {
		t.Fatalf("health 请求: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("health 应 200,得到 %d", res.StatusCode)
	}

	// 未编程路径 404 且 JSON error 形状
	res2, err := http.Get(f.Addr() + "/v1/conversations")
	if err != nil {
		t.Fatalf("未编程请求: %v", err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusNotFound {
		t.Fatalf("未编程应 404,得到 %d", res2.StatusCode)
	}
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res2.Body).Decode(&body); err != nil {
		t.Fatalf("404 体应 JSON: %v", err)
	}
	if !strings.Contains(body.Error.Message, "未编程") {
		t.Fatalf("404 文案不符: %q", body.Error.Message)
	}
}

func TestFakeUpstreamHealthBearer(t *testing.T) {
	f := NewFakeUpstream()
	defer f.Close()
	f.RequireHealthBearer("tok-expected")

	req, _ := http.NewRequest(http.MethodGet, f.Addr()+"/v1/health", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("令牌不符应 401,得到 %d", res.StatusCode)
	}

	req2, _ := http.NewRequest(http.MethodGet, f.Addr()+"/v1/health", nil)
	req2.Header.Set("Authorization", "Bearer tok-expected")
	res2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("请求: %v", err)
	}
	res2.Body.Close()
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("令牌匹配应 200,得到 %d", res2.StatusCode)
	}
}

func TestFakeUpstreamProgrammableResponses(t *testing.T) {
	f := NewFakeUpstream()
	defer f.Close()

	f.RespondJSON(http.MethodGet, "/v1/conversations", `{"data":[{"id":"c1"}]}`)
	f.RespondStatus(http.MethodPost, "/v1/responses", http.StatusServiceUnavailable)

	res, err := http.Get(f.Addr() + "/v1/conversations")
	if err != nil {
		t.Fatalf("请求: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if string(b) != `{"data":[{"id":"c1"}]}` {
		t.Fatalf("JSON 响应不符: %s", b)
	}

	res2, _ := http.Post(f.Addr()+"/v1/responses", "application/json", strings.NewReader("{}"))
	res2.Body.Close()
	if res2.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("状态码注入不符: %d", res2.StatusCode)
	}

	// 后注册优先(覆写)
	f.RespondJSON(http.MethodGet, "/v1/conversations", `{"data":[]}`)
	res3, err := http.Get(f.Addr() + "/v1/conversations")
	if err != nil {
		t.Fatalf("请求: %v", err)
	}
	defer res3.Body.Close()
	b3, _ := io.ReadAll(res3.Body)
	if string(b3) != `{"data":[]}` {
		t.Fatalf("后注册应优先: %s", b3)
	}
}

func TestFakeUpstreamSSE(t *testing.T) {
	f := NewFakeUpstream()
	defer f.Close()
	f.RespondSSE(http.MethodPost, "/v1/responses",
		FakeSSEFrame{Data: `{"type":"response.output_text.delta","delta":"你"}`},
		FakeSSEFrame{Delay: 30 * time.Millisecond, Data: `{"type":"response.completed"}`},
	)

	res, err := http.Post(f.Addr()+"/v1/responses", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("SSE 请求: %v", err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("Content-Type 应 event-stream: %q", ct)
	}
	b, _ := io.ReadAll(res.Body)
	got := string(b)
	if !strings.Contains(got, "data: {\"type\":\"response.output_text.delta\"") || !strings.Contains(got, "data: {\"type\":\"response.completed\"}") {
		t.Fatalf("SSE 帧缺失: %q", got)
	}
}

func TestFakeUpstreamRecords(t *testing.T) {
	f := NewFakeUpstream()
	defer f.Close()

	req, _ := http.NewRequest(http.MethodPost, f.Addr()+"/v1/responses?stream=1", strings.NewReader(`{"input":"你好"}`))
	req.Header.Set("Authorization", "Bearer tok-x")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求: %v", err)
	}
	res.Body.Close()

	recs := f.RequestsFor(http.MethodPost, "/v1/responses")
	if len(recs) != 1 {
		t.Fatalf("过滤记录数不符: %d", len(recs))
	}
	r := recs[0]
	if r.Auth != "Bearer tok-x" || r.Query != "stream=1" || string(r.Body) != `{"input":"你好"}` {
		t.Fatalf("记录字段不符: %+v", r)
	}

	f.Reset()
	if len(f.Requests()) != 0 {
		t.Fatalf("Reset 应清空记录")
	}
}

func TestFakeUpstreamThroughProxy(t *testing.T) {
	// 集成路径:NewProxy(前缀剥离 + 令牌注入)→ FakeUpstream(健康
	// 令牌校验 + 可编程响应)—— 网关接入方测试的标准装配形态。
	f := NewFakeUpstream()
	defer f.Close()
	f.RequireHealthBearer("user-token")
	f.RespondJSON(http.MethodGet, "/v1/conversations", `{"data":[]}`)

	h := NewProxy(ProxyOptions{
		Prefix: "/goder-api",
		Resolve: func(*http.Request) (Upstream, error) {
			return Upstream{Target: f.URL(), Token: "user-token"}, nil
		},
	})

	// 经反代访问 health:令牌被注入,fake 的 Bearer 校验通过
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "http://x/goder-api/v1/health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("经反代 health 应 200(令牌注入直证),得到 %d", w.Code)
	}

	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "http://x/goder-api/v1/conversations", nil))
	if w2.Code != http.StatusOK || !strings.Contains(w2.Body.String(), `"data"`) {
		t.Fatalf("经反代取会话列表不符: %d %s", w2.Code, w2.Body.String())
	}
}
