// tools.go — goder-console 工具面共享基座。三组工具按文件分拆注册:
// 面板浏览器 goder_browser_*(tools_browser.go)、终端面板
// goder_terminal_*(tools_terminal.go)、界面操作 goder_ui_*(tools_ui.go);
// 本文件只承载三组共用的 JSON Schema 构造器与工具参数解包帮助函数。
// goder-console 接入不变量:全部工具的中文展示名在前端
// shell/console-ui.ts 与接线同源注册(registry.chat.addToolMeta),
// Go 侧增改工具时两边同步。
package console

import (
	"encoding/json"
)

// ---------- JSON Schema 小构造器(与 gh 插件同风格) ----------

func obj(props map[string]any, required ...string) map[string]any {
	r := []any{}
	for _, n := range required {
		r = append(r, n)
	}
	// properties 为 nil 时必须序列化成 {} 而非 null:LM Studio 等严格
	// 校验的 OpenAI 兼容端会因 function.parameters.properties 为 null 报 400。
	if props == nil {
		props = map[string]any{}
	}
	return map[string]any{"type": "object", "properties": props, "required": r}
}

func pstr(desc string) map[string]any  { return map[string]any{"type": "string", "description": desc} }
func pbool(desc string) map[string]any { return map[string]any{"type": "boolean", "description": desc} }
func pnum(desc string) map[string]any  { return map[string]any{"type": "number", "description": desc} }

// ---------- 工具参数解包(三组工具共用) ----------

// decodeArgs 统一解包工具调用参数:失败即返回错误,由各 handler 严格
// 检查并以该工具的错误应答回给模型。旧样板是 `_ = json.Unmarshal`
// 把解包失败静默吞掉、零值继续跑,只会换来更迷惑的下游报错(如 ref
// 解不出来报「至少提供一个」)——统一为严格是行为改进:gh 按
// inputSchema 发参,类型错配/畸形 JSON 在正常路径不会出现,合法调用
// 不受影响。arguments 字段整体缺失(MCP 允许可选,RawMessage 为空)按
// 空对象处理:参数全可选的工具无参调用保持可用。
func decodeArgs(args json.RawMessage, v any) error {
	if len(args) == 0 {
		return nil
	}
	return json.Unmarshal(args, v)
}
