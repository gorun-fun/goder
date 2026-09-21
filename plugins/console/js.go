// js.go — 浏览器工具注入页面的 JS 片段。snapshot/dq 机制移植自
// grf-harness 的 plugins/browser(snapshot.go),ref 语义与其一致:
// 快照给可交互元素打 data-grf-ref,后续 click/type 等按 ref 深度定位
// (穿透 shadow DOM 与同源 iframe)。合成事件无 isTrusted,本地开发
// 调试场景足够(反爬/canvas 自绘交互请用 grf-browser 插件的真 Chrome)。
package console

import (
	"encoding/json"
	"fmt"
	"strings"
)

// jsString Go 字符串 → JS 字符串字面量。
func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// deepQueryJS 定义 window.__grfDeepQuery:按 CSS 选择器深度查找
// (document → shadow root → 同源 iframe 文档,递归)。与 gh 同名实现
// 逐字一致,保持两套工具的行为对齐。
const deepQueryJS = `window.__grfDeepQuery = window.__grfDeepQuery || ((sel) => {
  const search = (root) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const r = search(el.shadowRoot);
        if (r) return r;
      }
    }
    for (const f of root.querySelectorAll('iframe')) {
      try {
        if (f.contentDocument) {
          const r = search(f.contentDocument);
          if (r) return r;
        }
      } catch (e) {}
    }
    return null;
  };
  return search(document);
});`

// dqHelper 操作表达式里取深度查找函数(未定义则退化为仅主文档)。
const dqHelper = `const dq = window.__grfDeepQuery || (s => document.querySelector(s));`

// snapshotJS DOM 大快照:返回大纲文本(角色 + 名称 + [ref=eN])。与 gh
// 同名实现一致,仅把溢出提示里的工具名改为本套工具。
const snapshotJS = `(() => {
  ` + deepQueryJS + `
  const sweep = (root) => {
    root.querySelectorAll('*').forEach(el => {
      el.removeAttribute('data-grf-ref');
      if (el.shadowRoot) sweep(el.shadowRoot);
    });
    for (const f of root.querySelectorAll('iframe')) {
      try { if (f.contentDocument) sweep(f.contentDocument); } catch (e) {}
    }
  };
  sweep(document);
  const root = document.body || document.documentElement;
  if (!root) return '(空页面)';
  const lines = [];
  let n = 0, overflow = false;
  const MAXLINES = 800;
  const INTERACTIVE_TAGS = new Set(['a','button','input','select','textarea','summary','label']);
  const LANDMARKS = new Set(['main','nav','header','footer','aside','form','table','article','section']);
  const HEADINGS = new Set(['h1','h2','h3','h4','h5','h6']);
  const TEXT_TAGS = new Set(['p','li','td','th','blockquote','pre','dd','dt','figcaption','code']);
  const ROLE_TAGS = new Set(['button','link','checkbox','radio','tab','menuitem','option','combobox','textbox','searchbox','switch','slider','treeitem','tablist','dialog']);
  const hidden = (el) => {
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'img') return 'image';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'file' || t === 'reset') return 'button';
      return 'textbox';
    }
    if (tag === 'summary') return 'button';
    if (HEADINGS.has(tag)) return 'heading';
    return tag;
  };
  const nameOf = (el) => {
    let s = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    const tag = el.tagName.toLowerCase();
    if (!s && (tag === 'input' || tag === 'textarea')) s = el.value || '';
    if (!s) s = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!s) s = el.getAttribute('value') || '';
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > 100) s = s.slice(0, 100) + '…';
    return s;
  };
  const isInteractive = (el) => {
    if (el.hasAttribute('disabled')) return false;
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (el.hasAttribute('onclick') || el.isContentEditable) return true;
    return ROLE_TAGS.has(el.getAttribute('role') || '');
  };
  const markRef = (el) => {
    const ref = 'e' + (++n);
    el.setAttribute('data-grf-ref', ref);
    return ref;
  };
  const walk = (el, depth) => {
    if (overflow || lines.length >= MAXLINES) { overflow = true; return; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'svg') return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (hidden(el)) return;
    const interactive = isInteractive(el);
    const interesting = interactive || LANDMARKS.has(tag) || HEADINGS.has(tag) || tag === 'img' || TEXT_TAGS.has(tag);
    if (!interesting) {
      descend(el, depth);
      return;
    }
    const role = roleOf(el);
    let line = '  '.repeat(depth) + '- ' + role;
    const nm = nameOf(el);
    if (nm) line += ' "' + nm.replace(/"/g, "'") + '"';
    if (interactive) line += ' [ref=' + markRef(el) + ']';
    lines.push(line);
    if (tag !== 'select' && tag !== 'input' && tag !== 'textarea' && depth < 18) {
      descend(el, depth + 1);
    }
  };
  const descend = (el, depth) => {
    if (el.tagName && el.tagName.toLowerCase() === 'iframe') {
      try {
        const doc = el.contentDocument;
        if (doc && doc.body) {
          for (const c of doc.body.children) walk(c, depth);
        } else {
          lines.push('  '.repeat(depth) + '- iframe "(跨域或未加载,不可注入)"');
        }
      } catch (e) {
        lines.push('  '.repeat(depth) + '- iframe "(跨域,不可注入)"');
      }
      return;
    }
    for (const c of el.children) walk(c, depth);
    if (el.shadowRoot) {
      for (const c of el.shadowRoot.children) walk(c, depth);
    }
  };
  walk(root, 0);
  if (overflow) lines.push('…(内容超出快照上限,可用 goder_browser_evaluate 精查)');
  return lines.join('\n');
})()`

