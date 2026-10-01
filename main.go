// goder — grf-harness(gh)的 ZCode 风格图形界面。
// 桌面形态:wails v3;同一前端亦产出可嵌入三方 web 的 web components。
// wails 服务薄壳(AppConfig/ServerManager/Desktop/ModelConfig/
// TerminalManager/Updater)与 /goder-api 反代在 internal/desktop。
package main

import (
	"embed"
	"log"
	"os"
	"runtime"

	"git.gorun.fun/share/goder/internal/desktop"
	"git.gorun.fun/share/goder/plugins/console"

	"github.com/wailsapp/wails/v3/pkg/application"
	wailsEvents "github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// 自更新接力:本进程是 applyGoder 拉起的新版本,先等旧进程完全退出
	// (Windows WebView2 数据目录锁与 console MCP 端口烙写都不容忍新旧
	// 并存,见 relaunch.go)再初始化。参数不存在时零开销。必须抢在一切
	// GUI 初始化之前。
	waitRelaunchParent(os.Args)
	// goder-console 的 stdio shim 子命令:gh 以本地 MCP 插件方式 spawn
	// 本程序(`goder console-shim <endpoint> <token>`),行 JSON-RPC 转
	// 发到桌面进程的 loopback /mcp。必须抢在一切 GUI 初始化之前分派。
	if len(os.Args) > 1 && os.Args[1] == "console-shim" {
		os.Exit(console.RunShim(os.Args[1:]))
	}
	// 无头测试形态:同一份应用经本地 HTTP 服务器暴露给浏览器(AI/发布版
	// E2E 用,见 testserve.go 与 docs/testing.md)。
	if len(os.Args) > 1 && os.Args[1] == "test-serve" {
		if err := runTestServe(os.Args[1:]); err != nil {
			log.Fatal(err)
		}
		return
	}

	sm := desktop.GetServerManager()

	// 环境检查门(三平台同一时点):gh 缺失时自动下载(Windows 弹原生
	// 对话框,macOS/Linux 静默),先完成(用户拒绝或失败也放行)才创建应用
	// 与主窗体("gh 下载以后才能打开主窗体")。只做检查/下载,不启动服务
	// —— gh 由主窗体启动时的冷启动拉起。macOS .app 正常捆绑 gh,此门
	// 立即通过;仅捆绑副本缺失时静默补齐(与 Linux 行为一致)。
	sm.EnsureGh()

	rootHandler := desktop.RootHandler(application.BundledAssetFileServer(assets))
	// 显式复用 wails 默认的 HTTP IPC transport(与不设置 Transport 时完全
	// 同一实现),以便把它的 /wails/runtime 处理器也挂进 Windows 本地
	// HTTP 服务器 —— 前端 runtime 的服务调用/事件走的是
	// fetch(origin + "/wails/runtime"),页面从本地服务器加载时该端点必须
	// 由本地服务器供应,否则一切 wails 调用(窗口控制/对话框/服务)404。
	transport := application.NewHTTPTransport()
	app := application.New(application.Options{
		Name:        "Goder",
		Description: "grf-harness 图形界面(项目会话 · 聊天 · 详情 · 事件台)",
		Services:    appServices(),
		Assets: application.AssetOptions{
			Handler: rootHandler,
			// 代理与静态资源都由我们接管,关掉逐请求日志噪音
			DisableLogging: true,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		Transport: transport,
	})

	winOpts := application.WebviewWindowOptions{
		Name:      "main",
		Title:     "Goder",
		URL:       "/",
		Width:     1240,
		Height:    820,
		MinWidth:  880,
		MinHeight: 560,
	}
	// 窗口装饰(三平台统一策略):macOS 隐藏原生标题栏、仅保留左上红绿灯
	// (关闭/最小化/最大化),内容铺满整窗;Windows/Linux 没有这种"去标题栏
	// 留红绿灯"的能力,只能整窗无边框,窗口控制由前端顶栏自绘(frontend 的
	// .winctl,见 host/winctl.ts),拖动/双击缩放走标题栏消息桥,边缘缩放由
	// wails runtime 的 drag 模块接管。Mac 字段在非 macOS 平台被 wails 忽略,
	// 无须构建标签分文件。
	if runtime.GOOS == "darwin" {
		winOpts.Mac = application.MacWindow{TitleBar: application.MacTitleBarHidden}
	} else {
		winOpts.Frameless = true
	}
	// Windows:wails 资产管道整体缓冲响应、SSE 无流式(见
	// localserv_windows.go);改从本地真实 HTTP 服务器加载,静态资产与
	// /goder-api 同源。本地服务器同时挂 transport 的 /wails/runtime IPC
	// 端点(见上)。失败则回退 wails 资产服务(流式缺失但可用)。
	if baseURL := startLocalServer(transport.Handler()(rootHandler)); baseURL != "" {
		winOpts.URL = baseURL
		defer stopLocalServer()
	}
	mainWin := app.Window.NewWithOptions(winOpts)

	// 托管模式冷启动自拉起,gh 随主窗体一起启动(所有平台同一时点):
	// 前端连接信息(/goder-api/token)零依赖即就绪,不必等 wails 调用通道;
	// 幂等(已运行则收养)。
	go coldStart(sm)

	// 主窗口关闭即退出应用。必要而非冗余:浏览器面板在 Windows 上的原生
	// 内容是一座真实的 Wails 窗口(其 HWND 被重父级成主窗口的子窗口),
	// 它也在 wails 的窗口表里 —— 只要它还在,"最后一个窗口已关闭"就永不
	// 成立,关掉主窗口后进程会带着隐藏窗口残留。显式 Quit 走正常终止路径:
	// 触发 OnShutdown → 各服务 ServiceShutdown(浏览器内容随之销毁)。
	mainWin.OnWindowEvent(wailsEvents.Common.WindowClosing, func(*application.WindowEvent) {
		app.Quit()
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// coldStart 托管模式冷启动(幂等,已运行则收养)。
func coldStart(sm *desktop.ServerManager) {
	if cfg, err := (&desktop.AppConfig{}).Load(); err != nil || cfg.ServerMode == "managed" {
		_ = sm.Start()
	}
}

// appServices wails 服务注册表(桌面主窗体与 test-serve 无头形态共用)。
// 顺序敏感:ConsoleMCP 依赖 BrowserManager 的 Manager,注册须在其后。
func appServices() []application.Service {
	return []application.Service{
		application.NewService(&desktop.AppConfig{}),
		application.NewService(desktop.GetServerManager()),
		application.NewService(&desktop.ModelConfig{}),
		application.NewService(&desktop.AgentConfig{}),
		application.NewService(&desktop.Desktop{}),
		application.NewService(desktop.GetTerminalManager()),
		application.NewService(desktop.GetBrowserManager()),
		application.NewService(desktop.GetConsoleMCP()),
		application.NewService(desktop.GetUpdater()),
	}
}
