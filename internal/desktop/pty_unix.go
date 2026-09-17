//go:build !windows

// pty_unix.go — 类 Unix(darwin/linux)平台的 PTY 本体:creack/pty 打开
// 伪终端,跑登录 shell($SHELL,缺省 /bin/bash)。Windows 对应实现见
// pty_windows.go。
package desktop

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// unixPty 包装 pty 打开的 *os.File,补齐 termPty 的 Resize/Terminate。
type unixPty struct {
	tty *os.File
	cmd *exec.Cmd
}

func (u *unixPty) Read(p []byte) (int, error)  { return u.tty.Read(p) }
func (u *unixPty) Write(p []byte) (int, error) { return u.tty.Write(p) }

// Resize 经 TIOCSWINSZ 生效,内核随尺寸向前台进程组发 SIGWINCH。
func (u *unixPty) Resize(cols, rows uint16) error {
	return pty.Setsize(u.tty, &pty.Winsize{Cols: cols, Rows: rows})
}

// Terminate 杀掉 shell 进程并关闭 tty(进程已退出时两步均无害)。
func (u *unixPty) Terminate() error {
	if u.cmd != nil && u.cmd.Process != nil {
		_ = u.cmd.Process.Kill()
	}
	return u.tty.Close()
}

// startPty 启动登录 shell 的 PTY 会话;wait 返回 shell 退出码(进程
// 退出后调用)。
func startPty(cwd string, cols, rows int) (termPty, func() int, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	cmd := exec.Command(shell, "-l")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	tty, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, nil, err
	}
	wait := func() int {
		if waitErr := cmd.Wait(); waitErr != nil {
			if exitErr, ok := waitErr.(*exec.ExitError); ok {
				return exitErr.ExitCode()
			}
		}
		return 0
	}
	return &unixPty{tty: tty, cmd: cmd}, wait, nil
}
