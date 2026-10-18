// agentconfig.go — AgentConfig 服务:gh 智能体扩展配置的读写入口。
// gh 的插件与 MCP 同源:settings.json 的 plugins 数组(command=本地 stdio
// 插件,url/token=远程 MCP 端点);技能面在 agentskills.go,插件/技能的
// 在线安装与下载服务器客户端在 dlserver.go。settings.json 里没有
// plugins 键时 gh 走自动发现(~/.grf/plugins/ 下全部可执行文件),因此
// 「显式列表为空 + 自动模式」保存时删除该键。DTO 与前端 host/bridge.ts
// 手工对齐。
package desktop

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"git.gorun.fun/share/goder/internal/grfsettings"
)

// PluginDTO 与前端 host/bridge.ts 的 PluginDTO 对齐(settings.json plugins 项)。
type PluginDTO struct {
	Name    string   `json:"name"`
	Command []string `json:"command"` // 本地 stdio:可执行文件 + 参数
	URL     string   `json:"url"`     // 远程 MCP:Streamable HTTP 端点
	Token   string   `json:"token"`   // 远程 MCP:Bearer token
	Timeout int      `json:"timeout"` // 工具调用超时秒数;0 = 默认
}

// PluginsDTO 与前端 host/bridge.ts 的 PluginsDTO 对齐。
type PluginsDTO struct {
	Path string `json:"path"` // settings.json 绝对路径(展示用)
	Dir  string `json:"dir"`  // 自动发现目录(~/.grf/plugins)绝对路径
	// Explicit:true = settings.json 写了 plugins 键(仅用列出的插件);
	// false = 自动发现模式(~/.grf/plugins/ 全部可执行文件)
	Explicit   bool        `json:"explicit"`
	Plugins    []PluginDTO `json:"plugins"`
	Discovered []string    `json:"discovered"` // 自动发现目录下的可执行文件名
	Writable   bool        `json:"writable"`
}

// AgentConfig wails 服务。
type AgentConfig struct{}

// grfHome 解析 gh 配置目录(GRF_HOME 优先,默认 ~/.grf)。
func grfHome() string {
	if h := strings.TrimSpace(os.Getenv("GRF_HOME")); h != "" {
		return h
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".grf"
	}
	return filepath.Join(home, ".grf")
}

// PluginsLoad 读取 settings.json 的 plugins 数组与自动发现目录。
func (a *AgentConfig) PluginsLoad() PluginsDTO {
	path := grfSettingsPath()
	dir := filepath.Join(grfHome(), "plugins")
	out := PluginsDTO{
		Path:       path,
		Dir:        dir,
		Plugins:    []PluginDTO{},
		Discovered: []string{},
		Writable:   settingsWritable(path),
	}
	if raw, err := os.ReadFile(path); err == nil {
		var all map[string]json.RawMessage
		if json.Unmarshal(raw, &all) == nil {
			if v, ok := all["plugins"]; ok {
				out.Explicit = true
				_ = json.Unmarshal(v, &out.Plugins)
			}
		}
	}
	// 自动发现:plugins/ 下非隐藏、可执行的常规文件(与 gh plugin/discover
	// 同规则,见 isExecutableFile);.old* 是更新挪出的旧副本,不算插件
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			if e.IsDir() || strings.HasPrefix(e.Name(), ".") || strings.HasSuffix(e.Name(), ".md") || isStaleOldName(e.Name()) {
				continue
			}
			if info, err := e.Info(); err == nil && isExecutableFile(e.Name(), info.Mode()) {
				out.Discovered = append(out.Discovered, e.Name())
			}
		}
		sort.Strings(out.Discovered)
	}
	return out
}

// isExecutableFile 判断 plugins/ 目录里的文件是否视为可执行插件。
// Windows 没有 POSIX 可执行位:Go 把普通文件统一报成 0666(只读 0444),
// os.Chmod 也只切换只读属性,按位过滤恒为空 —— 改按可执行后缀判定。
// grf-harness 的 plugin/discover.go 有同规则副本,两边必须同步改。
func isExecutableFile(name string, mode os.FileMode) bool {
	if runtime.GOOS == "windows" {
		switch strings.ToLower(filepath.Ext(name)) {
		case ".exe", ".bat", ".cmd", ".com", ".ps1":
			return true
		}
		return false
	}
	return mode.IsRegular() && mode.Perm()&0o111 != 0
}

// isStaleOldName 更新落盘时挪出的旧副本名(x.old / x.old.2…):仍被占用
// 没清掉时会短暂留在目录里,不应被当作插件发现或同步对象。
func isStaleOldName(name string) bool {
	return strings.HasSuffix(name, ".old") || strings.Contains(name, ".old.")
}

// PluginsSave 写回 plugins 键(其余键原样保留)。Explicit=false 时删除该键
// (回到自动发现模式);true 时写显式列表(可为空数组 = 不启用任何插件)。
// 走 grfsettings 原子事务:与启动期 goder-console 烙写、模型设置保存
// 串行化,写盘中途被杀不损坏既有配置。
func (a *AgentConfig) PluginsSave(dto PluginsDTO) error {
	return grfsettings.Update(grfSettingsPath(), func(all map[string]json.RawMessage, _ bool) error {
		if !dto.Explicit {
			delete(all, "plugins")
			return nil
		}
		list := make([]PluginDTO, 0, len(dto.Plugins))
		for _, p := range dto.Plugins {
			if strings.TrimSpace(p.Name) == "" && strings.TrimSpace(p.URL) == "" && len(p.Command) == 0 {
				continue
			}
			p.Name = strings.TrimSpace(p.Name)
			p.URL = strings.TrimSpace(p.URL)
			p.Token = strings.TrimSpace(p.Token)
			cmd := make([]string, 0, len(p.Command))
			for _, c := range p.Command {
				if s := strings.TrimSpace(c); s != "" {
					cmd = append(cmd, s)
				}
			}
			p.Command = cmd
			list = append(list, p)
		}
		raw, err := json.Marshal(list)
		if err != nil {
			return err
		}
		all["plugins"] = raw
		return nil
	})
}
