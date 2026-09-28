// header.go — 信任上级网关的模式:从指定请求头取用户 id。适用于"三方
// 应用已完成自己的 SSO,由其后端把 /goder-api 反代到本网关并注入用户头"
// 的被集成场景。网关必须只接受来自可信反代的流量(部署约束,见
// docs/embedding.md 的安全说明)。
package identity

import (
	"net/http"
	"strings"
)

// HeaderConfig 信任头模式参数。
type HeaderConfig struct {
	UIDHeader  string // 用户 id 头,默认 X-GRF-UID
	NameHeader string // 展示名头,可选,默认 X-GRF-Name
}

// NewHeader 信任头 Resolver。
func NewHeader(cfg HeaderConfig) Resolver {
	if cfg.UIDHeader == "" {
		cfg.UIDHeader = "X-GRF-UID"
	}
	if cfg.NameHeader == "" {
		cfg.NameHeader = "X-GRF-Name"
	}
	return &headerResolver{cfg: cfg}
}

type headerResolver struct {
	cfg HeaderConfig
}

func (h *headerResolver) Resolve(r *http.Request) (User, error) {
	uid := strings.TrimSpace(r.Header.Get(h.cfg.UIDHeader))
	if uid == "" {
		return User{}, ErrUnauthorized
	}
	return User{UID: uid, Name: strings.TrimSpace(r.Header.Get(h.cfg.NameHeader))}, nil
}

func (h *headerResolver) LoginURL() string     { return "" }
func (h *headerResolver) Routes() http.Handler { return nil }
