// Package identity — 多用户网关的用户身份解析。三种模式:
//   - single:单用户(本地联调;所有人共享一个 gh server)
//   - header:信任上级网关注入的请求头(被三方集成时的推荐方式,
//     SSO 登录由三方完成,本服务只认转发头)
//   - sso:内置 Casdoor OAuth2 授权码登录(独立部署时的完整方案,
//     参考 game-web 的实现,独立、无数据库依赖)
//
// 职责边界:本包只负责"把一个 HTTP 请求映射到一个稳定 uid";用户体系、
// 登录页 UI、权限管理等由部署方/集成方自理。
package identity

import (
	"errors"
	"net/http"
)

// User 解析出的用户身份。UID 是 gh server 进程与数据目录的隔离键,
// 必须稳定且对同一用户唯一。
type User struct {
	UID    string `json:"uid"`
	Name   string `json:"name,omitempty"`
	Email  string `json:"email,omitempty"`
	Admin  bool   `json:"admin,omitempty"`
}

// ErrUnauthorized 请求未通过身份解析(应答 401)。
var ErrUnauthorized = errors.New("unauthorized")

// Resolver 把请求映射到用户。
type Resolver interface {
	// Resolve 解析用户;未认证返回 ErrUnauthorized。
	Resolve(r *http.Request) (User, error)
	// LoginURL 未认证时前端应前往的登录入口(相对 API 前缀,如
	// /auth/login);无独立登录流程(single/header 模式)返回空。
	LoginURL() string
	// Routes 登录流程需要的额外路由(sso 模式的 /auth/*);挂载在
	// <prefix>/auth/ 之下;无则返回 nil。
	Routes() http.Handler
}
