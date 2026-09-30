// agentconfig_test.go — 插件名归一匹配的回归守护:下载服务器产物一律
// grf- 前缀,bf0b642 全量改名时 matchPluginFile 曾被误改为 goder- 前缀,
// 导致所有官方插件在线安装报「找不到插件」。
package desktop

import "testing"

func TestMatchPluginFile(t *testing.T) {
	win := []string{"grf-browser.exe", "grf-computer.exe"}
	unix := []string{"grf-browser", "grf-computer"}
	cases := []struct {
		files []string
		name  string
		want  string // 空串 = 期望不匹配
	}{
		// 用户报障形态:Windows 目录页文件名带 .exe,原样传入
		{win, "grf-computer.exe", "grf-computer.exe"},
		{win, "grf-browser.exe", "grf-browser.exe"},
		// 裸名 / 带前缀名 / mac 无后缀目录,与 gh normPluginName 同语义
		{win, "computer", "grf-computer.exe"},
		{win, "grf-computer", "grf-computer.exe"},
		{unix, "grf-computer", "grf-computer"},
		{unix, "browser", "grf-browser"},
		// 大小写宽松
		{win, "GRF-Browser", "grf-browser.exe"},
		// 下载服务器没有 goder- 产物:goder-console 是本地 wrapper,不可安装
		{win, "goder-console", ""},
		{win, "goder-computer", ""},
		{win, "not-exist", ""},
	}
	for _, c := range cases {
		got, ok := matchPluginFile(c.files, c.name)
		if c.want == "" {
			if ok {
				t.Errorf("matchPluginFile(%q) 应不匹配,却命中 %q", c.name, got)
			}
			continue
		}
		if !ok || got != c.want {
			t.Errorf("matchPluginFile(%q) = %q,%v;want %q", c.name, got, ok, c.want)
		}
	}
}
