// console.go — ConsoleMCP 服务:goder-console 智能体控制面的装配与
// 生命周期。进程内起仅绑 127.0.0.1 的 MCP 服务(浏览器/终端/界面工具),
// 并把 shim 接入 gh(自动发现模式的 wrapper + 显式列表模式的 settings
// upsert,见 plugins/console/register.go)。失败只降级(日志告警),
// 不阻断 app 启动。
package desktop

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"

	"git.gorun.fun/share/goder/internal/appcfg"
	"git.gorun.fun/share/goder/internal/browser"
	"git.gorun.fun/share/goder/plugins/console"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ConsoleMCP wails 服务。全局单例。
type ConsoleMCP struct {
	ln  net.Listener
	srv *console.Server
}

var consoleMCPService = &ConsoleMCP{}

// GetConsoleMCP 取全局 ConsoleMCP。
func GetConsoleMCP() *ConsoleMCP { return consoleMCPService }

// ServiceStartup wails 启动钩子:加载/生成端口令牌 → 起监听 → 装配工具
// 面 → 异步接入 gh。须注册在 BrowserManager 之后(依赖其 Manager 就绪)。
func (c *ConsoleMCP) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	dir, err := appcfg.DefaultDir()
	if err != nil {
		log.Printf("[goder-console] 配置目录不可用,智能体控制面关闭")
		return nil
	}
	cfg := console.LoadConfig(dir)
	ln, listenCfg, err := console.Listen(cfg)
	if err != nil {
		log.Printf("[goder-console] loopback 监听失败,智能体控制面关闭: %v", err)
		return nil
	}
	c.ln = ln
	// 总是落盘:首启要把生成的令牌持久化(否则重启即轮换,已被本进程
	// 收养的 gh 带旧令牌失联);端口被占换新也在此回写。
	if err := console.SaveConfig(dir, listenCfg); err != nil {
		log.Printf("[goder-console] 配置落盘失败: %v", err)
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/mcp", listenCfg.Port)
	// Windows 浏览器求值回报通道(macOS 原生回调,不用此路径,设着无害)
	browser.SetReportBase(fmt.Sprintf("http://127.0.0.1:%d", listenCfg.Port))

	var bm console.BrowserAPI
	if m := GetBrowserManager().Manager(); m != nil {
		bm = m
	} else {
		bm = &unsupportedBrowser{}
	}
	c.srv = console.NewServer(console.Deps{
		Browser:  bm,
		Terminal: termAdapter{GetTerminalManager()},
		EmitUI: func(action string, params map[string]any) {
			application.Get().Event.Emit("goder:console-ui", map[string]any{"action": action, "params": params})
		},
		Version: appVersion,
	}, listenCfg.Token)
	go func() {
		if err := http.Serve(ln, c.srv.Handler()); err != nil && err != http.ErrServerClosed {
			log.Printf("[goder-console] 服务退出: %v", err)
		}
	}()
	// 接入 gh(wrapper/settings)在后台做:冷启动链路里 gh 晚于本服务,
	// 且安装失败只影响工具可用性,不该卡 UI。
	go func() {
		exe, err := os.Executable()
		if err != nil {
			return
		}
		if err := console.Install(exe,
			filepath.Join(grfHome(), "plugins"),
			grfSettingsPath(),
			endpoint, listenCfg.Token); err != nil {
			log.Printf("[goder-console] gh 接入安装失败(重启后会重试): %v", err)
		}
	}()
	return nil
}

// ServiceShutdown wails 退出钩子:关监听(shim 的在途请求随之失败,gh 会
// 把插件标记失联;下次启动 wrapper 里是新端点,gh 重启即恢复)。
func (c *ConsoleMCP) ServiceShutdown() error {
	if c.ln != nil {
		_ = c.ln.Close()
	}
	return nil
}

// ReportUIState 前端上报界面状态(原始 JSON 字符串;goder_ui_state 工具
// 原样透出)。纯 web/嵌入态前端不会调用。
func (c *ConsoleMCP) ReportUIState(state string) {
	if c.srv != nil {
		c.srv.SetUIState(state)
	}
}

// termAdapter TerminalManager → console.TerminalAPI(DTO 转换)。
type termAdapter struct{ t *TerminalManager }

func (a termAdapter) NewTerm(cwd string) (string, error) {
	dto, err := a.t.StartTerm(cwd, 80, 24)
	if err != nil {
		return "", err
	}
	return dto.ID, nil
}

func (a termAdapter) ListTerms() []console.TermInfo {
	list := a.t.ListTerm()
	out := make([]console.TermInfo, 0, len(list))
	for _, it := range list {
		out = append(out, console.TermInfo{ID: it.ID, Cwd: it.Cwd, Alive: it.Alive})
	}
	return out
}

func (a termAdapter) WriteTerm(id, text string) error { return a.t.WriteTerm(id, text) }

func (a termAdapter) ReadTerm(id string, from int64) (console.TermRead, error) {
	dto, err := a.t.ReadTerm(id, from)
	if err != nil {
		return console.TermRead{}, err
	}
	data, err := base64.StdEncoding.DecodeString(dto.Data)
	if err != nil {
		return console.TermRead{}, err
	}
	return console.TermRead{From: dto.From, To: dto.To, Data: data}, nil
}

func (a termAdapter) KillTerm(id string) error { return a.t.KillTerm(id) }

// unsupportedBrowser 浏览器管理器未就绪时的兜底(工具调用返回明确错误)。
type unsupportedBrowser struct{}

func (unsupportedBrowser) Navigate(string) bool                { return false }
func (unsupportedBrowser) Eval(string) (string, error)         { return "", browser.ErrUnsupported }
func (unsupportedBrowser) SnapshotPNG() ([]byte, error)        { return nil, browser.ErrUnsupported }
func (unsupportedBrowser) Back()                               {}
func (unsupportedBrowser) Forward()                            {}
func (unsupportedBrowser) Reload()                             {}
