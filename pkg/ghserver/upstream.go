// upstream.go — 「取用户进程 → 校验就绪 → 组装上游」的统一编排。
// 网关(internal/gateway)与桌面壳(internal/desktop)共用,消除两处
// 手写「Get → Status → url.Parse → Upstream」的重复;错误类型化见
// errors.go(调用方按类型映射 HTTP 状态或本地降级)。
package ghserver

import (
	"fmt"
	"net/url"
)

// UserUpstream 解析某用户当前应转发到的上游(懒启动该用户的 gh 进程,
// 注入进程令牌)。进程未就绪/启动失败时返回类型化错误。
func (m *Manager) UserUpstream(uid string) (Upstream, error) {
	proc, err := m.Get(uid)
	if err != nil {
		return Upstream{}, err
	}
	st := proc.Status()
	if !st.Running {
		return Upstream{}, &StartError{LastError: st.LastError}
	}
	target, err := url.Parse("http://" + st.Addr)
	if err != nil {
		return Upstream{}, fmt.Errorf("gh server 地址非法(%s): %w", st.Addr, err)
	}
	return Upstream{Target: target, Token: st.Token}, nil
}
