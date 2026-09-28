// errors.go — ghserver 的类型化错误:网关按类型映射 HTTP 状态码
// (502 上游不可达 / 503 进程未就绪或冷却 / 429 容量上限),不再一律
// 502 拼字符串 —— 调用方(网关/桌面/运维端点)可程序化区分处置。
package ghserver

import (
	"errors"
	"fmt"
)

var (
	// ErrPortExhausted 端口池耗尽(容量上限,映射 503)。
	ErrPortExhausted = errors.New("端口池耗尽")
	// ErrTooManyUsers 托管用户进程数达上限(映射 429)。
	ErrTooManyUsers = errors.New("托管用户进程已达上限")
	// ErrStartCooling 崩溃重启处于冷却窗口(防 spawn 风暴,映射 503)。
	ErrStartCooling = errors.New("gh server 启动冷却中(近期连续启动失败)")
)

// StartError 进程启动失败(携带最后一次的错误明细,映射 503)。
type StartError struct {
	LastError string
}

func (e *StartError) Error() string { return "gh server 启动失败: " + e.LastError }

// tooManyUsersError 携带上限值的包装。
type tooManyUsersError struct{ max int }

func (e *tooManyUsersError) Error() string {
	return fmt.Sprintf("托管用户进程已达上限(%d)", e.max)
}

func (e *tooManyUsersError) Is(target error) bool { return target == ErrTooManyUsers }

// portExhaustedError 携带端口区间的包装。
type portExhaustedError struct{ min, max int }

func (e *portExhaustedError) Error() string {
	return fmt.Sprintf("端口池耗尽(%d-%d)", e.min, e.max)
}

func (e *portExhaustedError) Is(target error) bool { return target == ErrPortExhausted }
