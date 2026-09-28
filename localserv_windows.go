//go:build windows

// localserv_windows.go — Windows 生产桌面态入口:主窗口从本地真实 HTTP
// 服务器加载。服务器实现在跨平台的 localserv.go,此处只做生产参数
// (随机端口 + goder.localhost 主机名)。
//
// wails 在 Windows 上经 WebView2 的 WebResourceRequested 拦截供应资产,
// 其 responseWriter 把整个响应体缓冲到 Finish 才交给 WebView2(wails
// 源码自述:流式响应因此在 Windows 上不可用)—— /goder-api 的 SSE 会退化
// 为"回合结束一次性出全文"。绕过:主窗口直接从这个本地 net/http 服务器
// 加载(静态资产 + /goder-api 同源),流式即时下发恢复正常。
//
// Windows 内建把 *.localhost 解析到回环;前端 inWails 据此识别桌面态。
// 本机其他进程/浏览器标签也能打开该地址,暴露面与 goder-web-serve 单用户
// 模式相同(仅回环、令牌仍在用户配置目录内)。
package main

import "net/http"

// startLocalServer Windows 生产入口:随机端口;失败返回 ""(窗口回退
// wails 资产服务,流式缺失但可用)。
func startLocalServer(h http.Handler) string {
	return serveLocal("goder.localhost", 0, h)
}
