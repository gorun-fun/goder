//go:build !windows

// relaunch_other.go — 接力等待的平台原语(类 Unix):轮询 signal 0 探测
// pid 存活性(不投递信号,仅探测存在/权限),ESRCH = 已退出。
package main

import (
	"syscall"
	"time"
)

// waitProcessExit 轮询等待 pid 退出或超时;成功或 EPERM(进程仍在,只是
// 非同 uid)都视为存活继续等。
func waitProcessExit(pid int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
