//go:build darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// applyWindowDecorations 隐藏原生标题栏:仅保留左上红绿灯(关闭/最小化/
// 最大化),内容铺满整窗;顶栏由前端自绘(app-shell 的顶排即窗口拖拽区)。
func applyWindowDecorations(o *application.WebviewWindowOptions) {
	o.Mac = application.MacWindow{
		TitleBar: application.MacTitleBarHidden,
	}
}
