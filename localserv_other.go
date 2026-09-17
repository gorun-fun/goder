//go:build !windows

// localserv_other.go — 非 Windows 平台无本地 HTTP 服务器:macOS 的
// WKWebView scheme handler 支持流式,走 wails 资产服务即可。
package main

import "net/http"

func startLocalServer(http.Handler) string { return "" }

func stopLocalServer() {}
