//go:build windows

// relaunch_windows.go — 接力等待的平台原语(Windows):OpenProcess 取同步
// 句柄,WaitForSingleObject 等内核对象受信(进程终止即受信),不空转。
package main

import (
	"time"

	"golang.org/x/sys/windows"
)

// waitProcessExit 阻塞等待 pid 退出或超时;进程已退出/无法打开(权限或
// pid 已被回收)时立即返回。
func waitProcessExit(pid int, timeout time.Duration) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	_, _ = windows.WaitForSingleObject(h, uint32(timeout.Milliseconds()))
}
