// goder — grf-harness(gh)的 ZCode 风格图形界面。
// 桌面形态:wails v3;同一前端亦产出可嵌入三方 web 的 web components。
// wails 服务薄壳(AppConfig/ServerManager/Desktop/ModelConfig/
// TerminalManager)与 /grf-api 反代在 internal/desktop。
package main

import (
	"embed"
	"log"

	"git.gorun.fun/share/goder/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// 托管模式冷启动自拉起:前端连接信息(/grf-api/token)零依赖即就绪,
	// 不必等 wails 调用通道;幂等(已运行则收养)。
	sm := desktop.GetServerManager()
	go func() {
		if cfg, err := (&desktop.AppConfig{}).Load(); err != nil || cfg.ServerMode == "managed" {
			_ = sm.Start()
		}
	}()

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

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:   "main",
		Title:  "Goder",
		URL:    "/",
		Width:  1240,
		Height: 820,
		MinWidth:  880,
		MinHeight: 560,
		// 隐藏原生标题栏:仅保留左上红绿灯(关闭/最小化/最大化),内容
		// 铺满整窗;顶栏由前端自绘(app-shell 的 .topbar 即窗口拖拽区)。
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHidden,
		},
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
