//go:build !darwin && !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// applyWindowDecorations Linux 等平台保持原生窗口边框:GTK 无边框需前端
// 自绘全部窗口控制且各桌面环境表现不一致,暂不跟进(要跟进时在此置
// o.Frameless = true,并在前端放行对应平台的 .winctl)。
func applyWindowDecorations(_ *application.WebviewWindowOptions) {}
