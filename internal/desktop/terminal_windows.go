//go:build windows

// terminal_windows.go — Windows 存根:creack/pty 不支持 Windows,内嵌终端
// 暂不可用(方法保留与 bridge 的对齐形状,调用即报错)。
package desktop

import "fmt"

// TermSessionDTO 与前端 host/bridge.ts 的 TermSessionDTO 对齐。
type TermSessionDTO struct {
	ID string `json:"id"`
}

// TerminalManager wails 服务(Windows 存根)。
type TerminalManager struct{}

var terminalManager = &TerminalManager{}

// GetTerminalManager 取全局 TerminalManager。
func GetTerminalManager() *TerminalManager { return terminalManager }

// ServiceShutdown wails 退出钩子(无会话可回收)。
func (t *TerminalManager) ServiceShutdown() {}

// StartTerm Windows 暂不支持 PTY。
func (t *TerminalManager) StartTerm(cwd string, cols int, rows int) (TermSessionDTO, error) {
	return TermSessionDTO{}, fmt.Errorf("Windows 暂不支持内嵌终端")
}

// WriteTerm Windows 暂不支持 PTY。
func (t *TerminalManager) WriteTerm(id string, data string) error {
	return fmt.Errorf("Windows 暂不支持内嵌终端")
}

// ResizeTerm Windows 暂不支持 PTY。
func (t *TerminalManager) ResizeTerm(id string, cols int, rows int) error {
	return fmt.Errorf("Windows 暂不支持内嵌终端")
}

// KillTerm Windows 暂不支持 PTY。
func (t *TerminalManager) KillTerm(id string) error {
	return fmt.Errorf("Windows 暂不支持内嵌终端")
}
