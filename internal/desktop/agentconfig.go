// agentconfig.go — AgentConfig 服务:智能体扩展(插件/MCP/技能)的读写。
// gh 的插件与 MCP 同源:settings.json 的 plugins 数组(command=本地 stdio
// 插件,url/token=远程 MCP 端点);技能是 ~/.grf/skills/<name>/SKILL.md 的
// 纯文件发现。settings.json 里没有 plugins 键时 gh 走自动发现
// (~/.grf/plugins/ 下全部可执行文件),因此"显式列表为空 + 自动模式"
// 保存时删除该键。DTO 与前端 host/bridge.ts 手工对齐。
package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
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

// SkillDTO 与前端 host/bridge.ts 的 SkillDTO 对齐。
type SkillDTO struct {
	Name        string `json:"name"` // 技能名(skills/ 下的目录名)
	Description string `json:"description"`
	Path        string `json:"path"` // SKILL.md 绝对路径(展示用)
	// Disabled:true = 已禁用(SKILL.md 改名为 SKILL.md.disabled,内容保留)
	Disabled bool `json:"disabled"`
}

// SkillsDTO 与前端 host/bridge.ts 的 SkillsDTO 对齐。
type SkillsDTO struct {
	Path     string     `json:"path"` // skills 目录绝对路径(展示用)
	Skills   []SkillDTO `json:"skills"`
	Writable bool       `json:"writable"`
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
		Writable:   (&ModelConfig{}).writable(path),
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
	// 自动发现:plugins/ 下非隐藏、带可执行位的常规文件(与 gh plugin/discover 同规则)
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			if e.IsDir() || strings.HasPrefix(e.Name(), ".") || strings.HasSuffix(e.Name(), ".md") {
				continue
			}
			if info, err := e.Info(); err == nil && info.Mode()&0o111 != 0 {
				out.Discovered = append(out.Discovered, e.Name())
			}
		}
		sort.Strings(out.Discovered)
	}
	return out
}

// PluginsSave 写回 plugins 键(其余键原样保留)。Explicit=false 时删除该键
// (回到自动发现模式);true 时写显式列表(可为空数组 = 不启用任何插件)。
func (a *AgentConfig) PluginsSave(dto PluginsDTO) error {
	path := grfSettingsPath()
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	all := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &all) // 损坏时按空文档处理,由本次写入修复
	}
	if !dto.Explicit {
		delete(all, "plugins")
	} else {
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
	}
	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

// skillsDir 解析技能目录。
func skillsDir() string {
	return filepath.Join(grfHome(), "skills")
}

// SkillsLoad 列出 ~/.grf/skills/<name>/SKILL.md(名称排序;含已禁用项)。
func (a *AgentConfig) SkillsLoad() SkillsDTO {
	dir := skillsDir()
	out := SkillsDTO{Path: dir, Skills: []SkillDTO{}, Writable: (&ModelConfig{}).writable(dir)}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range ents {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		md := filepath.Join(dir, e.Name(), "SKILL.md")
		disabled := false
		if _, err := os.Stat(md); err != nil {
			// SKILL.md 不存在:看是否被禁用(SKILL.md.disabled)
			if _, err2 := os.Stat(filepath.Join(dir, e.Name(), "SKILL.md.disabled")); err2 != nil {
				continue
			}
			md = filepath.Join(dir, e.Name(), "SKILL.md.disabled")
			disabled = true
		}
		raw, err := os.ReadFile(md)
		if err != nil {
			continue
		}
		out.Skills = append(out.Skills, SkillDTO{
			Name:        e.Name(),
			Description: skillDescription(string(raw)),
			Path:        md,
			Disabled:    disabled,
		})
	}
	sort.Slice(out.Skills, func(i, j int) bool { return out.Skills[i].Name < out.Skills[j].Name })
	return out
}