// refSelector ref → CSS 选择器(快照标注的属性选择器;与 gh 一致)。
func refSelector(ref string) string { return `[data-grf-ref="` + ref + `"]` }

// jsRefOrSelector 工具参数(ref/selector)→ CSS 选择器表达式;两者皆空
// 返回空串(调用方自行报参数错误)。
func jsRefOrSelector(ref, selector string) string {
	if ref != "" {
		return jsString(refSelector(ref))
	}
	if selector != "" {
		return jsString(selector)
	}
	return ""
}

// clickExpr 点击表达式:滚动到可见 → 合成 mousedown/mouseup/click
// (double 再补 dblclick)。
func clickExpr(sel string, double bool) string {
	dbl := ""
	if double {
		dbl = `el.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));`
	}
	return fmt.Sprintf(`(() => {
		%s
		const el = dq(%s);
		if (!el) return {ok: false, error: '元素不存在: %s(页面已变化?请重新 goder_browser_snapshot)'};
		el.scrollIntoView({block: 'center'});
		el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
		el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
		el.click();
		%s
		return {ok: true, tag: el.tagName.toLowerCase(), name: (el.innerText || el.value || '').slice(0, 60)};
	})()`, dqHelper, sel, sel, dbl)
}

// typeExpr 输入表达式:原生 value setter + input/change 事件(submit 时
// 优先 form.requestSubmit,无表单则派发 Enter 键序)。
func typeExpr(sel, text string, submit bool) string {
	sub := ""
	if submit {
		sub = `
		if (el.form && el.form.requestSubmit) el.form.requestSubmit();
		else {
			const ke = (t) => new KeyboardEvent(t, {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true});
			el.dispatchEvent(ke('keydown')); el.dispatchEvent(ke('keypress')); el.dispatchEvent(ke('keyup'));
		}`
	}
	return fmt.Sprintf(`(() => {
		%s
		const el = dq(%s);
		if (!el) return {ok: false, error: '元素不存在: %s(可重新 goder_browser_snapshot)'};
		el.scrollIntoView({block: 'center'});
		el.focus();
		const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
		const desc = Object.getOwnPropertyDescriptor(proto, 'value');
		if (desc && desc.set) desc.set.call(el, %s); else el.value = %s;
		el.dispatchEvent(new Event('input', {bubbles: true}));
		el.dispatchEvent(new Event('change', {bubbles: true}));
		%s
		return {ok: true};
	})()`, dqHelper, sel, sel, jsString(text), jsString(text), sub)
}

// hoverExpr 悬停表达式:mouseove/mouseenter(冒泡边界与真实事件一致:
// over/move 冒泡,enter/leave 不冒泡)。
func hoverExpr(sel string) string {
	return fmt.Sprintf(`(() => {
		%s
		const el = dq(%s);
		if (!el) return {ok: false, error: '元素不存在'};
		el.scrollIntoView({block: 'center'});
		el.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
		el.dispatchEvent(new MouseEvent('mouseenter', {bubbles: false}));
		el.dispatchEvent(new MouseEvent('mousemove', {bubbles: true}));
		return {ok: true};
	})()`, dqHelper, sel)
}

// selectExpr 下拉框选择表达式(按 value 或可见文本;与 gh 同逻辑)。
func selectExpr(sel string, values string) string {
	return fmt.Sprintf(`(() => {
		%s
		const el = dq(%s);
		if (!el || el.tagName !== 'SELECT') return {ok: false, matched: []};
		const matched = [];
		for (const v of %s) {
			const opt = [...el.options].find(o => o.value === v || o.text.trim() === v);
			if (opt) { opt.selected = true; matched.push(v); }
		}
		el.dispatchEvent(new Event('input', {bubbles: true}));
		el.dispatchEvent(new Event('change', {bubbles: true}));
		return {ok: matched.length > 0, matched};
	})()`, dqHelper, sel, values)
}

