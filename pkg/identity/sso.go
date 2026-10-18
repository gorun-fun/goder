// sso.go — 内置 Casdoor OAuth2 授权码登录(独立部署方案)。流程参考
// game-web:登录跳 Casdoor,回调换 access_token 取用户信息,本地签发
// 不透明随机会话令牌经 HttpOnly cookie 传递。无数据库依赖:默认内存
// 会话表,持久化实现见 file_sessions.go(GODER_SESSIONS_FILE 接线;单实例
// 定位,分布式需自换 SessionStore)。
package identity

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// SSOConfig Casdoor 登录配置(环境变量含义见 cmd/goder-serve)。
type SSOConfig struct {
	Endpoint     string // Casdoor 根地址,如 https://sso.example.com
	ClientID     string
	ClientSecret string
	RedirectURL  string // 回调地址,如 https://app.example.com/goder-api/auth/callback
	Organization string // Casdoor 组织(展示/文档用,userinfo 不依赖)
	// DevEmail 非空 = 开发后门:/auth/login 不跳 SSO 直接为该邮箱签发会话。
	// 仅供本地联调,生产必须留空。
	DevEmail string
	// CookieSecure 强制 Secure 标记(TLS 卸载部署时显式开启)。
	CookieSecure bool
	// SessionTTL 会话有效期,默认 30 天。
	SessionTTL time.Duration
	// Sessions 自定义会话存储(默认内存表)。
	Sessions SessionStore
}

// 会话 cookie 名(state 防跨站请求伪冒)。
const (
	sessionCookie = "goder_session"
	stateCookie   = "goder_sso_state"
)

// Session 一条本地会话。
type Session struct {
	Token   string
	User    User
	Expires time.Time
}

// SessionStore 会话存取(预留给数据库/Redis 等实现)。
type SessionStore interface {
	Get(token string) (Session, bool)
	Put(s Session)
	Del(token string)
}

// memSessions 内存会话表(重启即失效)。
type memSessions struct {
	mu sync.Mutex
	m  map[string]Session
}

func (m *memSessions) Get(token string) (Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.m[token]
	if !ok || time.Now().After(s.Expires) {
		return Session{}, false
	}
	return s, true
}

func (m *memSessions) Put(s Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.m == nil {
		m.m = map[string]Session{}
	}
	m.m[s.Token] = s
	// 顺手清过期项,防长期运行膨胀。
	now := time.Now()
	for t, x := range m.m {
		if now.After(x.Expires) {
			delete(m.m, t)
		}
	}
}

func (m *memSessions) Del(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.m, token)
}

// NewSSO Casdoor 登录 Resolver。
func NewSSO(cfg SSOConfig) Resolver {
	if cfg.SessionTTL <= 0 {
		cfg.SessionTTL = 30 * 24 * time.Hour
	}
	if cfg.Sessions == nil {
		cfg.Sessions = &memSessions{}
	}
	return &ssoResolver{cfg: cfg}
}

type ssoResolver struct {
	cfg SSOConfig
}

// ---------- Resolver 实现 ----------

func (s *ssoResolver) Resolve(r *http.Request) (User, error) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return User{}, ErrUnauthorized
	}
	sess, ok := s.cfg.Sessions.Get(c.Value)
	if !ok {
		return User{}, ErrUnauthorized
	}
	return sess.User, nil
}

func (s *ssoResolver) LoginURL() string { return "/auth/login" }

func (s *ssoResolver) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/login", s.hLogin)
	mux.HandleFunc("/callback", s.hCallback)
	mux.HandleFunc("/logout", s.hLogout)
	mux.HandleFunc("/me", s.hMe)
	return mux
}

// ---------- 端点 ----------

// hLogin 跳 Casdoor 授权页(开发后门:直接为 DevEmail 签发会话)。
func (s *ssoResolver) hLogin(w http.ResponseWriter, r *http.Request) {
	if s.cfg.DevEmail != "" {
		uid := "dev-" + hash16(s.cfg.DevEmail)
		s.issueSession(w, User{UID: uid, Email: s.cfg.DevEmail, Name: s.cfg.DevEmail})
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	state := randomToken(16)
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookie,
		Value:    state,
		Path:     "/",
		MaxAge:   600,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   s.cfg.CookieSecure,
	})
	q := url.Values{
		"client_id":     {s.cfg.ClientID},
		"response_type": {"code"},
		"redirect_uri":  {s.cfg.RedirectURL},
		"scope":         {"read"},
		"state":         {state},
	}
	http.Redirect(w, r, s.cfg.Endpoint+"/login/oauth/authorize?"+q.Encode(), http.StatusFound)
}