// skillDescription 提取技能描述:优先 YAML frontmatter 的 description:,
// 否则取正文首个非标题非空行(截断到 80 字)。
func skillDescription(md string) string {
	lines := strings.Split(md, "\n")
	inFront := false
	for _, ln := range lines {
		t := strings.TrimSpace(ln)
		if t == "---" && !inFront {
			inFront = true
			continue
		}
		if inFront {
			if t == "---" || t == "..." {
				inFront = false
			} else if v, ok := strings.CutPrefix(t, "description:"); ok {
				if s := strings.Trim(strings.TrimSpace(v), `"'`); s != "" {
					return truncateRunes(s, 80)
				}
			}
			continue
		}
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		return truncateRunes(t, 80)
	}
	return ""
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// SkillSetEnabled 启用/禁用技能:gh 只认 SKILL.md,禁用即改名
// SKILL.md.disabled(内容保留),启用改回。
func (a *AgentConfig) SkillSetEnabled(name string, enabled bool) error {
	if err := validSkillName(name); err != nil {
		return err
	}
	dir := filepath.Join(skillsDir(), name)
	on := filepath.Join(dir, "SKILL.md")
	off := filepath.Join(dir, "SKILL.md.disabled")
	if enabled {
		if _, err := os.Stat(off); err != nil {
			if _, err2 := os.Stat(on); err2 == nil {
				return nil // 已是启用态
			}
			return os.ErrNotExist
		}
		return os.Rename(off, on)
	}
	if _, err := os.Stat(on); err != nil {
		if _, err2 := os.Stat(off); err2 == nil {
			return nil // 已是禁用态
		}
		return os.ErrNotExist
	}
	return os.Rename(on, off)
}

// SkillGet 读取技能全文;目录穿越防护(禁止名字带路径分隔符)。
func (a *AgentConfig) SkillGet(name string) (string, error) {
	if err := validSkillName(name); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(skillsDir(), name, "SKILL.md"))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// SkillSave 新建/覆盖技能(建目录 + 写 SKILL.md)。
func (a *AgentConfig) SkillSave(name, content string) error {
	if err := validSkillName(name); err != nil {
		return err
	}
	dir := filepath.Join(skillsDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o600)
}

// SkillDelete 删除技能目录(SKILL.md 所在目录整体移除)。
func (a *AgentConfig) SkillDelete(name string) error {
	if err := validSkillName(name); err != nil {
		return err
	}
	dir := filepath.Join(skillsDir(), name)
	if _, err := os.Stat(dir); err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// validSkillName 技能名即目录名:非空且不含路径分隔符/向上引用。
func validSkillName(name string) error {
	if name == "" || strings.ContainsRune(name, '/') || strings.ContainsRune(name, '\\') || name == "." || name == ".." {
		return &skillNameError{name}
	}
	return nil
}

type skillNameError struct{ name string }

func (e *skillNameError) Error() string { return "非法技能名:" + e.name }

// ---------- 在线安装:gh 官方下载服务器 ----------
// 目录布局与 gh plugin/download.go 一致:{base}/{平台}/{版本}/plugins/,
// 技能沿用同级 skills/ 目录(服务器暂无产物时优雅提示为空)。

const defaultDownloadBase = "https://download.gorun.fun/grf-harness"

// builtinPlugins 内置插件,禁止删除(浏览器/电脑操作是 UI 核心能力)。
var builtinPlugins = map[string]bool{"grf-browser": true, "grf-computer": true}

func downloadBase() string {
	if v := strings.TrimSpace(os.Getenv("GRF_DOWNLOAD_BASE")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return defaultDownloadBase
}

var dirHrefRe = regexp.MustCompile(`<a href="([^"]+)"`)

// listDlDir 解析下载服务器的 nginx 目录列表;404 返回 (nil, false)。
func listDlDir(ctx context.Context, url string) ([]string, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, err
	}
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, false, err
	}
	var entries []string
	for _, m := range dirHrefRe.FindAllStringSubmatch(string(data), -1) {
		e := strings.TrimSuffix(m[1], "/")
		if e == "" || e == ".." || strings.HasPrefix(e, "?") || strings.HasPrefix(e, "/") {
			continue
		}
		entries = append(entries, e)
	}
	return entries, true, nil
}

// RemoteReleaseDTO 与前端 host/bridge.ts 的 RemoteReleaseDTO 对齐。
type RemoteReleaseDTO struct {
	Version string   `json:"version"`
	Files   []string `json:"files"`
}

// latestPluginsDir 取最新一个含 plugins/ 产物的版本目录;无产物返回 nil。
func latestPluginsDir(ctx context.Context) (*RemoteReleaseDTO, error) {
	dir, err := ghPlatformDir()
	if err != nil {
		return nil, err
	}
	base := downloadBase() + "/" + dir + "/"
	versions, ok, err := listDlDir(ctx, base)
	if err != nil || !ok {
		return nil, err
	}
	sort.Slice(versions, func(i, j int) bool { return cmpVersion(versions[i], versions[j]) > 0 })
	for _, v := range versions {
		files, ok, err := listDlDir(ctx, base+v+"/plugins/")
		if err != nil || !ok || len(files) == 0 {
			continue
		}
		sort.Strings(files)
		return &RemoteReleaseDTO{Version: v, Files: files}, nil
	}
	return nil, nil
}

// cmpVersion 简易 semver 比较(点分数值比较,非数值段按字符串)。
func cmpVersion(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		av, bv := "0", "0"
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		an, aerr := strconv.Atoi(av)
		bn, berr := strconv.Atoi(bv)
		if aerr == nil && berr == nil {
			if an != bn {
				if an > bn {
					return 1
				}
				return -1
			}
			continue
		}
		if c := strings.Compare(av, bv); c != 0 {
			return c
		}
	}
	return 0
}