// scrollExpr 滚动表达式:ref 模式把元素滚到视口中央;方向模式
// window.scrollBy(内层滚动容器派发滚轮事件由浏览器路由,合成 WheelEvent
// 不可信事件多数页面不响应,window.scrollBy + 容器兜底查询)。
func scrollExpr(direction string, amount float64, refSel string) string {
	if refSel != "" {
		return fmt.Sprintf(`(() => {
			%s
			const el = dq(%s);
			if (!el) return {ok: false};
			el.scrollIntoView({block: 'center'});
			return {ok: true};
		})()`, dqHelper, refSel)
	}
	dx, dy := 0.0, 0.0
	switch direction {
	case "up":
		dy = -amount
	case "left":
		dx = -amount
	case "right":
		dx = amount
	default:
		dy = amount
	}
	return fmt.Sprintf(`(() => {
		window.scrollBy({left: %v, top: %v, behavior: 'instant' in window ? 'instant' : 'auto'});
		let inner = 0;
		for (const el of document.querySelectorAll('*')) {
			const cs = getComputedStyle(el);
			if (/auto|scroll/.test(cs.overflowY) && el.scrollTop > inner) inner = el.scrollTop;
		}
		return {ok: true, win: window.scrollY, inner};
	})()`, dx, dy)
}

// keyParams 具名按键 → {key, code, keyCode}(合成 KeyboardEvent 用)。
var keyParams = map[string]struct{ key, code string; kc int }{
	"enter": {"Enter", "Enter", 13}, "return": {"Enter", "Enter", 13},
	"tab": {"Tab", "Tab", 9}, "escape": {"Escape", "Escape", 27}, "esc": {"Escape", "Escape", 27},
	"backspace": {"Backspace", "Backspace", 8}, "delete": {"Delete", "Delete", 46},
	"space": {" ", "Space", 32},
	"arrowup": {"ArrowUp", "ArrowUp", 38}, "arrowdown": {"ArrowDown", "ArrowDown", 40},
	"arrowleft": {"ArrowLeft", "ArrowLeft", 37}, "arrowright": {"ArrowRight", "ArrowRight", 39},
	"up": {"ArrowUp", "ArrowUp", 38}, "down": {"ArrowDown", "ArrowDown", 40},
	"left": {"ArrowLeft", "ArrowLeft", 37}, "right": {"ArrowRight", "ArrowRight", 39},
	"pageup": {"PageUp", "PageUp", 33}, "pagedown": {"PageDown", "PageDown", 34},
	"home": {"Home", "Home", 36}, "end": {"End", "End", 35},
}

// pressKeyExpr 组合键表达式:向当前聚焦元素派发 keydown/keypress/keyup。
// ctrl+alt+shift+meta(cmd) 修饰;单字符按键直接以字符为 key。
func pressKeyExpr(combo string) (string, error) {
	tokens := splitCombo(combo)
	if len(tokens) == 0 {
		return "", fmt.Errorf("按键为空")
	}
	var ctrl, alt, shift, meta bool
	for _, t := range tokens[:len(tokens)-1] {
		switch t {
		case "ctrl", "control":
			ctrl = true
		case "alt", "option":
			alt = true
		case "cmd", "meta", "command":
			meta = true
		case "shift":
			shift = true
		default:
			return "", fmt.Errorf("未知修饰键 %q(可用 ctrl/alt/shift/cmd)", t)
		}
	}
	key := tokens[len(tokens)-1]
	var code string
	kc := 0
	if p, ok := keyParams[key]; ok {
		key, code, kc = p.key, p.code, p.kc
	} else {
		rs := []rune(key)
		if len(rs) != 1 {
			return "", fmt.Errorf("未知按键 %q(可用 enter/esc/tab/arrowdown 等或单字符)", key)
		}
		code = "Key" + strings.ToUpper(string(rs[0]))
		if rs[0] >= 'a' && rs[0] <= 'z' || rs[0] >= 'A' && rs[0] <= 'Z' {
			kc = int(rs[0])
		}
	}
	return fmt.Sprintf(`(() => {
		const target = document.activeElement || document.body;
		const opts = {key: %s, code: %s, keyCode: %d, which: %d, bubbles: true, cancelable: true, ctrlKey: %v, altKey: %v, shiftKey: %v, metaKey: %v};
		target.dispatchEvent(new KeyboardEvent('keydown', opts));
		target.dispatchEvent(new KeyboardEvent('keypress', opts));
		target.dispatchEvent(new KeyboardEvent('keyup', opts));
		return {ok: true, target: target.tagName ? target.tagName.toLowerCase() : 'body'};
	})()`, jsString(key), jsString(code), kc, kc, ctrl, alt, shift, meta), nil
}

// splitCombo "ctrl+shift+t" → ["ctrl","shift","t"](小写化,容忍空段)。
func splitCombo(combo string) []string {
	var out []string
	for _, t := range strings.Split(strings.ToLower(strings.TrimSpace(combo)), "+") {
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}
