//go:build windows

// pty_windows.go — Windows 平台的 PTY 本体:ConPTY(UserExistsError/
// conpty,Windows 10 1809+ 内核伪终端 API;creack/pty 不支持 Windows)。
// 类 Unix 对应实现见 pty_unix.go。
package desktop

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/UserExistsError/conpty"
)

// conPty 包装 conpty.ConPty 以满足 termPty。
type conPty struct {
	c *conpty.ConPty
}

func (w *conPty) Read(p []byte) (int, error)  { return w.c.Read(p) }
func (w *conPty) Write(p []byte) (int, error) { return w.c.Write(p) }

// Resize 随窗口大小通知前台控制台进程。
func (w *conPty) Resize(cols, rows uint16) error {
	return w.c.Resize(int(cols), int(rows))
}

// Terminate 关闭 ConPTY(ClosePseudoConsole 会终止附属进程)。
func (w *conPty) Terminate() error {
	return w.c.Close()
}

// startPty 启动交互 shell(pwsh → powershell → COMSPEC)的 ConPTY 会话;
// wait 返回退出码(进程退出后调用)。
func startPty(cwd string, cols, rows int) (termPty, func() int, error) {
	// CreateProcess 命令行原样解析,路径含空格必须加引号。
	c, err := conpty.Start(`"`+windowsShell()+`"`,
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(cwd),
		conpty.ConPtyEnv(os.Environ()),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("启动 ConPTY 失败:%w", err)
	}
	wait := func() int {
		code, _ := c.Wait(context.Background())
		return int(code)
	}
	return &conPty{c: c}, wait, nil
}

// windowsShell 选默认交互 shell:pwsh → powershell → COMSPEC(cmd)。
func windowsShell() string {
	for _, s := range []string{"pwsh.exe", "powershell.exe"} {
		if p, err := exec.LookPath(s); err == nil {
			return p
		}
	}
	if cs := os.Getenv("COMSPEC"); cs != "" {
		return cs
	}
	return "cmd.exe"
}
