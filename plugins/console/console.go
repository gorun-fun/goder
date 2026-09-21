// Package console — goder-console:把 goder 桌面壳的能力(右栏内嵌
// 浏览器面板、终端面板、界面操作)以 MCP 工具面暴露给 gh(grf-harness)
// 的智能体,用于「智能体可见地调试」:agent 在用户看得见的面板浏览器里
// 打开页面、点击、读 console/网络,在终端面板里跑命令,用户全程可围观
// 与接管。浏览器面板与用户共享同一份持久登录态(WKWebsiteDataStore /
// WebView2 profile),这是相对 grf-browser 插件(独立 Chrome、临时
// profile)的核心差异。
//
// 形态:本包在桌面进程内起一个仅绑 127.0.0.1 的 HTTP 服务,说 MCP 的
// JSON-RPC 子集(与 gh mcp 包的客户端严格兼容:单 POST 单应答)。gh 侧
// 经 ~/.grf/plugins/goder-console 适配器接入:一个转接 shim(本程序
// 自身以 `goder console-shim <endpoint> <token>` 子命令运行,行分隔
// JSON-RPC on stdio → HTTP POST),stdio 模式让 gh 的插件自动发现直接
// 收编,不破坏「settings.json 无 plugins 键 = 自动发现」语义(写 URL
// 条目会把 gh 切到显式列表模式,故不走那条路)。显式列表模式下安装器
// 会把 shim 命令项 upsert 进 plugins 数组。
//
// 工具命名 goder_ 前缀,避免与 grf-browser 插件的 browser_* 撞名。
package console

import "sync"

// Server goder-console 的 MCP 服务端(协议层 + 工具面)。
type Server struct {
	deps   Deps
	token  string
	tools  []Tool
	byName map[string]*Tool

	// bmu 浏览器工具串行化:面板只有一块 webview,同一页面的求值/操作
	// 不允许并发交叉(与 gh grf-browser 插件的 b.lock() 同理)。
	bmu sync.Mutex

	uiMu    sync.Mutex
	uiState string // 前端最近上报的界面状态 JSON(原始字符串)
}

// Deps 桌面壳注入的实现面。
type Deps struct {
	// Browser 右栏面板浏览器的控制面(internal/browser.Manager 满足)。
	Browser BrowserAPI
	// Terminal 终端会话管理(internal/desktop.TerminalManager 经适配器满足)。
	Terminal TerminalAPI
	// EmitUI 向前端下发界面操作事件(wails Event.Emit 的薄封装)。
	EmitUI func(action string, params map[string]any)
	// Version 服务端版本(initialize 握手自述用)。
	Version string
}

// BrowserAPI 面板浏览器控制面(internal/browser.Manager 直接满足)。
type BrowserAPI interface {
	Navigate(url string) bool
	Eval(js string) (string, error) // 返回 eval.go 定义的"信封"JSON 字符串
	SnapshotPNG() ([]byte, error)
	Back()
	Forward()
	Reload()
}

// TermInfo 终端会话摘要。
type TermInfo struct {
	ID    string
	Cwd   string
	Alive bool
}

// TermRead 终端输出增量读取结果(Data 为解码后的原始字节)。
type TermRead struct {
	From int64
	To   int64
	Data []byte
}

// TerminalAPI 终端会话管理面。
type TerminalAPI interface {
	NewTerm(cwd string) (string, error)
	ListTerms() []TermInfo
	WriteTerm(id, text string) error
	ReadTerm(id string, from int64) (TermRead, error)
	KillTerm(id string) error
}

// NewServer 构建服务端并注册全部工具。
func NewServer(deps Deps, token string) *Server {
	s := &Server{deps: deps, token: token, byName: map[string]*Tool{}}
	s.registerBrowserTools()
	s.registerTerminalTools()
	s.registerUITools()
	for i := range s.tools {
		s.byName[s.tools[i].Name] = &s.tools[i]
	}
	return s
}

// add 注册工具(register*Tools 内部用)。
func (s *Server) add(t Tool) { s.tools = append(s.tools, t) }

// SetUIState 前端上报界面状态(原始 JSON 字符串,原样透出给智能体)。
func (s *Server) SetUIState(state string) {
	s.uiMu.Lock()
	s.uiState = state
	s.uiMu.Unlock()
}

// UIState 最近一次界面状态上报(空串 = 尚未上报)。
func (s *Server) UIState() string {
	s.uiMu.Lock()
	defer s.uiMu.Unlock()
	return s.uiState
}

// emitUI 下发界面事件(EmitUI 缺失时静默)。
func (s *Server) emitUI(action string, params map[string]any) {
	if s.deps.EmitUI == nil {
		return
	}
	s.deps.EmitUI(action, params)
}
