// tools_browser.go — goder-console 工具面之一:面板浏览器
// goder_browser_* 共 18 个工具(导航/快照/点击输入/滚动/求值/读文本/
// 控制台与网络捕获/截图/等待条件)。浏览器工具操作的是「用户看得见的
// 右栏浏览器面板」——与用户共享登录态与视图,适合本地开发调试与需要
// 人工围观/接管的场景;需要 isTrusted 真实事件或独立浏览器环境时仍应
// 使用 grf-browser 插件。goder-console 接入不变量:全部工具的中文展示名
// 在前端 shell/console-ui.ts 与接线同源注册(registry.chat.addToolMeta),
// Go 侧本文件增改工具时两边同步。
package console

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const refHelp = "goder_browser_snapshot 输出里的元素引用(如 e12)"

// sameNavTarget 宽松判定当前地址是否已到达导航目标(协议 http→https
// 升级、结尾斜杠、锚点/查询后缀、子路径跳转均视为到达)。
func sameNavTarget(href, target string) bool {
	norm := func(u string) string {
		u = strings.TrimSpace(u)
		u = strings.TrimSuffix(u, "/")
		u = strings.TrimPrefix(u, "https://")
		u = strings.TrimPrefix(u, "http://")
		if i := strings.IndexAny(u, "#?"); i >= 0 {
			u = u[:i]
		}
		return u
	}
	h, t := norm(href), norm(target)
	return h == t || strings.HasPrefix(h, t+"/")
}

// evalEnvelope Manager.Eval 返回的信封(见 internal/browser/eval.go)。
type evalEnvelope struct {
	OK    bool   `json:"ok"`
	Value any    `json:"value"`
	Error string `json:"error"`
}

// browserEval 在面板页面求值并拆信封;信封 error 与原生错误都转 Go error。
func (s *Server) browserEval(expr string) (any, error) {
	raw, err := s.deps.Browser.Eval(expr)
	if err != nil {
		return nil, err
	}
	var env evalEnvelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return nil, fmt.Errorf("求值结果解析失败: %w", err)
	}
	if !env.OK {
		return nil, fmt.Errorf("%s", env.Error)
	}
	return env.Value, nil
}

// evalText 在面板页面求值并把结果按紧凑 JSON 文本化(null → "null")。
func (s *Server) evalText(expr string) (string, error) {
	v, err := s.browserEval(expr)
	if err != nil {
		return "", err
	}
	if v == nil {
		return "null", nil
	}
	if str, ok := v.(string); ok {
		return str, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v), nil
	}
	return string(b), nil
}

const panelDesc = "操作 goder 界面右栏的内嵌浏览器面板(用户可见,与其共享登录态)" +
	"——适合本地开发调试:打开 dev server、复现操作、读控制台/网络定位问题。"

// ---------- 面板浏览器工具 ----------

