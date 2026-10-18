// dlserver.go — 下载服务器(download.gorun.fun)客户端:目录列表解析、
// 版本择新、文件下载与落盘。三类使用方共用:gh 引导下载(ghdownload.go)、
// goder 自更新(updater.go)、插件/技能在线安装(AgentConfig 的 Remote/
// Install 面,从 agentconfig.go 迁入)。基地址按产品各一份:ghDlBase
// (grf-harness,插件/技能产物也在其下)与 updater 的 goderDlBase;
// GODER_DOWNLOAD_BASE 环境变量只覆盖插件/技能安装面(开发联调换源),
// 不影响 gh 引导与自更新的发布通道。
package desktop

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// versionEntryRe 版本形态的目录条目(v 前缀可选,如 0.0.1-alpha.14、v1.2.3);
// 目录列表里非版本形态的杂项(README 等)不参与择新。
var versionEntryRe = regexp.MustCompile(`^v?[0-9][^/]*$`)

// latestDlVersion 抓下载服务器目录列表页(静态 HTML),取当前平台最大
// 版本目录(gh 与 goder 共用;目录结构 {base}/{平台}/{版本}/)。与
// listDlDir 同一套 HTML 解析,只认版本形态的条目、按 compareVersion 择新
// (版本语义见 version.go 头注释:正式版 > 同基线预发布,不要换 sort -V)。
func latestDlVersion(base string) (string, error) {
	dir, err := ghPlatformDir()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	entries, ok, err := listDlDir(ctx, base+"/"+dir+"/")
	if err != nil {
		return "", fmt.Errorf("访问下载服务器失败: %w", err)
	}
	if !ok {
		return "", fmt.Errorf("下载服务器返回 404")
	}
	best := ""
	for _, e := range entries {
		if !versionEntryRe.MatchString(e) {
			continue
		}
		if best == "" || compareVersion(e, best) > 0 {
			best = e
		}
	}
	if best == "" {
		return "", fmt.Errorf("下载服务器目录页无版本条目")
	}
	return best, nil
}

// ---------- 在线安装:插件与技能产物 ----------

// builtinPlugins 内置插件,禁止删除(浏览器/电脑操作是 UI 核心能力;
// goder-console 是智能体驱动面板浏览器/终端/界面的自带控制面,每次
// 启动会自动重装 wrapper)。
var builtinPlugins = map[string]bool{"grf-browser": true, "grf-computer": true, "goder-console": true}

// downloadBase 插件/技能安装面的下载基地址:默认与 gh 产物同源(ghDlBase),
// GODER_DOWNLOAD_BASE 可换源(仅此面,见文件头注释)。
func downloadBase() string {
	if v := strings.TrimSpace(os.Getenv("GODER_DOWNLOAD_BASE")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return ghDlBase
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
	sort.Slice(versions, func(i, j int) bool { return compareVersion(versions[i], versions[j]) > 0 })
	for _, v := range versions {
		files, ok, err := listDlDir(ctx, base+v+"/plugins/")
		if err != nil || !ok || len(files) == 0 {
			continue
		}
		// CI publish 随产物在 plugins/ 子目录生成 SHA256SUMS 完整性清单
		// (gh 0.0.1-alpha.29+,selfupdate 按同目录清单校验):不是插件产物,
		// 不能进可安装列表(技能侧只收 .md 天然不受影响)。
		filtered := files[:0:0]
		for _, f := range files {
			if isDlManifest(f) {
				continue
			}
			filtered = append(filtered, f)
		}
		if len(filtered) == 0 {
			continue
		}
		sort.Strings(filtered)
		return &RemoteReleaseDTO{Version: v, Files: filtered}, nil
	}
	return nil, nil
}

// isDlManifest 下载服务器目录里的完整性清单文件(非产物):sha256sum
// 标准名 SHA256SUMS,及可能的 .sha256 变体。
func isDlManifest(name string) bool {
	return name == "SHA256SUMS" || strings.HasSuffix(name, ".sha256")
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
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".goder-dl-*")
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
	// 覆盖已存在的旧插件时,Windows 上目标可能仍被运行中的插件进程占用
	// (替换被占用 exe 报 Access is denied):走 installDownload(挪唯一
	// .old + 短重试),与 gh 更新同一条路径。
	return installDownload(name, dst)
}

// matchPluginFile 宽松匹配下载服务器上的插件文件名(与 gh 的
// normPluginName 同语义):"browser"、"grf-browser"、"grf-browser.exe"
// 视为同一个。插件产物是 gh 生态的下载服务器发布的,一律 grf- 前缀,
// 不随本程序命名(不要把前缀改成 goder-)。
func matchPluginFile(files []string, name string) (string, bool) {
	want := normPluginName(name)
	for _, f := range files {
		if normPluginName(f) == want {
			return f, true
		}
	}
	return "", false
}

// normPluginName 插件名归一:去 grf- 前缀与 .exe 后缀(小写),与
// grf-harness plugin/download.go 的 normPluginName 同语义。
func normPluginName(s string) string {
	s = strings.ToLower(s)
	s = strings.TrimPrefix(s, "grf-")
	return strings.TrimSuffix(s, ".exe")
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
	sort.Slice(versions, func(i, j int) bool { return compareVersion(versions[i], versions[j]) > 0 })
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
