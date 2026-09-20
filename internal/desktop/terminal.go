// terminal.go — TerminalManager 服务:内嵌交互终端(三平台公共层)。
// 前端 grf-terminal 面板经 desktop.TerminalManager.* 调用;PTY 输出经 wails
// 事件 grf:term-data:<id>(base64)推回前端,退出推 grf:term-exit:<id>。
// 会话表、事件推送与生命周期回收都在这里;PTY 本体按平台实现(满足
// termPty 接口):类 Unix 用 creack/pty(pty_unix.go),Windows 用 ConPTY
// (pty_windows.go)。app 退出时回收全部会话。
package desktop

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// TermSessionDTO 与前端 host/bridge.ts 的 TermSessionDTO 对齐。
type TermSessionDTO struct {
	ID string `json:"id"`
}

// TermInfoDTO 终端会话摘要(goder_console 智能体工具用)。Alive=false
// 表示 shell 已退出,缓冲里的最终输出仍可读。
type TermInfoDTO struct {
	ID    string `json:"id"`
	Cwd   string `json:"cwd"`
	Alive bool   `json:"alive"`
}

// TermReadDTO 增量读取结果:Data 为 base64(与事件推送同编码),From/To
// 为输出流的绝对字节序号,调用方下次从 To 续读。
type TermReadDTO struct {
	From int64  `json:"from"`
	To   int64  `json:"to"`
	Data string `json:"data"`
}

// termBufCap 单会话输出环形缓冲上限(丢最旧)。
const termBufCap = 256 << 10

// termPty 平台 PTY 会话的最小接口,manager 只依赖这里。
type termPty interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows uint16) error
	// Terminate 终止会话并回收资源(类 Unix:杀进程 + 关 tty;Windows:
	// ClosePseudoConsole 连带终止附属进程)。会话已退出后调用须安全。
	Terminate() error
}

// termSession 一个终端会话:PTY 本体 + 退出码读取(进程退出后调用)
// + 输出环形缓冲(智能体读取用;前端 xterm 走事件推送不受影响)。
type termSession struct {
	pty  termPty
	wait func() int
	cwd  string
	// exited:shell 已退出(退出后缓冲保留,供智能体读最终输出)。
	exited bool
	// 输出环形缓冲:buf[start..wseq](绝对字节序号),丢最旧保 cap。
	bufMu  sync.Mutex
	buf    []byte
	start  int64
	wseq   int64
}

// appendBuf 追加输出到环形缓冲(读循环调用)。
func (s *termSession) appendBuf(p []byte) {
	s.bufMu.Lock()
	defer s.bufMu.Unlock()
	s.buf = append(s.buf, p...)
	s.wseq += int64(len(p))
	if over := len(s.buf) - termBufCap; over > 0 {
		s.buf = s.buf[over:]
		s.start += int64(over)
	}
}

// readFrom 读取自绝对序号 from 起的缓冲(from 早于缓冲起点时从起点读)。
func (s *termSession) readFrom(from int64) TermReadDTO {
	s.bufMu.Lock()
	defer s.bufMu.Unlock()
	if from < s.start {
		from = s.start
	}
	if from > s.wseq {
		from = s.wseq
	}
	data := []byte{}
	if from < s.wseq {
		data = append(data, s.buf[from-s.start:]...)
	}
	return TermReadDTO{From: from, To: s.wseq, Data: base64.StdEncoding.EncodeToString(data)}
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

// StartTerm 在 cwd 启动一个交互 shell 的 PTY 会话(shell 选型与启动方式
// 见平台 pty_*.go)。cwd 为空(未选工作区)时默认用户主目录:终端随时
// 可用,不强制先选项目。
func (t *TerminalManager) StartTerm(cwd string, cols int, rows int) (TermSessionDTO, error) {
	if cwd == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cwd = home
		}
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return TermSessionDTO{}, fmt.Errorf("工作目录不存在:%s", cwd)
	}
	p, wait, err := startPty(cwd, clampDim(cols, 10, 500), clampDim(rows, 4, 300))
	if err != nil {
		return TermSessionDTO{}, err
	}

	idBytes := make([]byte, 8)
	_, _ = rand.Read(idBytes)
	id := hex.EncodeToString(idBytes)

	t.mu.Lock()
	t.sessions[id] = &termSession{pty: p, wait: wait, cwd: cwd}
	t.mu.Unlock()

	// 读循环:输出 base64 后经 wails 事件推送(前端按字节喂 xterm,
	// 避免 UTF-8 多字节字符被 chunk 截断);EOF 后通知退出并回收。
	// 同一份输出另入环形缓冲,供智能体工具增量读取。
	// 分块 ≤4KB:wails 单事件负载超 ~8KB 会改经 /wails/eventpayload/
	// 端点取回,Windows 本地服务器形态没有该端点,事件会被静默丢弃。
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, readErr := p.Read(buf)
			if n > 0 {
				s := t.get(id)
				if s != nil {
					s.appendBuf(buf[:n])
				}
				for off := 0; off < n; off += 4096 {
					end := min(off+4096, n)
					application.Get().Event.Emit("grf:term-data:"+id, base64.StdEncoding.EncodeToString(buf[off:end]))
				}
			}
			if readErr != nil {
				break
			}
		}
		application.Get().Event.Emit("grf:term-exit:"+id, wait())
		t.mu.Lock()
		if s, ok := t.sessions[id]; ok {
			s.exited = true
			t.pruneExitedLocked()
		}
		t.mu.Unlock()
		_ = p.Terminate()
	}()

	return TermSessionDTO{ID: id}, nil
}

// ListTerm 列出全部会话(含刚退出、缓冲仍可读的)。
func (t *TerminalManager) ListTerm() []TermInfoDTO {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]TermInfoDTO, 0, len(t.sessions))
	for id, s := range t.sessions {
		out = append(out, TermInfoDTO{ID: id, Cwd: s.cwd, Alive: !s.exited})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ReadTerm 增量读取会话输出(from 传上次返回的 To;首次传 0,早于缓冲
// 起点时自动收敛到起点)。
func (t *TerminalManager) ReadTerm(id string, from int64) (TermReadDTO, error) {
	s := t.get(id)
	if s == nil {
		return TermReadDTO{}, fmt.Errorf("终端会话不存在")
	}
	return s.readFrom(from), nil
}

// termExitedKeep 已退出会话的保留个数(超出丢最旧,防缓冲无限累积)。
const termExitedKeep = 10

// pruneExitedLocked 清理过老的已退出会话(按创建即插入序,直接删最旧)。
func (t *TerminalManager) pruneExitedLocked() {
	exited := 0
	for id := range t.sessions {
		if t.sessions[id].exited {
			exited++
		}
	}
	for id, s := range t.sessions {
		if exited <= termExitedKeep {
			return
		}
		if s.exited {
			delete(t.sessions, id)
			exited--
		}
	}
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

// ResizeTerm 调整终端尺寸(内核/控制台随尺寸变化通知前台进程)。
func (t *TerminalManager) ResizeTerm(id string, cols int, rows int) error {
	s := t.get(id)
	if s == nil {
		return fmt.Errorf("终端会话不存在")
	}
	return s.pty.Resize(uint16(clampDim(cols, 10, 500)), uint16(clampDim(rows, 4, 300)))
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
	delete(t.sessions, id)
	return s.pty.Terminate()
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
