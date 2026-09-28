// localserv.go — 本地真实 HTTP 服务器(跨平台核心)。Windows 生产桌面态
// 与 test-serve 无头测试态共用:静态资产 + /grf-api 反代 + wails HTTP
// transport(/wails/runtime 服务调用与事件)同源供应,页面从该服务器
// 加载。监听一律仅 127.0.0.1(回环即安全边界;生产背景见
// localserv_windows.go,测试形态背景见 testserve.go)。
package main

import (
	"fmt"
	"net"
	"net/http"
	"time"
)

var localServer *http.Server

// serveLocal 在 127.0.0.1:port 起 HTTP 服务(port 0 = 内核随机分配),
// 返回以 hostname 拼出的实际访问 URL;监听失败返回 ""。
func serveLocal(hostname string, port int, h http.Handler) string {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return ""
	}
	p := ln.Addr().(*net.TCPAddr).Port
	localServer = &http.Server{
		Handler: h,
		// 慢连接防护(回环本地服务);WriteTimeout 不设 —— SSE 长响应
		// 与 test-serve 事件流会被它掐断。
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() { _ = localServer.Serve(ln) }()
	return fmt.Sprintf("http://%s:%d/", hostname, p)
}

// stopLocalServer 回收监听(应用退出时调用)。
func stopLocalServer() {
	if localServer != nil {
		_ = localServer.Close()
	}
}
