//go:build !darwin && !windows && !linux

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// applyWindowDecorations 其余平台(BSD 等)保持原生窗口边框。
func applyWindowDecorations(_ *application.WebviewWindowOptions) {}
