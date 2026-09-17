//go:build !windows

// terminal.go — TerminalManager 服务:内嵌交互终端(PTY)。
// 前端 grf-terminal 面板经 desktop.TerminalManager.* 调用;PTY 输出经 wails
// 事件 grf:term-data:<id>(base64)推回前端,退出推 grf:term-exit:<id>。
// app 退出时回收全部会话。
package desktop

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// TermSessionDTO 与前端 host/bridge.ts 的 TermSessionDTO 对齐。
type TermSessionDTO struct {
	ID string `json:"id"`
}

type termSession struct {
	tty *os.File
	cmd *exec.Cmd
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

// StartTerm 在 cwd 启动一个登录 shell 的 PTY 会话。cwd 为空(未选工作区)
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
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	cmd := exec.Command(shell, "-l")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	size := &pty.Winsize{Cols: uint16(clampDim(cols, 10, 500)), Rows: uint16(clampDim(rows, 4, 300))}
	tty, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return TermSessionDTO{}, err
	}

	idBytes := make([]byte, 8)
	_, _ = rand.Read(idBytes)
	id := hex.EncodeToString(idBytes)

	t.mu.Lock()
	t.sessions[id] = &termSession{tty: tty, cmd: cmd}
	t.mu.Unlock()

	// 读循环:输出 base64 后经 wails 事件推送(前端按字节喂 xterm,
	// 避免 UTF-8 多字节字符被 chunk 截断);EOF 后通知退出并回收。
	// 分块 ≤4KB:wails 单事件负载超 ~8KB 会改经 /wails/eventpayload/
	// 端点取回,Windows 本地服务器形态没有该端点,事件会被静默丢弃。
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, readErr := tty.Read(buf)
			for off := 0; off < n; off += 4096 {
				end := min(off+4096, n)
				application.Get().Event.Emit("grf:term-data:"+id, base64.StdEncoding.EncodeToString(buf[off:end]))
			}
			if readErr != nil {
				break
			}
		}
		code := 0
		if waitErr := cmd.Wait(); waitErr != nil {
			if exitErr, ok := waitErr.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			}
		}
		application.Get().Event.Emit("grf:term-exit:"+id, code)
		t.mu.Lock()
		delete(t.sessions, id)
		t.mu.Unlock()
		_ = tty.Close()
	}()

	return TermSessionDTO{ID: id}, nil
}

// WriteTerm 向会话写入键盘输入。
func (t *TerminalManager) WriteTerm(id string, data string) error {
	s := t.get(id)
	if s == nil {
		return fmt.Errorf("终端会话不存在")
	}
	_, err := s.tty.Write([]byte(data))
	return err
}

// ResizeTerm 调整终端尺寸(内核随 TIOCSWINSZ 向前台进程组发 SIGWINCH)。
func (t *TerminalManager) ResizeTerm(id string, cols int, rows int) error {
	s := t.get(id)
	if s == nil {
		return fmt.Errorf("终端会话不存在")
	}
	return pty.Setsize(s.tty, &pty.Winsize{Cols: uint16(clampDim(cols, 10, 500)), Rows: uint16(clampDim(rows, 4, 300))})
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

func (t *TerminalManager) killLocked(id string, s *termSession) error {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	delete(t.sessions, id)
	return s.tty.Close()
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
