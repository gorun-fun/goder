// sso_test.go — Casdoor SSO 登录流程测试:httptest 假 Casdoor 覆盖
// 授权码换取(exchange)、用户信息拉取(userinfo)、回调 state 校验
// (错 state 拒绝)、DevEmail 开发后门;/me 未登录 401 的 JSON 应答格式。
package identity

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// fakeCasdoor 假 Casdoor 服务:实现 /api/login/oauth/access_token(授权码
// 换令牌)与 /api/userinfo(拉用户信息)两个端点,记录收到的请求供断言。
type fakeCasdoor struct {
	*httptest.Server

	mu sync.Mutex
	// exchangeReqs 收到的换令牌表单(每次一条)。
	exchangeReqs []url.Values
	// userinfoAuths 收到的 userinfo 请求 Authorization 头。
	userinfoAuths []string

	// token 换发的 access_token;tokenCode 非空时只接受该授权码。
	token     string
	tokenCode string
	// tokenStatus 换令牌端点应答状态码(错误注入,默认 200)。
	tokenStatus int
	// userinfoBody userinfo 端点应答体。
	userinfoBody string
}

func newFakeCasdoor() *fakeCasdoor {
	fc := &fakeCasdoor{tokenStatus: http.StatusOK}
	fc.Server = httptest.NewServer(http.HandlerFunc(fc.serve))
	return fc
}

