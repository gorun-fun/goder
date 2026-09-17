// goder — grf-harness(gh)的 ZCode 风格图形界面。
// 桌面形态:wails v3;同一前端亦产出可嵌入三方 web 的 web components。
// wails 服务薄壳(AppConfig/ServerManager/Desktop/ModelConfig/
// TerminalManager)与 /grf-api 反代在 internal/desktop。
package main

import (
	"embed"
	"log"
	"runtime"

	"git.gorun.fun/share/goder/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
	wailsEvents "github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	sm := desktop.GetServerManager()

	// Windows 环境检查门:托管模式下同步冷启动 —— gh 缺失时的下载弹窗
	// (MessageBox + 进度对话框)先走完(用户拒绝或失败也放行),之后才
	// 创建应用与主窗体("gh 下载以后才能打开主窗体")。其余平台 gh 已捆绑,
	// 冷启动在窗口创建后并发执行,不挡窗口。
	if runtime.GOOS == "windows" {
		coldStart(sm)
	}

	app := application.New(application.Options{
		Name:        "Goder",
		Description: "grf-harness 图形界面(项目会话 · 聊天 · 详情 · 事件台)",
		Services: []application.Service{
			application.NewService(&desktop.AppConfig{}),
			application.NewService(sm),
			application.NewService(&desktop.ModelConfig{}),
			application.NewService(&desktop.AgentConfig{}),
			application.NewService(&desktop.Desktop{}),
			application.NewService(desktop.GetTerminalManager()),
			application.NewService(desktop.GetBrowserManager()),
		},
		Assets: application.AssetOptions{
			Handler: desktop.RootHandler(application.BundledAssetFileServer(assets)),
			// 代理与静态资源都由我们接管,关掉逐请求日志噪音
			DisableLogging: true,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// 窗口装饰按平台分派(见 windowopt_*.go):mac 隐藏标题栏保留红绿灯;
	// windows 整窗无边框,窗口控制由前端顶栏自绘。共用部分写在这里。
	winOpts := application.WebviewWindowOptions{
		Name:      "main",
		Title:     "Goder",
		URL:       "/",
		Width:     1240,
		Height:    820,
		MinWidth:  880,
		MinHeight: 560,
	}
	applyWindowDecorations(&winOpts)
	mainWin := app.Window.NewWithOptions(winOpts)

	// 非 Windows 的托管模式冷启动自拉起(Windows 已在上方同步完成):
	// 前端连接信息(/grf-api/token)零依赖即就绪,不必等 wails 调用通道;
	// 幂等(已运行则收养)。
	if runtime.GOOS != "windows" {
		go coldStart(sm)
	}

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
