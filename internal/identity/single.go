// single.go — 单用户模式:所有请求映射到同一 uid(本地联调用)。
package identity

import "net/http"

// SingleConfig 单用户模式参数。
type SingleConfig struct {
	UID  string // 固定用户 id,默认 "local"
	Name string // 展示名,可选
}

// NewSingle 单用户 Resolver。
func NewSingle(cfg SingleConfig) Resolver {
	if cfg.UID == "" {
		cfg.UID = "local"
	}
	return &singleResolver{cfg: cfg}
}

type singleResolver struct {
	cfg SingleConfig
}

func (s *singleResolver) Resolve(*http.Request) (User, error) {
	return User{UID: s.cfg.UID, Name: s.cfg.Name}, nil
}

func (s *singleResolver) LoginURL() string     { return "" }
func (s *singleResolver) Routes() http.Handler { return nil }
