// proc_windows.go — ghserver 进程管理的 Windows 实现:
// 进程树回收用 taskkill /T;看门狗暂缺(宿主崩溃残留的 gh 由下次启动的
// 收养机制兜底,后续可换 Job 对象 KILL_ON_JOB_CLOSE)。
// Unix 对应实现见 proc_unix.go。
//go:build windows

package ghserver

import (
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/windows"
)

// childProcAttr Windows 下无进程组;整树回收交给 taskkill /T。gh.exe 是
// 控制台子系统程序而宿主 goder.exe 是 GUI 程序(自身无控制台):不加固
// 定标志,Windows 会为 gh 新开一个 cmd 窗口。CREATE_NO_WINDOW + 重定向
// stdout/stderr 后 gh 完全静默运行。
func childProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

// startWatchdog Windows 暂无 /bin/sh 管道方案,不挂看门狗。宿主异常退出
// 残留的 gh server 由下次启动的 probeAdopt 收养(读其落盘 token 继续用)。
func (p *Proc) startWatchdog(pid int, group bool) {}

// killProcTree 回收 gh 进程树:taskkill /T 连同子进程一起结束。Windows 无
// SIGTERM 优雅信号,直接强杀(会话落盘窗口由 gh 自身的退出处理决定)。
// taskkill 同为控制台程序,同样要 CREATE_NO_WINDOW,否则退出时闪 cmd。
func killProcTree(pid int, group bool) {
	cmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	cmd.SysProcAttr = childProcAttr()
	_ = cmd.Run()
}

func alive(pid int) bool {
	// Windows 的 os.FindProcess 永远成功、Signal(0) 不支持,须真的打开进程。
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err == nil && code != 259 { // STILL_ACTIVE
		return false
	}
	return true
}
