// eval.go — 面板 webview 的 JS 求值与截图入口(goder-console 智能体
// 控制面的一部分)。求值统一包成"JSON 信封":表达式在页面里 try/catch
// 并 JSON.stringify,原生侧只回传字符串,异常不炸通道。
//
// 平台机制:
//   - macOS:WKWebView evaluateJavaScript 的完成回调经 cgo 回传
//     (native_darwin_eval.go);hooks 捕获脚本在 document start 由
//     WKUserScript 注入,console/网络捕获覆盖整页生命周期。
//   - Windows:Wails 窗口只有无返回值的 ExecJS —— 求值表达式把信封
//     fetch 回报到本进程的 loopback 端点(EvalReportPath),按调用 id
//     对应答(CompleteEval 由 HTTP 处理器调用);页面需允许向
//     127.0.0.1 发起 no-cors POST(严格 CSP connect-src 的页面会失败,
//     属已知限制)。hooks 在每次求值前幂等补装,覆盖导航后的新文档。
//   - 其余平台:不支持,返回 ErrUnsupported。
package browser

import (
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"
)

// ErrUnsupported 平台/形态不支持面板求值或截图。
var ErrUnsupported = errors.New("当前平台不支持面板浏览器控制")

// EvalReportPath 求值回报端点路径(Windows 机制;挂在 goder-console
// 的 loopback HTTP 服务上)。
const EvalReportPath = "/grf-eval-report"

// evalWaitTimeout 单次原生求值/截图的等待上限(页面里的死循环表达式
// 不至于挂死调用链)。
const evalWaitTimeout = 25 * time.Second

// ---------- 等待表:原生回调 / HTTP 回报按调用 id 唤醒 ----------

// evalResult 一次求值(或截图)的回传。
type evalResult struct {
	text string
	png  []byte
	err  string
}

var evalWaiters = struct {
	mu sync.Mutex
	m  map[uint64]chan evalResult
}{m: map[uint64]chan evalResult{}}

var evalCookieMu sync.Mutex
var evalCookieNext uint64

// nextEvalCookie 分配调用 id(全进程单调递增)。
func nextEvalCookie() uint64 {
	evalCookieMu.Lock()
	defer evalCookieMu.Unlock()
	evalCookieNext++
	return evalCookieNext
}

// registerEvalWaiter 登记等待方并返回应答通道。
func registerEvalWaiter(id uint64) chan evalResult {
	ch := make(chan evalResult, 1)
	evalWaiters.mu.Lock()
	evalWaiters.m[id] = ch
	evalWaiters.mu.Unlock()
	return ch
}

// deliverEval 原生回调路径交付结果;id 无法识别(超时已清理)返回 false。
func deliverEval(id uint64, res evalResult) bool {
	evalWaiters.mu.Lock()
	ch, ok := evalWaiters.m[id]
	if ok {
		delete(evalWaiters.m, id)
	}
	evalWaiters.mu.Unlock()
	if !ok {
		return false
	}
	ch <- res
	return true
}

// completeEvalWaiter HTTP 回报路径交付(Windows):body 首行是调用 id,
// 其余为信封 JSON。id 不合式时静默丢弃。
func completeEvalWaiter(idStr, payload string) {
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return
	}
	deliverEval(id, evalResult{text: payload})
}

// waitEval 阻塞等待应答,超时转错误并清理等待表。
func waitEval(id uint64, ch chan evalResult) (evalResult, error) {
	select {
	case res := <-ch:
		if res.err != "" {
			return res, errors.New(res.err)
		}
		return res, nil
	case <-time.After(evalWaitTimeout):
		evalWaiters.mu.Lock()
		delete(evalWaiters.m, id)
		evalWaiters.mu.Unlock()
		return evalResult{}, errors.New("求值超时(" + evalWaitTimeout.String() + ")")
	}
}

// ---------- Windows 求值回报通道 ----------

// reportBase Windows 求值回报的基础 URL(http://127.0.0.1:port),
// 由 goder-console 服务启动监听后经 SetReportBase 注入。包级变量:
// 面板 webview 全进程只有一块。
var reportBase string
var reportMu sync.RWMutex

// SetReportBase 设置 Windows 求值回报基础 URL(桌面装配期调用一次)。
func SetReportBase(base string) {
	reportMu.Lock()
	reportBase = base
	reportMu.Unlock()
}

func getReportBase() string {
	reportMu.RLock()
	defer reportMu.RUnlock()
	return reportBase
}

