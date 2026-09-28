// proc_windows.go — ghserver 进程管理的 Windows 实现:
// 进程树回收用 taskkill /T;看门狗用 Job 对象(KILL_ON_JOB_CLOSE):
// gh 进程入 Job,宿主(持有 Job 句柄)无论如何退出 —— 崩溃/被杀/正常
// 结束 —— 内核关闭句柄时自动结束 Job 内全部进程,不留孤儿 gh server。
// Unix 对应实现见 proc_unix.go(sh 管道 EOF 看门狗)。
//go:build windows

package ghserver

import (
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// jobHandles pid → Job 对象句柄(宿主异常退出时内核关闭全部句柄,Job
// 内进程随之被杀 —— 这就是看门狗本体;正常停止路径在 killProcTree 后
// 主动释放)。
var jobHandles sync.Map

// childProcAttr Windows 下无进程组;整树回收交给 taskkill /T。gh.exe 是
// 控制台子系统程序而宿主 goder.exe 是 GUI 程序(自身无控制台):不加固
// 定标志,Windows 会为 gh 新开一个 cmd 窗口。CREATE_NO_WINDOW + 重定向
// stdout/stderr 后 gh 完全静默运行。
func childProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

// startWatchdog 把 gh 进程放入自灭 Job:宿主持有句柄,宿主一退出(含
// 崩溃)内核即结束 Job 内进程。失败静默 —— 下次启动的 probeAdopt 收养
// 仍是兜底。
func (p *Proc) startWatchdog(pid int, group bool) {
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(job)
		return
	}
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		windows.CloseHandle(job)
		return
	}
	jobHandles.Store(pid, job)
}

// releaseJob 释放某 pid 的 Job 句柄(正常停止路径;进程已被 taskkill
// 结束,仅回收内核对象)。
func releaseJob(pid int) {
	if v, ok := jobHandles.LoadAndDelete(pid); ok {
		_ = windows.CloseHandle(v.(windows.Handle))
	}
}

// killProcTree 回收 gh 进程树:taskkill /T 连同子进程一起结束。Windows 无
// SIGTERM 优雅信号,直接强杀(会话落盘窗口由 gh 自身的退出处理决定)。
// taskkill 同为控制台程序,同样要 CREATE_NO_WINDOW,否则退出时闪 cmd。
func killProcTree(pid int, group bool) {
	releaseJob(pid)
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