// PluginRemoteList 官方服务器上当前平台可安装的插件文件列表。
func (a *AgentConfig) PluginRemoteList() (RemoteReleaseDTO, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	rel, err := latestPluginsDir(ctx)
	if err != nil {
		return RemoteReleaseDTO{}, err
	}
	if rel == nil {
		return RemoteReleaseDTO{Files: []string{}}, nil
	}
	return *rel, nil
}

// downloadFile 拉取远端文件并原子落盘(临时文件 + rename)。
func downloadFile(ctx context.Context, url, dst string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载 %s: HTTP %d", url, resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".grf-dl-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		_ = os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	mode := os.FileMode(0o755) // 插件需要可执行位;技能 md 同样无害
	if err := os.Chmod(name, mode); err != nil {
		_ = os.Remove(name)
		return err
	}
	return os.Rename(name, dst)
}

// matchPluginFile 宽松匹配下载服务器上的插件文件名(与 gh pick 一致):
// "browser"、"grf-browser"、"grf-browser.exe" 视为同一个。
func matchPluginFile(files []string, name string) (string, bool) {
	want := strings.TrimSuffix(strings.ToLower(name), ".exe")
	if !strings.HasPrefix(want, "grf-") {
		want = "grf-" + want
	}
	for _, f := range files {
		if strings.TrimSuffix(strings.ToLower(f), ".exe") == want {
			return f, true
		}
	}
	return "", false
}

// PluginInstall 从官方服务器安装插件到 ~/.grf/plugins/,并在显式列表
// 模式下把它加入 plugins 键(自动发现模式落盘即接入)。
func (a *AgentConfig) PluginInstall(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	rel, err := latestPluginsDir(ctx)
	if err != nil {
		return err
	}
	if rel == nil {
		return fmt.Errorf("下载服务器上没有当前平台的插件产物")
	}
	file, ok := matchPluginFile(rel.Files, name)
	if !ok {
		return fmt.Errorf("找不到插件 %s(可用:%s)", name, strings.Join(rel.Files, "、"))
	}
	dir, _ := ghPlatformDir()
	url := fmt.Sprintf("%s/%s/%s/plugins/%s", downloadBase(), dir, rel.Version, file)
	dst := filepath.Join(grfHome(), "plugins", file)
	if err := downloadFile(ctx, url, dst); err != nil {
		return err
	}
	// 显式列表模式:同步追加 plugins 键,否则要等用户手动改
	cur := a.PluginsLoad()
	if cur.Explicit {
		trimmed := strings.TrimSuffix(file, ".exe")
		if !containsPlugin(cur.Plugins, trimmed) {
			cur.Plugins = append(cur.Plugins, PluginDTO{
				Name:    trimmed,
				Command: []string{dst},
			})
			if err := a.PluginsSave(cur); err != nil {
				return err
			}
		}
	}
	return nil
}

