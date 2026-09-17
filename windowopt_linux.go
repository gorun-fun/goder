//go:build linux

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// applyWindowDecorations Linux 与 Windows 相同:整窗无边框(原生标题栏与
// 窗口按钮一并移除),窗口控制由前端顶栏自绘(winctl);拖动走标题栏消息
// 桥,边缘缩放由 wails runtime 的 drag 模块接管(frameless 下 Linux 亦支持,
// 见 runtime drag.js 的 IsLinux+frameless 分支)。
func applyWindowDecorations(o *application.WebviewWindowOptions) {
	o.Frameless = true
}
