// tools_terminal.go — goder-console 工具面之二:终端面板
// goder_terminal_* 共 5 个工具(列出/新建/写入/增量读缓冲/终止)。
// 终端工具操作的是「用户看得见的终端面板」——输入与输出实时显示在
// 终端 tab 里,适合需要人工围观的长任务;静默执行命令用 gh 内置终端
// 工具即可。goder-console 接入不变量:全部工具的中文展示名在前端
// shell/console-ui.ts 与接线同源注册(registry.chat.addToolMeta),
// Go 侧本文件增改工具时两边同步。
package console

import (
	"encoding/json"
	"fmt"
	"strings"
)

// unescapeTermText 还原客户端把换行等控制字符按字面转义传入的情况:
// 工具描述里的「以 \n 结尾」常被部分模型/客户端原样写成反斜杠+n 两个
// 字符,打进终端的字面 "\n" 只会被回显、命令永远不执行。规则:
//   - 文本已含真实换行/回车/制表符:说明转义链路正常,原样透传;
//   - 否则且以字面 "\n" 结尾(典型:整条命令 + 字面换行)或整个就是
//     字面 "\x03"(Ctrl+C):把文本中的字面 \n \r \t \xHH \\ 还原为真实字符;
//   - 其余情况(不含字面换行,如 printf 'a\tb' 之类正当字面用法)不动。
func unescapeTermText(s string) string {
	if strings.ContainsAny(s, "\n\r\t") || (s != `\x03` && !strings.HasSuffix(s, `\n`)) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' || i+1 >= len(s) {
			b.WriteByte(c)
			continue
		}
		switch n := s[i+1]; n {
		case 'n':
			b.WriteByte('\n')
			i++
		case 'r':
			b.WriteByte('\r')
			i++
		case 't':
			b.WriteByte('\t')
			i++
		case '\\':
			b.WriteByte('\\')
			i++
		case 'x':
			if i+3 < len(s) && isHexByte(s[i+2]) && isHexByte(s[i+3]) {
				b.WriteByte(hexVal(s[i+2])<<4 | hexVal(s[i+3]))
				i += 3
			} else {
				b.WriteByte(c)
			}
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func isHexByte(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

const termDesc = "操作 goder 界面的终端面板(用户可见:输入与输出实时显示在终端 tab 里)。" +
	"适合需要人工围观的长任务(构建/测试/dev server);静默执行命令用内置终端工具即可,不必占面板。"

// ---------- 终端面板工具 ----------

func (s *Server) registerTerminalTools() {
	s.add(Tool{
		Name:        "goder_terminal_list",
		Description: termDesc + "列出全部终端会话(id/工作目录/存活态;刚退出的会话最终输出仍可读)。",
		Schema:      obj(nil), ReadOnly: true,
		Handler: func(s *Server, _ json.RawMessage) ([]Content, bool) {
			list := s.deps.Terminal.ListTerms()
			if len(list) == 0 {
				return textOk("(暂无终端会话,可用 goder_terminal_new 新建)")
			}
			var lines []string
			for _, t := range list {
				state := "运行中"
				if !t.Alive {
					state = "已退出"
				}
				lines = append(lines, fmt.Sprintf("%s  %s  (%s)", t.ID, t.Cwd, state))
			}
			return textOk("%s", strings.Join(lines, "\n"))
		},
	})

	s.add(Tool{
		Name:        "goder_terminal_new",
		Description: termDesc + "新建一个交互 shell 会话并打开界面终端 tab(用户可接管输入)。返回会话 id。",
		Schema: obj(map[string]any{
			"cwd": pstr("工作目录绝对路径(缺省用户主目录;须存在)"),
		}),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				Cwd string `json:"cwd"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			// 界面上已挂载存活终端:直接复用——输入实时显示在面板,用户
			// 可围观/接管,也避免会话增殖(新建的会话若组件正忙不会显示)。
			// 复用也发 terminal_open(幂等):保证被复用的会话一定有
			// 面板在显示——前端上报的 terminals 可能陈旧,复用一个无
			// 面板的会话会让输入落入谁也看不见的暗终端。
			if id := s.pickVisibleTerm(); id != "" {
				s.emitUI("terminal_open", map[string]any{"id": id})
				return textOk("复用界面现有终端会话 %s(已确保终端 tab 打开;输入实时显示在终端面板)。goder_terminal_send 发命令(以 \\n 结尾),goder_terminal_read 读输出。", id)
			}
			id, err := s.deps.Terminal.NewTerm(a.Cwd)
			if err != nil {
				return textErr("新建终端失败: %v", err)
			}
			s.emitUI("terminal_open", map[string]any{"id": id})
			return textOk("已新建终端 %s(界面已打开终端 tab;cwd=%s)。goder_terminal_send 发命令(以 \\n 结尾),goder_terminal_read 读输出。", id, a.Cwd)
		},
	})

	s.add(Tool{
		Name:        "goder_terminal_send",
		Description: termDesc + "向会话写入输入(键入即回显在面板)。命令须以真实换行符结尾才会执行(工具参数里传 JSON \"\\n\");交互程序照常响应。若客户端把 \\n 转义成字面反斜杠+n 传入,服务端会自动还原,不必手工处理。",
		Schema: obj(map[string]any{
			"id":   pstr("会话 id(goder_terminal_list/new 的返回值)"),
			"text": pstr("要写入的文本(命令 + 换行;Ctrl+C 写 \\x03)"),
		}, "id", "text"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				ID   string `json:"id"`
				Text string `json:"text"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			if err := s.deps.Terminal.WriteTerm(a.ID, unescapeTermText(a.Text)); err != nil {
				return textErr("%v(可用 goder_terminal_list 核对 id)", err)
			}
			return textOk("已写入。稍候用 goder_terminal_read 读取输出")
		},
	})

	s.add(Tool{
		Name:        "goder_terminal_read",
		Description: termDesc + "增量读取会话输出(From 传上次返回的 To,首次省略/传 0)。会话退出后仍可读缓冲里的最终输出。",
		Schema: obj(map[string]any{
			"id":   pstr("会话 id"),
			"from": pnum("上次读到的字节序号 To(缺省 0 = 从缓冲起点)"),
		}, "id"),
		ReadOnly: true,
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				ID   string `json:"id"`
				From int64  `json:"from"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			r, err := s.deps.Terminal.ReadTerm(a.ID, a.From)
			if err != nil {
				return textErr("%v", err)
			}
			if len(r.Data) == 0 {
				return textOk("(暂无新输出,游标 to=%d)", r.To)
			}
			return textOk("%s\n[游标 to=%d,下次 from 传它]", string(r.Data), r.To)
		},
	})

	s.add(Tool{
		Name:        "goder_terminal_kill",
		Description: termDesc + "终止会话(dev server 之类的常驻进程收尾用;已退出视为成功)。",
		Schema:      obj(map[string]any{"id": pstr("会话 id")}, "id"),
		Handler: func(s *Server, args json.RawMessage) ([]Content, bool) {
			var a struct {
				ID string `json:"id"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return textErr("参数解析失败: %v", err)
			}
			if err := s.deps.Terminal.KillTerm(a.ID); err != nil {
				return textErr("%v", err)
			}
			return textOk("已终止 %s", a.ID)
		},
	})
}

// pickVisibleTerm 从前端上报的界面状态里找挂载中且存活的终端会话;
// 无上报或全部已死返回空串。
func (s *Server) pickVisibleTerm() string {
	st := s.UIState()
	if st == "" {
		return ""
	}
	var snap struct {
		Terminals []string `json:"terminals"`
	}
	if err := json.Unmarshal([]byte(st), &snap); err != nil || len(snap.Terminals) == 0 {
		return ""
	}
	alive := map[string]bool{}
	for _, t := range s.deps.Terminal.ListTerms() {
		if t.Alive {
			alive[t.ID] = true
		}
	}
	for _, id := range snap.Terminals {
		if alive[id] {
			return id
		}
	}
	return ""
}
