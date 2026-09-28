// fake.go — 导出的可编程 fake 上游(网关接入方测试装具)。
//
// 面向部署 goder-serve / 复用 pkg/gateway 的接入方:FixedUpstream
// 指向本 fake 即可零 gh 二进制测网关全链路(按用户路由、令牌注入、
// 多用户隔离、类型化错误映射)。与 proxy_test.go 的包内 recordingUpstream
// 的区别:并发安全、请求历史(非覆盖式)、可编程响应(按方法+路径精确
// 匹配,后注册优先)、SSE 帧脚本、gh 健康协议默认行为。
//
// 典型用法:
//
//	fake := ghserver.NewFakeUpstream()
//	defer fake.Close()
//	fake.RespondJSON("GET", "/v1/conversations", `{"data":[]}`)
//	gw := gateway.New(gateway.Options{
//	    FixedUpstream: &gateway.Upstream{Target: fake.URL(), Token: "tok"},
//	    // …
//	})
//	// 断言:fake.Requests() 里读到网关转发的请求(令牌已被注入)
//
// 边界:fake 只模拟 HTTP 协议面,不是 gh 进程——Proc/Manager 的进程
// 管理面(启动/收养/端口池/回收)请用真实 gh 二进制测(本包测试即如此)。
package ghserver

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"time"
)

// FakeRequest 已记录的一次上游请求(断言用)。
type FakeRequest struct {
	Method string
	Path   string
	Query  string
	Auth   string // Authorization 头原样
	Body   []byte
	At     time.Time
}

// FakeSSEFrame 一帧 SSE 输出:Delay 后写 Data(data: 行负载,原样)。
type FakeSSEFrame struct {
	Delay time.Duration
	Data  string
}

// FakeUpstream 并发安全的可编程 fake gh 上游。
type FakeUpstream struct {
	server *httptest.Server

	mu        sync.Mutex
	requests  []FakeRequest
	handlers  []fakeRoute
	maxRecord int

	// healthBearer 非空时 /v1/health 校验 Bearer(测网关令牌注入)。
	healthBearer string
}

type fakeRoute struct {
	method  string
	path    string
	handler http.HandlerFunc
}

// NewFakeUpstream 起一个 fake 上游(记得 Close)。默认行为:
//   - GET /v1/health → 200(可选校验 Bearer,见 RequireHealthBearer);
//   - 其余未编程路径 → 404 {"error":{"message":"fake upstream: 未编程"}}。
func NewFakeUpstream() *FakeUpstream {
	f := &FakeUpstream{maxRecord: 1000}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

// URL 返回上游地址(已解析,可直接作 Upstream.Target)。
func (f *FakeUpstream) URL() *url.URL {
	u, err := url.Parse(f.server.URL)
	if err != nil {
		panic(fmt.Sprintf("fake upstream 地址不可解析: %v", err))
	}
	return u
}

// Addr 返回上游地址字符串(host:port 形态,日志用)。
func (f *FakeUpstream) Addr() string { return f.server.URL }

// Close 关停底层服务器。
func (f *FakeUpstream) Close() { f.server.Close() }

// RequireHealthBearer 让 /v1/health 校验 Bearer 令牌(不匹配返回 401)
// —— 断言「网关确实注入了用户级令牌」的直证。
func (f *FakeUpstream) RequireHealthBearer(token string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.healthBearer = token
}

// RespondJSON 编程一个精确匹配(方法+路径)的 JSON 响应。后注册优先。
func (f *FakeUpstream) RespondJSON(method, path, body string) {
	f.Respond(method, path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	})
}

// RespondStatus 编程一个纯状态码响应(错误注入:503/429 …)。
func (f *FakeUpstream) RespondStatus(method, path string, status int) {
	f.Respond(method, path, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
	})
}

// RespondSSE 编程一个流式响应:逐帧(可带延迟)写 `data: <Data>\n\n`,
// Content-Type 为 text/event-stream —— 测网关的 SSE flush 透传。
func (f *FakeUpstream) RespondSSE(method, path string, frames ...FakeSSEFrame) {
	f.Respond(method, path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for _, fr := range frames {
			if fr.Delay > 0 {
				select {
				case <-time.After(fr.Delay):
				case <-r.Context().Done():
					return
				}
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", fr.Data)
			if flusher != nil {
				flusher.Flush()
			}
		}
	})
}

// Respond 编程任意 handler(最大灵活度;请求已被记录后再进入)。
func (f *FakeUpstream) Respond(method, path string, handler http.HandlerFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handlers = append([]fakeRoute{{method: method, path: path, handler: handler}}, f.handlers...)
}

// Requests 返回已记录的请求副本(时间升序)。
func (f *FakeUpstream) Requests() []FakeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]FakeRequest, len(f.requests))
	copy(out, f.requests)
	return out
}

// RequestsFor 便捷过滤:方法+路径前缀匹配的记录。
func (f *FakeUpstream) RequestsFor(method, pathPrefix string) []FakeRequest {
	var out []FakeRequest
	for _, r := range f.Requests() {
		if r.Method == method && strings.HasPrefix(r.Path, pathPrefix) {
			out = append(out, r)
		}
	}
	return out
}

// Reset 清空请求历史与已编程路由(复用同一 fake 跑隔离用例)。
func (f *FakeUpstream) Reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = nil
	f.handlers = nil
	f.healthBearer = ""
}

func (f *FakeUpstream) serve(w http.ResponseWriter, r *http.Request) {
	var body []byte
	if r.Body != nil {
		body = readAllUpTo(r, 1<<20)
	}
	f.mu.Lock()
	rec := FakeRequest{
		Method: r.Method,
		Path:   r.URL.Path,
		Query:  r.URL.RawQuery,
		Auth:   r.Header.Get("Authorization"),
		Body:   body,
		At:     time.Now(),
	}
	f.requests = append(f.requests, rec)
	if len(f.requests) > f.maxRecord {
		f.requests = f.requests[len(f.requests)-f.maxRecord:]
	}
	healthBearer := f.healthBearer
	routes := make([]fakeRoute, len(f.handlers))
	copy(routes, f.handlers)
	f.mu.Unlock()

	// 默认 gh 健康协议:网关/桌面壳的就绪探测路径
	if r.URL.Path == "/v1/health" && r.Method == http.MethodGet {
		if healthBearer != "" && r.Header.Get("Authorization") != "Bearer "+healthBearer {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": "fake upstream: 令牌不符"}})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
		return
	}

	for _, rt := range routes {
		if rt.method == r.Method && rt.path == r.URL.Path {
			rt.handler(w, r)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(`{"error":{"message":"fake upstream: 未编程的路径 ` + r.URL.Path + `"}}`))
}

// readAllUpTo 读请求体(上限外截断,防大体撑爆记录)。
func readAllUpTo(r *http.Request, limit int64) []byte {
	defer r.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(r.Body, limit))
	return b
}