func (fc *fakeCasdoor) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/login/oauth/access_token":
		_ = r.ParseForm()
		fc.mu.Lock()
		fc.exchangeReqs = append(fc.exchangeReqs, r.PostForm)
		token, code, status := fc.token, fc.tokenCode, fc.tokenStatus
		fc.mu.Unlock()
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		if code != "" && r.PostForm.Get("code") != code {
			// 授权码不符:模拟 Casdoor 拒绝(仍 200 但不带令牌)。
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"access_token":%q}`, token)
	case "/api/userinfo":
		fc.mu.Lock()
		fc.userinfoAuths = append(fc.userinfoAuths, r.Header.Get("Authorization"))
		body := fc.userinfoBody
		fc.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	default:
		http.NotFound(w, r)
	}
}

// recordingStore 记录 Put 进来的会话(测试断言签发内容)。
type recordingStore struct {
	mu     sync.Mutex
	saved  []Session
	delTok string
}

func (rs *recordingStore) Get(string) (Session, bool) { return Session{}, false }
func (rs *recordingStore) Put(s Session) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.saved = append(rs.saved, s)
}
func (rs *recordingStore) Del(token string) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.delTok = token
}

func (rs *recordingStore) sessions() []Session {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	out := make([]Session, len(rs.saved))
	copy(out, rs.saved)
	return out
}

// newTestSSO 配好假 Casdoor 的 Resolver(默认 userinfo 带 id,uid 取 id)。
func newTestSSO(t *testing.T, fc *fakeCasdoor, store SessionStore) *ssoResolver {
	t.Helper()
	return NewSSO(SSOConfig{
		Endpoint:     fc.URL,
		ClientID:     "cid-1",
		ClientSecret: "sec-1",
		RedirectURL:  "http://app.example.com/goder-api/auth/callback",
		Sessions:     store,
	}).(*ssoResolver)
}

func TestSSOExchange(t *testing.T) {
	fc := newFakeCasdoor()
	defer fc.Close()
	fc.token = "tok-123"
	res := newTestSSO(t, fc, &recordingStore{})

	tok, err := res.exchange("code-abc")
	if err != nil {
		t.Fatalf("exchange 失败: %v", err)
	}
	if tok != "tok-123" {
		t.Fatalf("令牌不符: %q", tok)
	}
	// 换令牌请求应带 OAuth2 授权码流程的完整表单。
	reqs := fc.exchangeReqs
	if len(reqs) != 1 {
		t.Fatalf("应恰好一次换令牌请求,得到 %d", len(reqs))
	}
	want := map[string]string{
		"grant_type": "authorization_code", "client_id": "cid-1",
		"client_secret": "sec-1", "code": "code-abc",
		"redirect_uri": "http://app.example.com/goder-api/auth/callback",
	}
	for k, v := range want {
		if got := reqs[0].Get(k); got != v {
			t.Fatalf("表单字段 %s = %q,期望 %q", k, got, v)
		}
	}
}

func TestSSOExchangeUpstreamError(t *testing.T) {
	fc := newFakeCasdoor()
	defer fc.Close()
	fc.tokenStatus = http.StatusInternalServerError
	res := newTestSSO(t, fc, &recordingStore{})

	if _, err := res.exchange("code-abc"); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("上游 5xx 应报 HTTP 状态错误,得到 %v", err)
	}
}

func TestSSOUserinfo(t *testing.T) {
	fc := newFakeCasdoor()
	defer fc.Close()
	fc.userinfoBody = `{"sub":"sub-1","name":"张三","email":"z@example.com"}`
	res := newTestSSO(t, fc, &recordingStore{})

	u, err := res.userinfo("tok-123")
	if err != nil {
		t.Fatalf("userinfo 失败: %v", err)
	}
	// id 缺失时 uid 回落 sub
	if u.UID != "sub-1" || u.Name != "张三" || u.Email != "z@example.com" {
		t.Fatalf("用户信息不符: %+v", u)
	}
	if len(fc.userinfoAuths) != 1 || fc.userinfoAuths[0] != "Bearer tok-123" {
		t.Fatalf("userinfo 应带 Bearer 令牌,得到 %v", fc.userinfoAuths)
	}

	// id 与 sub 并存时 uid 优先取 id(Casdoor 用户 UUID)。
	fc.userinfoBody = `{"sub":"sub-1","id":"uuid-9","name":"n","email":"e"}`
	u2, err := res.userinfo("tok-123")
	if err != nil || u2.UID != "uuid-9" {
		t.Fatalf("uid 应优先取 id,得到 %+v %v", u2, err)
	}
}

func TestSSOUserinfoMissingIdentity(t *testing.T) {
	fc := newFakeCasdoor()
	defer fc.Close()
	fc.userinfoBody = `{"name":"无名"}`
	res := newTestSSO(t, fc, &recordingStore{})

	if _, err := res.userinfo("tok-123"); err == nil {
		t.Fatal("缺 id/sub 应报错(无稳定 uid 不可作隔离键)")
	}
}

func TestSSOCallbackIssuesSession(t *testing.T) {
	fc := newFakeCasdoor()
	defer fc.Close()
	fc.token = "at-1"
	fc.tokenCode = "code-ok"
	fc.userinfoBody = `{"sub":"s","id":"uuid-9","name":"张三","email":"z@example.com"}`
	store := &recordingStore{}
	res := newTestSSO(t, fc, store)

	// 携带正确 state cookie 的回调:换令牌 → 拉用户 → 签发本地会话。
	req := httptest.NewRequest(http.MethodGet, "/callback?code=code-ok&state=st-1", nil)
	req.AddCookie(&http.Cookie{Name: stateCookie, Value: "st-1"})
	w := httptest.NewRecorder()
	res.Routes().ServeHTTP(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("回调成功应 302 跳首页,得到 %d(%s)", w.Code, w.Body.String())
	}
	if loc := w.Header().Get("Location"); loc != "/" {
		t.Fatalf("跳转地址不符: %q", loc)
	}
	sessions := store.sessions()
	if len(sessions) != 1 {
		t.Fatalf("应签发恰好一条会话,得到 %d", len(sessions))
	}
	if sessions[0].User.UID != "uuid-9" || sessions[0].User.Email != "z@example.com" {
		t.Fatalf("会话用户不符: %+v", sessions[0].User)
	}
	if sessions[0].Expires.IsZero() {
		t.Fatal("会话应带有效期")
	}
	// 会话 cookie 与存储令牌一致;state cookie 已被清除(MaxAge=-1)。
	var sessCookie, stateCk *http.Cookie
	for _, c := range w.Result().Cookies() {
		switch c.Name {
		case sessionCookie:
			sessCookie = c
		case stateCookie:
			stateCk = c
		}
	}
	if sessCookie == nil || sessCookie.Value != sessions[0].Token {
		t.Fatalf("会话 cookie 未签发或与令牌不符: %+v", sessCookie)
	}
	if !sessCookie.HttpOnly {
		t.Fatal("会话 cookie 应 HttpOnly")
	}
	if stateCk == nil || stateCk.MaxAge != -1 {
		t.Fatalf("state cookie 应被清除: %+v", stateCk)
	}
}

func TestSSOCallbackRejectsBadState(t *testing.T) {
	fc := newFakeCasdoor()
	defer fc.Close()
	fc.token = "at-1"
	store := &recordingStore{}
	res := newTestSSO(t, fc, store)

	// cookie 里的 state 与查询参数不符 → 拒绝(防跨站请求伪冒),不换令牌。
	req := httptest.NewRequest(http.MethodGet, "/callback?code=code-ok&state=evil", nil)
	req.AddCookie(&http.Cookie{Name: stateCookie, Value: "st-1"})
	w := httptest.NewRecorder()
	res.Routes().ServeHTTP(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("错 state 应 502,得到 %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "state") {
		t.Fatalf("错误页应说明 state 校验失败: %s", w.Body.String())
	}
	if len(fc.exchangeReqs) != 0 {
		t.Fatal("state 校验失败不应发起换令牌请求")
	}
	if len(store.sessions()) != 0 {
		t.Fatal("state 校验失败不应签发会话")
	}

	// 缺 state cookie 同样拒绝。
	req2 := httptest.NewRequest(http.MethodGet, "/callback?code=code-ok&state=st-1", nil)
	w2 := httptest.NewRecorder()
	res.Routes().ServeHTTP(w2, req2)
	if w2.Code != http.StatusBadGateway {
		t.Fatalf("缺 state cookie 应 502,得到 %d", w2.Code)
	}
}

func TestSSODevEmailBackdoor(t *testing.T) {
	store := &recordingStore{}
	res := NewSSO(SSOConfig{DevEmail: "dev@example.com", Sessions: store}).(*ssoResolver)

	// DevEmail 非空:/login 不跳 Casdoor,直接为该邮箱签发会话。
	req := httptest.NewRequest(http.MethodGet, "/login", nil)
	w := httptest.NewRecorder()
	res.Routes().ServeHTTP(w, req)

	if w.Code != http.StatusFound || w.Header().Get("Location") != "/" {
		t.Fatalf("开发后门应 302 跳首页,得到 %d %q", w.Code, w.Header().Get("Location"))
	}
	sessions := store.sessions()
	if len(sessions) != 1 {
		t.Fatalf("应签发恰好一条会话,得到 %d", len(sessions))
	}
	u := sessions[0].User
	if u.Email != "dev@example.com" || u.UID != "dev-"+hash16("dev@example.com") {
		t.Fatalf("开发后门用户不符: %+v", u)
	}
}

func TestSSOMeUnauthorizedIsJSON(t *testing.T) {
	res := NewSSO(SSOConfig{Sessions: &recordingStore{}}).(*ssoResolver)

	// 未登录 /me:401 + JSON 体 + 正确 Content-Type(回归:http.Error 会
	// 写 text/plain,前端按 JSON 解析失败)。
	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	w := httptest.NewRecorder()
	res.Routes().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("未登录应 401,得到 %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("Content-Type 应为 application/json,得到 %q", ct)
	}
	if !strings.Contains(w.Body.String(), `"unauthorized"`) {
		t.Fatalf("应答体应为 JSON 错误结构: %s", w.Body.String())
	}
}