// jsString 把 Go 字符串安全地编码为 JS 字符串字面量。
func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// wrapEnvelope 把任意 JS 表达式包成"求值信封"表达式:求值 + await +
// 序列化,返回 JSON 字符串 {ok:true,value:…} 或 {ok:false,error:…}。
// 异步表达式(Promise)也会被 await。
func wrapEnvelope(expr string) string {
	return `(async () => {
		let v;
		try { v = await (` + expr + `); }
		catch (e) { return JSON.stringify({ok: false, error: '执行异常: ' + String((e && e.message) || e)}); }
		try { return JSON.stringify({ok: true, value: v === undefined ? null : v}); }
		catch (e) { return JSON.stringify({ok: false, error: '结果无法序列化: ' + String(e)}); }
	})()`
}

// Eval 在面板 webview 当前页面里求值 js 表达式,返回"信封"JSON 字符串
// (见 wrapEnvelope)。视图不存在时先确保内容(不导航)。
func (m *Manager) Eval(js string) (string, error) {
	if !m.Navigate("") { // 幂等:确保原生内容存在,不导航
		return "", ErrUnsupported
	}
	m.mu.Lock()
	v := m.v
	m.mu.Unlock()
	if v == nil {
		return "", ErrUnsupported
	}
	return evalIn(v, wrapEnvelope(js))
}

// SnapshotPNG 截取面板 webview 当前画面为 PNG(macOS;其余平台
// ErrUnsupported)。
func (m *Manager) SnapshotPNG() ([]byte, error) {
	m.mu.Lock()
	v := m.v
	m.mu.Unlock()
	if v == nil {
		return nil, ErrUnsupported
	}
	return snapshotIn(v)
}

// CompleteEval 交付一次求值回报(Windows:HTTP 处理器调用)。
func CompleteEval(id string, payload string) {
	completeEvalWaiter(id, payload)
}

// hooksJS 页面捕获脚本:console.* 与 error/unhandledrejection、fetch 与
// XMLHttpRequest 的请求记录,缓存在页面 window.__grfLog/__grfNet(各
// 上限 500 条,丢最旧),由 goder_browser_console / network 工具读取并
// 清空。幂等(__grfConsoleHooked 哨兵),darwin 经 WKUserScript 在
// document start 注入,Windows 每次求值前补装。
const hooksJS = `(() => {
	if (window.__grfConsoleHooked) return;
	window.__grfConsoleHooked = true;
	const CAP = 500;
	const push = (arr, s) => { if (arr.length >= CAP) arr.shift(); arr.push(s); };
	window.__grfLog = [];
	window.__grfNet = [];
	const ser = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return String(v); } };
	for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) {
		const orig = console[lvl] ? console[lvl].bind(console) : null;
		console[lvl] = (...args) => { push(window.__grfLog, '[' + lvl + '] ' + args.map(ser).join(' ')); if (orig) orig(...args); };
	}
	window.addEventListener('error', (e) => {
		push(window.__grfLog, '[pageerror] ' + (e.message || 'Script error') + (e.filename ? ' @ ' + e.filename + ':' + e.lineno : ''));
	});
	window.addEventListener('unhandledrejection', (e) => { push(window.__grfLog, '[unhandledrejection] ' + ser(e.reason)); });
	const of = window.fetch;
	if (of) {
		window.fetch = function (input, init) {
			const url = typeof input === 'string' ? input : (input && input.url) || '';
			const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
			const t0 = performance.now();
			return of.apply(this, arguments).then((resp) => {
				push(window.__grfNet, method + ' ' + url + ' -> ' + resp.status + ' (' + Math.round(performance.now() - t0) + 'ms' + (resp.headers && resp.headers.get ? ', ' + (resp.headers.get('content-type') || '') : '') + ')');
				return resp;
			}, (err) => {
				push(window.__grfNet, method + ' ' + url + ' -> 失败: ' + ((err && err.message) || err));
				throw err;
			});
		};
	}
	const ox = window.XMLHttpRequest;
	if (ox && ox.prototype) {
		const open = ox.prototype.open, send = ox.prototype.send;
		ox.prototype.open = function (m, u) { this.__grfM = m; this.__grfU = u; this.__grfT = performance.now(); return open.apply(this, arguments); };
		ox.prototype.send = function () {
			this.addEventListener('loadend', () => {
				push(window.__grfNet, String(this.__grfM || 'GET') + ' ' + String(this.__grfU || '') + ' -> ' + this.status + ' (' + Math.round(performance.now() - (this.__grfT || 0)) + 'ms)');
			});
			return send.apply(this, arguments);
		};
	}
})();`