func containsPlugin(list []PluginDTO, name string) bool {
	for _, p := range list {
		if p.Name == name {
			return true
		}
	}
	return false
}

// PluginDelete 删除插件:内置插件(浏览器/电脑操作)拒绝;显式列表摘项 +
// 删除自动发现目录里的文件。
func (a *AgentConfig) PluginDelete(name string) error {
	low := strings.TrimSuffix(strings.ToLower(name), ".exe")
	if builtinPlugins[low] {
		return fmt.Errorf("内置插件 %s 不可删除", low)
	}
	// 摘显式列表项
	cur := a.PluginsLoad()
	if cur.Explicit && containsPlugin(cur.Plugins, name) {
		out := cur.Plugins[:0]
		for _, p := range cur.Plugins {
			if p.Name != name {
				out = append(out, p)
			}
		}
		cur.Plugins = out
		if err := a.PluginsSave(cur); err != nil {
			return err
		}
	}
	// 删目录里的文件(存在才删)
	removed := false
	dir := filepath.Join(grfHome(), "plugins")
	for _, suffix := range []string{"", ".exe"} {
		p := filepath.Join(dir, name+suffix)
		if _, err := os.Stat(p); err == nil {
			if err := os.Remove(p); err != nil {
				return err
			}
			removed = true
		}
	}
	if !removed && !cur.Explicit {
		return fmt.Errorf("插件 %s 不存在", name)
	}
	return nil
}

// SkillRemoteList 官方服务器 skills/ 目录的可安装技能(暂无产物返回空)。
func (a *AgentConfig) SkillRemoteList() (RemoteReleaseDTO, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	out := RemoteReleaseDTO{Files: []string{}}
	dir, err := ghPlatformDir()
	if err != nil {
		return out, err
	}
	base := downloadBase() + "/" + dir + "/"
	versions, ok, err := listDlDir(ctx, base)
	if err != nil || !ok {
		return out, err
	}
	sort.Slice(versions, func(i, j int) bool { return cmpVersion(versions[i], versions[j]) > 0 })
	for _, v := range versions {
		files, ok, err := listDlDir(ctx, base+v+"/skills/")
		if err != nil || !ok {
			continue
		}
		var mds []string
		for _, f := range files {
			if strings.HasSuffix(f, ".md") {
				mds = append(mds, f)
			}
		}
		if len(mds) > 0 {
			sort.Strings(mds)
			out = RemoteReleaseDTO{Version: v, Files: mds}
		}
		return out, nil
	}
	return out, nil
}

// SkillInstall 从官方服务器安装技能(x.md → ~/.grf/skills/<去后缀>/SKILL.md)。
func (a *AgentConfig) SkillInstall(file string) error {
	if !strings.HasSuffix(file, ".md") {
		return fmt.Errorf("技能产物应为 .md 文件")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	rel, err := a.SkillRemoteList()
	if err != nil {
		return err
	}
	if rel.Version == "" {
		return fmt.Errorf("下载服务器上暂无可安装技能")
	}
	found := false
	for _, f := range rel.Files {
		if f == file {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("找不到技能 %s", file)
	}
	dir, _ := ghPlatformDir()
	url := fmt.Sprintf("%s/%s/%s/skills/%s", downloadBase(), dir, rel.Version, file)
	name := strings.TrimSuffix(file, ".md")
	if err := validSkillName(name); err != nil {
		return err
	}
	dst := filepath.Join(skillsDir(), name, "SKILL.md")
	return downloadFile(ctx, url, dst)
}

// SkillInstallFromURL 从任意 URL 拉取 SKILL.md 安装为技能(在线获取的自定义入口)。
func (a *AgentConfig) SkillInstallFromURL(name, url string) error {
	if err := validSkillName(name); err != nil {
		return err
	}
	if !strings.HasPrefix(strings.ToLower(url), "http") {
		return fmt.Errorf("非法 URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dst := filepath.Join(skillsDir(), name, "SKILL.md")
	return downloadFile(ctx, url, dst)
}