func (s *Server) registerBrowserTools() {
	s.add(Tool{
		Name: "goder_browser_navigate",
		Description: panelDesc + "本工具打开指定 URL(当前面板视图导航),等页面加载完成后返回标题与最终 URL。" +
			"后续操作建议先 goder_browser_snapshot 获取可交互元素引用。需要独立无头浏览器(爬取/自动化)时改用 grf-browser 插件的 browser_navigate。",
		Schema: obj(map[string]any{"url": pstr("目标 URL(含 http:// 或 https://,本地开发服如 http://localhost:5173)")}, "url"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				URL string `json:"url"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			u, err := url.Parse(strings.TrimSpace(a.URL))
			if err != nil || u.Scheme == "" {
				return textErr("非法 URL %q(需含协议,如 http://localhost:5173)", a.URL)
			}
			switch u.Scheme {
			case "http", "https", "file", "about", "data":
			default:
				return textErr("不支持的协议 %q(允许 http/https/file/about/data)", u.Scheme)
			}
			// 让用户看得见:先开右栏浏览器 tab 并等前端恢复上次地址完成
			// (面板激活会触发前端 localStorage 记忆地址的自导航,与本次
			// 导航竞争;先让它发生,智能体的导航必须是最后到达的那个)。
			s.emitUI("side_tab_open", map[string]any{"defId": "browser"})
			time.Sleep(700 * time.Millisecond) // 等前端恢复上次地址的自导航先发生
			// 导航必须走前端 open_browser 通道(面板 open()→load()),不能
			// Go 直连 Browser.Navigate:直连只驱动原生视图,前端 this.url/
			// 地址栏/localStorage 记忆地址全部脱节 —— 用户随后点「刷新」时
			// this.url 可能为空导致静默失效,地址栏也显示错页面。
			s.emitUI("open_browser", map[string]any{"url": strings.TrimSpace(a.URL)})
			// 等加载:导航是异步的,起点页(about:blank 或恢复的旧地址)
			// 本来就 complete,readyState 不可作信号 —— 以 href 到达目标
			// 为准,再等 readyState complete。
			target := strings.TrimSpace(a.URL)
			deadline := time.Now().Add(10 * time.Second)
			for time.Now().Before(deadline) {
				href, _ := s.browserEval(`location.href`)
				h, _ := href.(string)
				if h != "" && sameNavTarget(h, target) {
					rs, _ := s.browserEval(`document.readyState`)
					if str, _ := rs.(string); str == "complete" {
						break
					}
				}
				time.Sleep(300 * time.Millisecond)
			}
			out, err := s.evalText(`({title: document.title, url: location.href, readyState: document.readyState})`)
			if err != nil {
				return textErr("已导航,但读取页面状态失败: %v", err)
			}
			return textOk("已打开面板浏览器:\n%s\n\n下一步:goder_browser_snapshot 获取元素引用,或 goder_browser_console / goder_browser_network 查看报错。", out)
		},
	})

	for _, t := range []struct {
		name, desc, js string
	}{
		{"goder_browser_back", "面板浏览器后退一页。", `history.back()`},
		{"goder_browser_forward", "面板浏览器前进一页。", `history.forward()`},
	} {
		tt := t
		s.add(Tool{
			Name: tt.name, Description: panelDesc + tt.desc, ReadOnly: true, Schema: obj(nil),
			Handler: func(s *Server, _ json.RawMessage) ([]Content, bool) {
				s.bmu.Lock()
				defer s.bmu.Unlock()
				if _, err := s.browserEval(tt.js); err != nil {
					return textErr("%v", err)
				}
				return textOk("完成。建议 goder_browser_snapshot 查看新页面")
			},
		})
	}

	s.add(Tool{
		Name:        "goder_browser_reload",
		Description: panelDesc + "刷新面板当前页面(改完代码后的回归验证)。",
		Schema:      obj(nil),
		Handler: func(s *Server, _ json.RawMessage) ([]Content, bool) {
			s.bmu.Lock()
			defer s.bmu.Unlock()
			s.deps.Browser.Reload()
			return textOk("已刷新。页面就绪后可 goder_browser_snapshot / console 复核")
		},
	})

	s.add(Tool{
		Name:        "goder_browser_state",
		Description: panelDesc + "读取当前页面状态(URL / 标题 / 加载状态)。",
		Schema:      obj(nil), ReadOnly: true,
		Handler: func(s *Server, _ json.RawMessage) ([]Content, bool) {
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(`({url: location.href, title: document.title, readyState: document.readyState})`)
			if err != nil {
				return textErr("%v", err)
			}
			return textOk("%s", out)
		},
	})

	s.add(Tool{
		Name: "goder_browser_snapshot",
		Description: panelDesc + "抓取页面大纲(角色/名称/[ref=…] 与主要文本块),交互元素打上快照引用," +
			"遍历穿透 shadow DOM 与同源 iframe。goder_browser_click/type/hover/select_option/scroll 都以这里的 ref 定位;" +
			"页面变化后需重拍。纯文本阅读用 goder_browser_get_text 更省。",
		Schema: obj(nil), ReadOnly: true,
		Handler: func(s *Server, _ json.RawMessage) ([]Content, bool) {
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(snapshotJS)
			if err != nil {
				return textErr("%v", err)
			}
			if strings.TrimSpace(out) == "" {
				out = "(页面无可见元素:body 未生成或全部被隐藏,可 goder_browser_state 查加载状态)"
			}
			return textOk("%s", out)
		},
	})

	s.add(Tool{
		Name: "goder_browser_click",
		Description: panelDesc + "点击快照引用的元素(合成 mousedown/mouseup/click;注意非 isTrusted," +
			"个别严格校验真实事件的页面不适用,那种页面请换 grf-browser 插件)。页面随后可能变化,建议重新 snapshot。",
		Schema: obj(map[string]any{
			"ref":          pstr(refHelp),
			"selector":     pstr("备用:直接 CSS 选择器(ref 缺失或失效时用)"),
			"double_click": pbool("双击(默认单击)"),
		}),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Ref      string `json:"ref"`
				Selector string `json:"selector"`
				Double   bool   `json:"double_click"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			sel := jsRefOrSelector(a.Ref, a.Selector)
			if sel == "" {
				return textErr("ref 与 selector 至少提供一个")
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(clickExpr(sel, a.Double))
			if err != nil {
				return textErr("%v", err)
			}
			return textOk("已点击:%s\n%s", sel, out)
		},
	})

	s.add(Tool{
		Name: "goder_browser_type",
		Description: panelDesc + "向快照引用的输入框填入文本(原生 value setter + input/change 事件);" +
			"submit=true 时随后提交表单(优先 requestSubmit)。",
		Schema: obj(map[string]any{
			"ref":      pstr(refHelp),
			"selector": pstr("备用:直接 CSS 选择器"),
			"text":     pstr("要输入的文本"),
			"submit":   pbool("输入后提交表单(回车)"),
		}, "text"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Ref      string `json:"ref"`
				Selector string `json:"selector"`
				Text     string `json:"text"`
				Submit   bool   `json:"submit"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			sel := jsRefOrSelector(a.Ref, a.Selector)
			if sel == "" {
				return textErr("ref 与 selector 至少提供一个")
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(typeExpr(sel, a.Text, a.Submit))
			if err != nil {
				return textErr("%v", err)
			}
			if !strings.Contains(out, `"ok":true`) && !strings.Contains(out, `"ok": true`) {
				return textOk("%s;可重新 goder_browser_snapshot 获取新引用", out)
			}
			return textOk("已输入到 %s", sel)
		},
	})

	s.add(Tool{
		Name:        "goder_browser_press_key",
		Description: panelDesc + "向当前聚焦元素发送按键:单键(enter/esc/tab/arrowdown 等)或组合(ctrl+a、cmd+shift+t)。",
		Schema:      obj(map[string]any{"key": pstr("按键或组合,如 Enter、Escape、ctrl+a")}, "key"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Key string `json:"key"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			expr, err := pressKeyExpr(a.Key)
			if err != nil {
				return textErr("%v", err)
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(expr)
			if err != nil {
				return textErr("%v", err)
			}
			return textOk("已按键 %s(%s)", a.Key, out)
		},
	})

	s.add(Tool{
		Name:        "goder_browser_hover",
		Description: panelDesc + "把鼠标悬停到快照引用的元素上(合成 mouseover/mouseenter,触发依赖 hover 的菜单/提示)。",
		Schema:      obj(map[string]any{"ref": pstr(refHelp)}, "ref"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Ref string `json:"ref"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(hoverExpr(jsRefOrSelector(a.Ref, "")))
			if err != nil {
				return textErr("%v", err)
			}
			return textOk("已悬停 %s\n%s", a.Ref, out)
		},
	})

	s.add(Tool{
		Name:        "goder_browser_select_option",
		Description: panelDesc + "在快照引用的下拉框中按 value 或可见文本选中选项。",
		Schema: obj(map[string]any{
			"ref":    pstr(refHelp),
			"values": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "选项 value 或文本列表"},
		}, "ref", "values"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Ref    string   `json:"ref"`
				Values []string `json:"values"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			if a.Ref == "" {
				return textErr("需要 ref")
			}
			vals, _ := json.Marshal(a.Values)
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(selectExpr(jsRefOrSelector(a.Ref, ""), string(vals)))
			if err != nil {
				return textErr("%v", err)
			}
			return textOk("已选择:%s", out)
		},
	})

	s.add(Tool{
		Name: "goder_browser_scroll",
		Description: panelDesc + "滚动页面(up/down/left/right,按像素)或把快照引用的元素滚到视口中央。" +
			"方向滚动走 window.scrollBy(内层滚动容器的应用布局可能不动,可用 ref 定位或 goder_browser_evaluate 精控)。",
		Schema: obj(map[string]any{
			"direction": map[string]any{"type": "string", "enum": []string{"up", "down", "left", "right"}, "description": "滚动方向(缺省 down)"},
			"amount":    pnum("滚动像素(缺省 600)"),
			"ref":       pstr("给出则改为把该元素滚到视口中央(优先于方向/像素)"),
		}),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Direction string  `json:"direction"`
				Amount    float64 `json:"amount"`
				Ref       string  `json:"ref"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			if a.Amount <= 0 {
				a.Amount = 600
			}
			if a.Direction == "" {
				a.Direction = "down"
			}
			refSel := ""
			if a.Ref != "" {
				refSel = jsRefOrSelector(a.Ref, "")
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(scrollExpr(a.Direction, a.Amount, refSel))
			if err != nil {
				return textErr("%v", err)
			}
			if a.Ref != "" {
				return textOk("已把 %s 滚动到视口中央", a.Ref)
			}
			return textOk("已滚动 %s %.0fpx\n%s", a.Direction, a.Amount, out)
		},
	})

	s.add(Tool{
		Name:        "goder_browser_evaluate",
		Description: panelDesc + "在面板当前页面执行任意 JavaScript 并返回结果(紧凑 JSON)。精查 DOM、读取变量用。",
		Schema:      obj(map[string]any{"expression": pstr("JS 表达式(在页面上下文求值,支持 Promise)")}, "expression"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Expression string `json:"expression"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			if strings.TrimSpace(a.Expression) == "" {
				return textErr("expression 不能为空")
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			out, err := s.evalText(a.Expression)
			if err != nil {
				return textErr("%v", err)
			}
			return textOk("%s", out)
		},
	})

	s.add(Tool{
		Name:        "goder_browser_get_text",
		Description: panelDesc + "读取当前页面可见文本(innerText,截断 2 万字符;自动等渲染稳定)。只读、比快照省。",
		Schema:      obj(nil), ReadOnly: true,
		Handler: func(s *Server, _ json.RawMessage) ([]Content, bool) {
			s.bmu.Lock()
			defer s.bmu.Unlock()
			// 点击触发的导航没有统一等待点:空文本或仍在变化时稍候重试
			prev := ""
			text := ""
			for i := 0; i < 4; i++ {
				v, err := s.browserEval(`document.body ? document.body.innerText : ''`)
				if err != nil {
					return textErr("%v", err)
				}
				text, _ = v.(string)
				if strings.TrimSpace(text) != "" && text == prev {
					break
				}
				prev = text
				time.Sleep(400 * time.Millisecond)
			}
			text = prev
			runes := []rune(text)
			if len(runes) > 20000 {
				text = string(runes[:20000]) + "\n…(截断,可用 goder_browser_evaluate 精查)"
			}
			if strings.TrimSpace(text) == "" {
				return textOk("(页面无可见文本:body 未生成或为空)")
			}
			return textOk("%s", text)
		},
	})

	s.add(Tool{
		Name: "goder_browser_screenshot",
		Description: panelDesc + "截取面板当前视口 PNG(多模态回传)。注意:面板隐藏时可能是最后一帧;" +
			"仅 macOS 支持(Windows/Linux 暂不支持,可用 goder_browser_snapshot 替代)。",
		Schema: obj(nil), ReadOnly: true,
		Handler: func(s *Server, _ json.RawMessage) ([]Content, bool) {
			s.bmu.Lock()
			defer s.bmu.Unlock()
			png, err := s.deps.Browser.SnapshotPNG()
			if err != nil {
				return textErr("截图失败: %v", err)
			}
			return []Content{{
				Type:     "image",
				MimeType: "image/png",
				Data:     base64.StdEncoding.EncodeToString(png),
			}}, false
		},
	})

	s.add(Tool{
		Name: "goder_browser_console",
		Description: panelDesc + "读取并清空面板页面捕获的控制台输出(console.* / 页面异常 / 未处理拒绝)。" +
			"调试报错的第一入口:复现操作后读这里。捕获自页面加载起(macOS)或工具首次调用起(Windows)。",
		Schema: obj(map[string]any{"limit": pnum("最多返回条数(缺省全部)")}), ReadOnly: true,
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Limit int `json:"limit"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			v, err := s.browserEval(`(() => { const arr = window.__goderLog ? window.__goderLog.splice(0) : null; return arr; })()`)
			if err != nil {
				return textErr("%v", err)
			}
			lines, _ := v.([]any)
			if a.Limit > 0 && len(lines) > a.Limit {
				lines = lines[len(lines)-a.Limit:]
			}
			if len(lines) == 0 {
				return textOk("(暂无捕获的控制台输出;注意 Windows 下捕获自本工具首次调用起,更早的日志没有)")
			}
			out := make([]string, 0, len(lines))
			for _, l := range lines {
				out = append(out, fmt.Sprint(l))
			}
			return textOk("%s", strings.Join(out, "\n"))
		},
	})

	s.add(Tool{
		Name: "goder_browser_network",
		Description: panelDesc + "读取并清空面板页面捕获的网络请求(fetch/XHR:方法 URL -> 状态/耗时/类型)。" +
			"查接口报错与失败请求用。静态资源与 WebSocket 不在此列(那是 grf-browser 插件 CDP 的能力)。",
		Schema: obj(map[string]any{"limit": pnum("最多返回条数(缺省 50)")}), ReadOnly: true,
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Limit int `json:"limit"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			if a.Limit <= 0 {
				a.Limit = 50
			}
			s.bmu.Lock()
			defer s.bmu.Unlock()
			v, err := s.browserEval(`(() => { const arr = window.__goderNet ? window.__goderNet.splice(0) : null; return arr; })()`)
			if err != nil {
				return textErr("%v", err)
			}
			lines, _ := v.([]any)
			if len(lines) > a.Limit {
				lines = lines[len(lines)-a.Limit:]
			}
			if len(lines) == 0 {
				return textOk("(暂无捕获的网络请求)")
			}
			out := make([]string, 0, len(lines))
			for _, l := range lines {
				out = append(out, fmt.Sprint(l))
			}
			return textOk("%s", strings.Join(out, "\n"))
		},
	})

	s.add(Tool{
		Name: "goder_browser_wait_for",
		Description: panelDesc + "等待页面出现指定文本(body.innerText 包含)或 URL 包含指定子串——点击后的异步跳转/渲染用。" +
			"轮询 250ms,超时报错。",
		Schema: obj(map[string]any{
			"text":       pstr("等待出现的文本(与 url 至少给一个)"),
			"url":        pstr("等待 URL 包含的子串"),
			"timeout_ms": pnum("超时毫秒(缺省 10000,上限 30000)"),
		}),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Text      string  `json:"text"`
				URL       string  `json:"url"`
				TimeoutMs float64 `json:"timeout_ms"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			if a.Text == "" && a.URL == "" {
				return textErr("text 与 url 至少提供一个")
			}
			if a.TimeoutMs <= 0 {
				a.TimeoutMs = 10000
			}
			if a.TimeoutMs > 30000 {
				a.TimeoutMs = 30000
			}
			deadline := time.Now().Add(time.Duration(a.TimeoutMs * float64(time.Millisecond)))
			expr := fmt.Sprintf(`(() => {
				const okText = %s === '' || (document.body && document.body.innerText.includes(%s));
				const okUrl = %s === '' || location.href.includes(%s);
				return {ok: okText && okUrl, url: location.href};
			})()`, jsString(a.Text), jsString(a.Text), jsString(a.URL), jsString(a.URL))
			s.bmu.Lock()
			defer s.bmu.Unlock()
			for {
				v, err := s.browserEval(expr)
				if err != nil {
					return textErr("%v", err)
				}
				m, _ := v.(map[string]any)
				if ok, _ := m["ok"].(bool); ok {
					return textOk("条件满足: %v", m["url"])
				}
				if time.Now().After(deadline) {
					return textErr("等待超时(%.0fms),当前 URL: %v", a.TimeoutMs, m["url"])
				}
				time.Sleep(250 * time.Millisecond)
			}
		},
	})
}
