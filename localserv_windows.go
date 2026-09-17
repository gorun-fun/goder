//go:build windows

// localserv_windows.go — Windows 桌面态的本地真实 HTTP 服务器。
//
// wails 在 Windows 上经 WebView2 的 WebResourceRequested 拦截供应资产,
// 其 responseWriter 把整个响应体缓冲到 Finish 才交给 WebView2(wails 源码
// 自述:流式响应因此在 Windows 上不可用)—— /grf-api 的 SSE 会退化为
// "回合结束一次性出全文"。绕过:主窗口直接从这个本地 net/http 服务器
// 加载(静态资产 + /grf-api 同源),流式即时下发恢复正常。
//
// 监听 127.0.0.1 随机端口,窗口 URL 用 goder.localhost 主机名(Windows
// 内建把 *.localhost 解析到回环;前端 inWails 据此识别桌面态)。本机
// 其他进程/浏览器标签也能打开该地址,暴露面与 grf-web-serve 单用户
// 模式相同(仅回环、令牌仍在用户配置目录内)。
package main

import (
	"fmt"
	"net"
	"net/http"
)

var localServer *http.Server

// startLocalServer 在 127.0.0.1 随机端口起服务;失败返回 ""(窗口回退
// wails 资产服务,流式缺失但可用)。
func startLocalServer(h http.Handler) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return ""
	}
	port := ln.Addr().(*net.TCPAddr).Port
	localServer = &http.Server{Handler: h}
	go func() { _ = localServer.Serve(ln) }()
	return fmt.Sprintf("http://goder.localhost:%d/", port)
}

// stopLocalServer 应用退出时回收监听(main 的 defer 调用)。
func stopLocalServer() {
	if localServer != nil {
		_ = localServer.Close()
	}
}
