// proc_unix.go — ghserver 进程管理的 Unix(darwin/linux)实现:
// 独立进程组 + SIGTERM/SIGKILL 整组回收 + sh 管道看门狗。
// Windows 对应实现见 proc_windows.go。
//go:build !windows

package ghserver

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// childProcAttr 子进程(gh server)用独立进程组,可整组回收。
func childProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// startWatchdog sh 阻塞读管道,宿主进程退出(正常退出/崩溃/被强杀,fd 全部
// 关闭)触发 EOF,按 pid/进程组回收 gh。
func (p *Proc) startWatchdog(pid int, group bool) {
	r, w, err := os.Pipe()
	if err != nil {
		return
	}
	target := fmt.Sprintf("-%d", pid) // 进程组(负 pid)
	if !group {
		target = fmt.Sprintf("%d", pid) // 收养实例:仅 pid,避免误伤其进程组邻居
	}
	script := fmt.Sprintf(
		"read x || true; kill -TERM %s 2>/dev/null; sleep 1; kill -KILL %s 2>/dev/null; exit 0",
		target, target)
	watch := exec.Command("/bin/sh", "-c", script)
	watch.Stdin = r
	// 独立进程组:不随 gh 或宿主的进程组回收牵连。
	watch.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := watch.Start(); err != nil {
		r.Close()
		w.Close()
		return
	}
	r.Close() // 读端已交给 sh,宿主侧只保留写端
	p.watch = watch
	p.watchW = w
}

// killProcTree 回收 gh 进程树。group=true 按进程组(负 pid)回收亲生子进程,
// false 仅按 pid 回收收养实例(进程组属于别人)。先 SIGTERM 给足优雅退出
// 时间(运行中会话落盘;过早 SIGKILL 会截断写盘、重开 App 后会话内容丢失),
// 3 秒内未退出再 SIGKILL,不让退出流程无限挂起。
func killProcTree(pid int, group bool) {
	target := pid
	if group {
		target = -pid
	}
	_ = syscall.Kill(target, syscall.SIGTERM)
	if waitExit(pid, 3*time.Second) {
		_ = syscall.Kill(target, syscall.SIGKILL)
	}
}

func alive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}
