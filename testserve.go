// testserve.go — `goder test-serve` 子命令:桌面应用的无头测试形态。
//
// 目的:发布版 E2E 测试(面向 AI/浏览器自动化,测试指导见
// docs/testing.md)。桌面形态的界面与原生能力(终端面板、配置持久化、
// gh 托管等)平时只能在 wails 窗口内运行,自动化工具难以驱动;本子命令
// 复用 Windows 生产态的本地 HTTP 服务器机制(localserv.go)把同一份应用
// 暴露给普通浏览器:
//
//   - 无头:不创建任何窗口(wails 事件循环照常跑,服务启动钩子、托管
//     gh 冷启动、goder-console 安装照常执行);macOS 以 Accessory 策略
//     运行、不占 Dock;
//   - 处理链:令牌门槛 → /wails/runtime(wails HTTP transport:服务调用)
//     → /grf-api 反代 + /grf-api/token + 前端静态资产(RootHandler);
//   - 事件回传:wails 的事件下发是"Go 侧对每个窗口 ExecJS",无头形态
//     没有窗口、事件无处可去 —— testTransport(下)实现 WailsEventListener,
//     wails 在 New() 时自动注册为全局事件监听器,把所有自定义事件
//     (grf:term-* / grf:console-ui / grf:update-progress)经
//     /test-serve/events SSE 回传;前端 bridge.ts 的 detectDesktopHost
//     订阅后喂回 window._wails.dispatchWailsEvent(与 wails 官方 server
//     模式的 custom.js WebSocket 中继同一机制,事件名/负载格式同源);
//   - 仅监听 127.0.0.1;URL 携带一次性随机令牌(?t=),首次访问种
//     HttpOnly cookie,后续同源 fetch/SSE/EventSource 自动携带;
//   - /grf-host-probe 标记端点(免令牌,204):前端据此识别 test-serve
//     宿主并启动事件中继(bridge.ts detectDesktopHost);
//   - /test-serve/guide(需令牌):内嵌的 docs/testing.md 测试指导全文
//     (响应头带版本/平台元数据),测试文档随二进制分发、无需单独传递;
//   - /test-serve/quit(需令牌):优雅退出,供自动化收尾。
//
// 与桌面 App 共享同一份配置、项目索引与 gh server(托管实例幂等收养);
// 但 goder-console 的启动期烙写会互相覆盖端口/令牌,不要与桌面 App 同时
// 运行(docs/testing.md 已注明)。本形态与生产的保真度差异(资产加载
// 路径、WebView 引擎)见 docs/testing.md 平台差异矩阵。
package main

import (
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"

	"git.gorun.fun/share/goder/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// testingGuide 测试指导全文(docs/testing.md,发布版测试的单一事实源):
// 打进二进制、经 /test-serve/guide 端点暴露,目标平台的测试 agent 起
// 服务后直接拉取,测试文档无需随产物单独分发。
//
//go:embed docs/testing.md
var testingGuide []byte

// testServeCookie 令牌 cookie 名;首次带 ?t= 进入时种下,后续同源请求
// 由浏览器自动携带(@wailsio/runtime 的 fetch 与 EventSource 同源默认带)。
const testServeCookie = "goder-test-token"

func runTestServe(args []string) error {
	// main 传入 os.Args[1:](首元素是子命令名);flag 包遇到位置参数即
	// 停止解析,先剥掉再 Parse。
	if len(args) > 0 && args[0] == "test-serve" {
		args = args[1:]
	}
	fs := flag.NewFlagSet("test-serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	port := fs.Int("port", 7460, "监听端口(仅 127.0.0.1;被占时回退随机端口)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	token, err := randToken()
	if err != nil {
		return fmt.Errorf("生成令牌失败: %w", err)
	}

	sm := desktop.GetServerManager()
	// 与桌面主窗体同一时点做 gh 环境检查(缺失自动下载,macOS/Linux 静默)。
	sm.EnsureGh()

	rootHandler := desktop.RootHandler(application.BundledAssetFileServer(assets))
	// testTransport = HTTP transport(服务调用)+ 事件广播(SSE),作为
	// 应用 Transport 交给 wails:New() 自动把 WailsEventListener 注册进
	// 事件监听器列表(application.go 的 auto-wire)。
	transport := &testTransport{HTTPTransport: application.NewHTTPTransport()}
	app := application.New(application.Options{
		Name:        "Goder",
		Description: "grf-harness 图形界面(test-serve 无头测试形态)",
		Services:    appServices(),
		Assets: application.AssetOptions{
			Handler:        rootHandler,
			DisableLogging: true,
		},
		// 无头不占 Dock;ActivationPolicy 仅 macOS 生效,其他平台忽略
		Mac:       application.MacOptions{ActivationPolicy: application.ActivationPolicyAccessory},
		Transport: transport,
	})

	quit := func() { app.Quit() }
	h := testServeHandler(transport, token, quit, transport.Handler()(rootHandler))

	// 端口策略:优先 --port(自动化可预期);被占回退随机端口,以实际
	// 打印的 URL 为准。
	base := serveLocal("goder.localhost", *port, h)
	if base == "" && *port != 0 {
		base = serveLocal("goder.localhost", 0, h)
		if base != "" {
			log.Printf("警告: 端口 %d 被占用,已回退随机端口", *port)
		}
	}
	if base == "" {
		return fmt.Errorf("无法监听 127.0.0.1:%d", *port)
	}

	log.Printf("test-serve 就绪(仅 127.0.0.1,退出: Ctrl+C):")
	log.Printf("  打开:       %s?t=%s", base, token)
	// Linux 裸 /etc/hosts 环境可能不解析 *.localhost,提供 127.0.0.1 直连
	// 形式(前端经 /grf-host-probe 探针识别,行为一致)。
	log.Printf("  直连形式:   %s?t=%s", strings.Replace(base, "goder.localhost", "127.0.0.1", 1), token)
	log.Printf("  探活:       HEAD %sgrf-host-probe → 204", base)
	log.Printf("  测试指导:   GET %stest-serve/guide?t=%s", base, token)
	log.Printf("  优雅退出:   POST %stest-serve/quit?t=%s", base, token)

	// 托管模式冷启动(与桌面主窗体同一时点,幂等,已运行则收养)。
	go coldStart(sm)

	// 信号退出(Ctrl+C / kill)。
	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, os.Interrupt, syscall.SIGTERM)
		<-c
		quit()
	}()

	defer stopLocalServer()
	return app.Run()
}

