//go:build windows

// terminal_windows.go — TerminalManager 服务:内嵌交互终端(Windows ConPTY)。
// 前端 grf-terminal 面板经 desktop.TerminalManager.* 调用;PTY 输出经 wails
// 事件 grf:term-data:<id>(base64)推回前端,退出推 grf:term-exit:<id>。
// app 退出时回收全部会话。creack/pty 不支持 Windows,这里用 ConPTY
// (UserExistsError/conpty,Windows 10 1809+ 内核伪终端 API)。
package desktop

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/UserExistsError/conpty"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// TermSessionDTO 与前端 host/bridge.ts 的 TermSessionDTO 对齐。
type TermSessionDTO struct {
	ID string `json:"id"`
}

type termSession struct {
	pty *conpty.ConPty
}

// TerminalManager wails 服务。全局单例。
type TerminalManager struct {
	mu       sync.Mutex
	sessions map[string]*termSession
}

var terminalManager = &TerminalManager{sessions: map[string]*termSession{}}

// GetTerminalManager 取全局 TerminalManager。
func GetTerminalManager() *TerminalManager { return terminalManager }

// ServiceShutdown wails 退出钩子:回收全部终端会话。
func (t *TerminalManager) ServiceShutdown() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, s := range t.sessions {
		t.killLocked(id, s)
	}
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

// StartTerm 在 cwd 启动一个交互 shell 的 ConPTY 会话。cwd 为空(未选工作区)
// 时默认用户主目录:终端随时可用,不强制先选项目。
func (t *TerminalManager) StartTerm(cwd string, cols int, rows int) (TermSessionDTO, error) {
	if cwd == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cwd = home
		}
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return TermSessionDTO{}, fmt.Errorf("工作目录不存在:%s", cwd)
	}
	// CreateProcess 命令行原样解析,路径含空格必须加引号。
	commandLine := `"` + windowsShell() + `"`
	c, err := conpty.Start(commandLine,
		conpty.ConPtyDimensions(clampDim(cols, 10, 500), clampDim(rows, 4, 300)),
		conpty.ConPtyWorkDir(cwd),
		conpty.ConPtyEnv(os.Environ()),
	)
	if err != nil {
		return TermSessionDTO{}, fmt.Errorf("启动 ConPTY 失败:%w", err)
	}

	idBytes := make([]byte, 8)
	_, _ = rand.Read(idBytes)
	id := hex.EncodeToString(idBytes)

	t.mu.Lock()
	t.sessions[id] = &termSession{pty: c}
	t.mu.Unlock()

	// 读循环:输出 base64 后经 wails 事件推送(前端按字节喂 xterm,
	// 避免 UTF-8 多字节字符被 chunk 截断);EOF 后通知退出并回收。
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, readErr := c.Read(buf)
			if n > 0 {
				application.Get().Event.Emit("grf:term-data:"+id, base64.StdEncoding.EncodeToString(buf[:n]))
			}
			if readErr != nil {
				break
			}
		}
		code, _ := c.Wait(context.Background())
		application.Get().Event.Emit("grf:term-exit:"+id, int(code))
		t.mu.Lock()
		delete(t.sessions, id)
		t.mu.Unlock()
		_ = c.Close()
	}()

	return TermSessionDTO{ID: id}, nil
}

// WriteTerm 向会话写入键盘输入。
func (t *TerminalManager) WriteTerm(id string, data string) error {
	s := t.get(id)
	if s == nil {
		return fmt.Errorf("终端会话不存在")
	}
	_, err := s.pty.Write([]byte(data))
	return err
}

// ResizeTerm 调整终端尺寸(内核随窗口大小通知前台控制台进程)。
func (t *TerminalManager) ResizeTerm(id string, cols int, rows int) error {
	s := t.get(id)
	if s == nil {
		return fmt.Errorf("终端会话不存在")
	}
	return s.pty.Resize(clampDim(cols, 10, 500), clampDim(rows, 4, 300))
}

// KillTerm 终止会话(已退出视为成功)。
func (t *TerminalManager) KillTerm(id string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.sessions[id]
	if s == nil {
		return nil
	}
	return t.killLocked(id, s)
}

func (t *TerminalManager) get(id string) *termSession {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sessions[id]
}

// killLocked 关闭 ConPTY(ClosePseudoConsole 会终止附属进程)并回收句柄。
func (t *TerminalManager) killLocked(id string, s *termSession) error {
	delete(t.sessions, id)
	return s.pty.Close()
}

func clampDim(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
