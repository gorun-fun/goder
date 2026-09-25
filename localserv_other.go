//go:build !windows

// localserv_other.go — 非 Windows 生产桌面态无本地 HTTP 服务器:macOS 的
// WKWebView scheme handler 支持流式,走 wails 资产服务即可(服务器核心
// 实现在跨平台的 localserv.go,test-serve 测试形态全平台使用)。
package main

import "net/http"

func startLocalServer(http.Handler) string { return "" }
