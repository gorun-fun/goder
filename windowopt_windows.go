//go:build windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// applyWindowDecorations Windows 没有 macOS 那种"隐藏标题栏但保留红绿灯"
// 的能力,只能整窗无边框:原生标题栏连同最小化/最大化/关闭一并消失,由
// 前端顶栏自绘(ZCode 同款,见 frontend 的 .winctl);拖动/双击缩放走
// 标题栏消息桥,边缘缩放由 wails runtime 的 drag 模块自动接管。
func applyWindowDecorations(o *application.WebviewWindowOptions) {
	o.Frameless = true
}