// ---------- 事件回传:WailsEventListener → SSE ----------

// testTransport 包装 wails HTTP transport(/wails/runtime 服务调用),
// 并实现 WailsEventListener —— wails 在 application.New 时对实现了该
// 接口的 Transport 自动注册为全局事件监听器,此后每个自定义事件都会
// 回调 DispatchWailsEvent。这里把事件 JSON 化后扇出给 /test-serve/events
// 的 SSE 订阅者(负载格式与 CustomEvent json 标签一致,前端
// window._wails.dispatchWailsEvent 直接消费,同官方 server 模式)。
type testTransport struct {
	*application.HTTPTransport

	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

// DispatchWailsEvent WailsEventListener:广播到所有 SSE 订阅者。
// 非阻塞投递(订阅者缓冲 1024 帧,过载丢帧只影响测试会话,不拖慢
// wails 事件邮箱;本程序自定义事件均为小负载,实测不会触顶)。
func (t *testTransport) DispatchWailsEvent(event *application.CustomEvent) {
	if event == nil {
		return
	}
	b, err := json.Marshal(event)
	if err != nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for ch := range t.subs {
		select {
		case ch <- b:
		default:
		}
	}
}

// serveEvents GET /test-serve/events:SSE 事件流(令牌门槛在
// testServeHandler 层,cookie 随同源请求自动携带)。
func (t *testTransport) serveEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	fl.Flush()

	ch := make(chan []byte, 1024)
	t.mu.Lock()
	if t.subs == nil {
		t.subs = make(map[chan []byte]struct{})
	}
	t.subs[ch] = struct{}{}
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.subs, ch)
		t.mu.Unlock()
	}()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			fl.Flush()
		}
	}
}

// ---------- 令牌门槛与测试辅助端点 ----------

// testServeHandler 最外层:标记/辅助端点 + 令牌门槛,包住 wails transport
// 与 RootHandler 的整条链。
func testServeHandler(tt *testTransport, token string, quit func(), next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/grf-host-probe":
			// 前端宿主探测标记端点(bridge.ts detectDesktopHost):
			// 免令牌、零副作用,只回报"这是 goder test-serve 宿主"。
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNoContent)
			return
		case "/test-serve/guide":
			// 测试指导全文(docs/testing.md 内嵌;响应头带版本/平台元数据,
			// 测试 agent 拉取后按文档执行,无需单独分发文档)。
			if !testTokenOK(w, r, token) {
				http.Error(w, "test-serve: 令牌无效", http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Goder-Version", desktop.AppVersion())
			w.Header().Set("X-Goder-Platform", runtime.GOOS+"/"+runtime.GOARCH)
			w.Write(testingGuide)
			return
		case "/test-serve/quit":
			if !testTokenOK(w, r, token) {
				http.Error(w, "test-serve: 令牌无效", http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			go quit()
			return
		case "/test-serve/events":
			if !testTokenOK(w, r, token) {
				http.Error(w, "test-serve: 令牌无效", http.StatusForbidden)
				return
			}
			tt.serveEvents(w, r)
			return
		}
		if !testTokenOK(w, r, token) {
			http.Error(w, "test-serve: 令牌无效,请用启动时打印的 ?t=<token> URL 访问", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// testTokenOK 校验 ?t= 或 cookie 令牌(恒时比较);query 命中时顺带种
// HttpOnly cookie(首次进入后,同源 fetch/EventSource 自动携带)。
func testTokenOK(w http.ResponseWriter, r *http.Request, token string) bool {
	if v := r.URL.Query().Get("t"); v != "" {
		if subtle.ConstantTimeCompare([]byte(v), []byte(token)) == 1 {
			http.SetCookie(w, &http.Cookie{
				Name:     testServeCookie,
				Value:    token,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
			})
			return true
		}
		return false
	}
	if c, err := r.Cookie(testServeCookie); err == nil {
		return subtle.ConstantTimeCompare([]byte(c.Value), []byte(token)) == 1
	}
	return false
}

// randToken 128 位随机令牌(hex)。
func randToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
