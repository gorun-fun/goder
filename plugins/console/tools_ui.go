// tools_ui.go — goder-console 工具面之三:界面操作 goder_ui_* 共 2 个
// 工具(读界面状态 goder_ui_state / 驱动界面动作 goder_ui_do)。界面操作
// 经 wails 事件下发到前端,实际执行在 shell/console-ui.ts 的动作映射。
// goder-console 接入不变量:全部工具的中文展示名在前端
// shell/console-ui.ts 与接线同源注册(registry.chat.addToolMeta),
// Go 侧本文件增改工具时两边同步。
package console

import (
	"encoding/json"
	"strings"
)

// uiActions 界面操作白名单:Go 侧只校验 action 名与透传参数,实际执行
// 在前端(shell/console-ui.ts)。
var uiActions = map[string]string{
	"nav_activate":      "切换左栏导航(id:sessions/settings 等注册条目)",
	"side_tab_open":     "打开右栏 tab(defId:browser/terminal/file/review…;file 需 key=路径、title)",
	"side_tab_activate": "激活已打开的右栏 tab(id 形如 defId 或 defId:key)",
	"show_sidebar":      "展开/收起右栏(on: true/false)",
	"show_bottom":       "展开/收起底栏(on)",
	"show_sessions":     "展开/收起左栏(on)",
	"open_file":         "在右栏打开文件预览(path 必填;name/rel 可选)",
	"open_browser":      "在右栏浏览器面板打开 URL(url)",
	"focus_session":     "切换当前会话(id 为会话标识)",
}

// ---------- 界面操作工具 ----------

func (s *Server) registerUITools() {
	s.add(Tool{
		Name:        "goder_ui_state",
		Description: "读取 goder 界面当前状态(导航区/右栏 tab/底栏/当前会话等,前端周期上报)。定位上下文用。",
		Schema:      obj(nil), ReadOnly: true,
		Handler: func(s *Server, _ json.RawMessage) ([]Content, bool) {
			st := s.UIState()
			if st == "" {
				return textOk("(界面状态尚未上报:前端窗口可能未聚焦/未连接)")
			}
			return textOk("%s", st)
		},
	})

	s.add(Tool{
		Name: "goder_ui_do",
		Description: "驱动 goder 界面本身:切换导航、打开右栏 tab(浏览器/终端/文件)、展开底栏、打开文件、切换会话。" +
			"可用 action:" + uiActionHelp(),
		Schema: obj(map[string]any{
			"action": map[string]any{"type": "string", "enum": uiActionNames(), "description": "操作名"},
			"params": map[string]any{"type": "object", "description": "操作参数(action 相关,见 description)"},
		}, "action"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Action string         `json:"action"`
				Params map[string]any `json:"params"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			desc, ok := uiActions[a.Action]
			if !ok {
				return textErr("未知 action %q(可用:%s)", a.Action, uiActionHelp())
			}
			if a.Params == nil {
				a.Params = map[string]any{}
			}
			s.emitUI(a.Action, a.Params)
			return textOk("已下发界面指令 %s(%s)。生效需前端响应(通常 <100ms),可用 goder_ui_state 复核。", a.Action, desc)
		},
	})
}

func uiActionNames() []string {
	names := make([]string, 0, len(uiActions))
	for n := range uiActions {
		names = append(names, n)
	}
	// 保持稳定序(枚举值进 JSON Schema)
	for i := 1; i < len(names); i++ {
		for j := i; j > 0 && names[j] < names[j-1]; j-- {
			names[j], names[j-1] = names[j-1], names[j]
		}
	}
	return names
}

func uiActionHelp() string {
	var parts []string
	for _, n := range uiActionNames() {
		parts = append(parts, n+"("+uiActions[n]+")")
	}
	return strings.Join(parts, "; ")
}
