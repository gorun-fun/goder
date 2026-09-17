// hideconsole_windows.go — Windows 下隐藏控制台子进程的窗口。
//
// goder.exe 是 GUI 子系统程序(自身无控制台):凡 exec.Command 启动控制台
// 子系统程序(git 等),Windows 都会为它新开一个 cmd 窗口。统一经
// hideConsole 附加 CREATE_NO_WINDOW。ghserver 包内 gh/taskkill 的同款处理
// 见 internal/ghserver/proc_windows.go。
//go:build windows

package desktop

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// hideConsole 给控制台子进程附加"不新建控制台窗口"标志。
func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