// hCallback 授权码换用户信息并签发本地会话。
func (s *ssoResolver) hCallback(w http.ResponseWriter, r *http.Request) {
	fail := func(msg string) {
		// 回应用一个明确错误页而非 500:便于运维从浏览器直接看到原因。
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, "sso callback 失败: %s\n", msg)
	}
	// state 校验(一次性,校验即清)。
	sc, err := r.Cookie(stateCookie)
	if err != nil || sc.Value == "" || sc.Value != r.URL.Query().Get("state") {
		fail("state 校验失败")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: stateCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})

	code := r.URL.Query().Get("code")
	if code == "" {
		fail("缺少 code")
		return
	}
	accessToken, err := s.exchange(code)
	if err != nil {
		fail(err.Error())
		return
	}
	u, err := s.userinfo(accessToken)
	if err != nil {
		fail(err.Error())
		return
	}
	s.issueSession(w, u)
	http.Redirect(w, r, "/", http.StatusFound)
}

// hLogout 本地登出(销毁本地会话;Casdoor 侧会话保留,同 game-web)。
func (s *ssoResolver) hLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		s.cfg.Sessions.Del(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// hMe 当前用户(JSON;未登录 401)。
func (s *ssoResolver) hMe(w http.ResponseWriter, r *http.Request) {
	u, err := s.Resolve(r)
	if err != nil {
		// 与 pkg/gateway 的 unauthorized 应答同风格:JSON 体 + 正确的
		// Content-Type(http.Error 会写 text/plain,前端按 JSON 解析即失败)。
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"未登录或会话已过期","type":"unauthorized"}}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(u)
}

// ---------- Casdoor 对接 ----------

// casdoorHTTP 与 Casdoor 的全部出站请求共用:带超时,防上游挂起时把
// 回调请求(乃至网关协程)无限期占死。http.DefaultClient 无超时,禁用。
var casdoorHTTP = &http.Client{Timeout: 10 * time.Second}

// exchange 授权码换 access_token。
func (s *ssoResolver) exchange(code string) (string, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {s.cfg.ClientID},
		"client_secret": {s.cfg.ClientSecret},
		"code":          {code},
		"redirect_uri":  {s.cfg.RedirectURL},
	}
	req, err := http.NewRequest(http.MethodPost, s.cfg.Endpoint+"/api/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := casdoorHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("access_token HTTP %d", resp.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return "", fmt.Errorf("access_token 响应异常")
	}
	return out.AccessToken, nil
}

// userinfo 取用户信息(uid = Casdoor 用户 UUID,空则 sub)。
func (s *ssoResolver) userinfo(accessToken string) (User, error) {
	req, err := http.NewRequest(http.MethodGet, s.cfg.Endpoint+"/api/userinfo", nil)
	if err != nil {
		return User{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := casdoorHTTP.Do(req)
	if err != nil {
		return User{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return User{}, fmt.Errorf("userinfo HTTP %d", resp.StatusCode)
	}
	var info struct {
		Sub   string `json:"sub"`
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return User{}, err
	}
	uid := info.ID
	if uid == "" {
		uid = info.Sub
	}
	if uid == "" {
		return User{}, fmt.Errorf("userinfo 缺少用户标识")
	}
	return User{UID: uid, Name: info.Name, Email: info.Email}, nil
}

// ---------- 会话签发 ----------

func (s *ssoResolver) issueSession(w http.ResponseWriter, u User) {
	sess := Session{Token: randomToken(32), User: u, Expires: time.Now().Add(s.cfg.SessionTTL)}
	s.cfg.Sessions.Put(sess)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sess.Token,
		Path:     "/",
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   s.cfg.CookieSecure,
	})
}

// ---------- 工具 ----------

// randomToken n 字节加密随机数的 hex 串。
func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// hash16 字符串 sha256 前 16 个 hex 字符(开发后门 uid)。
func hash16(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}
