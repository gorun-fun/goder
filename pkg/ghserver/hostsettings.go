// hostsettings.go — 宿主管理面的域逻辑:托管供应商声明、裸名模型解析、
// 宿主 stdio 插件安装、会话索引存储。全部自 openos 侧上移(此前 openos 直写
// goder 私有的 settings.json / serve-data 布局,靠注释纪律与 goder 锁步)。
//
// 平台侧状态统一落在 users/<san>/platform/(与 gh 感知的 server-data、
// grf-home 并列,gh 不读取):managed-providers.json(受管供应商名清单,
// 代理层 managed:true 注入用)、plugins/<name>.json(宿主插件规格,含原始
// uid——目录名清洗不可逆,存量自愈不再靠解析 wrapper 内容反抠)、index.json
// (会话分组索引,goder.js ProjectsIndex 形状的宿主镜像)。
package ghserver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorun-fun/goder/internal/grfsettings"
)

// ---- 目录约定 ----

// platformDir 用户平台状态目录(users/<san>/platform)。
func platformDir(userRoot string) string { return filepath.Join(userRoot, "platform") }

// ---- 托管供应商声明 ----

// ProviderEntry 一次声明的一个受管供应商条目(写入 gh settings.json 的
// providers.<name>,键形状 base_url/api_key/models 与 gh config.Provider 一致)。
type ProviderEntry struct {
	Name    string   `json:"name"`
	BaseURL string   `json:"base_url"`
	APIKey  string   `json:"api_key"`
	Models  []string `json:"models"`
}

func (e ProviderEntry) valid() bool {
	return e.Name != "" && e.BaseURL != "" && e.APIKey != "" && len(e.Models) > 0
}

// ProvidersDecl 一次声明(PUT /admin/users/{uid}/providers 请求体)。
// Entries 由调用方合成(平台托管条目 + 宿主按用户声明条目);Managed 是
// 受管名字全集(含历史声明过、本次未声明的——用于清理残留);Default 是
// 期望默认模型全限定名(provider/model,空 = 无受管默认候选)。
type ProvidersDecl struct {
	Entries []ProviderEntry `json:"entries"`
	Managed []string        `json:"managed"`
	Default string          `json:"default"`
	// ForceDefault true = 无条件写 default(管理员保存/宿主声明后);false =
	// 只在现 default 为空或本就指向受管条目时写——不打架用户在 goder 里
	// 自选的默认模型。
	ForceDefault bool `json:"force_default"`
}

// UpsertProviders 把一次声明应用到一个 settings.json(语义与 openos 时代的
// upsertAIProviders 逐条对齐):map[string]json.RawMessage 保真未知键;受管
// 名字内、本次未有效声明的条目被清除(声明外名字不碰);内容不变不写盘
// (不惊动 mtime,gh 热跟随指纹与安装指纹都不失效);文件不存在时以空白
// 配置起播(赶在 goder-serve 播种与 gh 首启之前,首启即读到正确配置),
// 损坏文件不碰。返回是否写盘。
func UpsertProviders(settingsPath string, decl ProvidersDecl) (bool, error) {
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		raw = nil // 无文件 = 该用户尚未打开过 goder:空白起播而非跳过
	}
	var all map[string]json.RawMessage
	if raw != nil {
		if err := json.Unmarshal(raw, &all); err != nil {
			return false, nil // 损坏文件不碰(留待 gh/设置页的修复语义)
		}
	}
	if all == nil {
		all = map[string]json.RawMessage{}
	}

	provs := all["providers"]
	var providers map[string]json.RawMessage
	if len(provs) > 0 && string(provs) != "null" {
		if err := json.Unmarshal(provs, &providers); err != nil {
			return false, err
		}
	}
	if providers == nil {
		providers = map[string]json.RawMessage{}
	}

	curDefault := ""
	if d, ok := all["default"]; ok {
		_ = json.Unmarshal(d, &curDefault)
	}

	managedSet := map[string]bool{}
	for _, n := range decl.Managed {
		if n != "" {
			managedSet[n] = true
		}
	}

	// 本次有效声明的条目 upsert;受管名字内的其余条目(无效声明/未声明)清除
	declared := map[string]bool{}
	for _, e := range decl.Entries {
		if !e.valid() || !managedSet[e.Name] {
			continue // 无效条目按「未声明」处理(走下方清理),声明外名字不碰
		}
		entry, err := json.Marshal(map[string]any{
			"base_url": e.BaseURL,
			"api_key":  e.APIKey,
			"models":   e.Models,
		})
		if err != nil {
			return false, err
		}
		providers[e.Name] = entry
		declared[e.Name] = true
	}
	for name := range providers {
		if managedSet[name] && !declared[name] {
			delete(providers, name)
		}
	}

	// 默认模型决策链:force / 现 default 为空 / 现 default 本就指向受管条目
	curManaged := managedSet[strings.SplitN(curDefault, "/", 2)[0]]
	if decl.Default != "" {
		if decl.ForceDefault || curDefault == "" || curManaged {
			b, _ := json.Marshal(decl.Default)
			all["default"] = b
		}
	} else if curManaged {
		// 无候选默认:指向受管条目的 default 随条目清除(gh 回落内置默认)
		delete(all, "default")
	}

	if len(providers) == 0 {
		delete(all, "providers") // 本就无供应商的文件不引入空键
	} else {
		b, err := json.Marshal(providers)
		if err != nil {
			return false, err
		}
		all["providers"] = b
	}
	// 无原文件且渲染后既无供应商也无默认模型:不值得起播(避免为空白配置建文件)
	if raw == nil && len(providers) == 0 {
		if d, ok := all["default"]; !ok || string(d) == `""` {
			return false, nil
		}
	}
	out, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return false, err
	}
	out = append(out, '\n')
	if raw != nil && string(out) == string(raw) {
		return false, nil // 内容未变不写
	}
	if raw == nil { // 起播:用户目录可能尚未建立(从未打开过 goder)
		if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
			return false, err
		}
	}
	return true, writeFileAtomic(settingsPath, out)
}

// writeFileAtomic 原子落盘(同目录随机后缀临时文件 + rename):gh 在回合
// 边界热跟随 settings.json,撕裂读会解析失败甚至触发按空文档的损坏自愈;
// 随机后缀防与 gh WriteFileAtomic / 桌面 grfsettings 的临时文件互踩。
func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".ghs-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name) // rename 成功后为 no-op,失败/写坏时清残件
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path) // CreateTemp 恒 0600,与既有写入权限一致
}

// ---- 裸名模型解析 ----

// ResolveResult GET /admin/users/{uid}/resolve-model 的结构化结果。
// Status:ok(解析成功,Resolved 为全限定名)/ no_default(空名且未配置默认)/
// not_found(不在可用清单)/ ambiguous(多家供应商同名命中,Candidates 有序
// 列出)/ unreadable(配置缺失或损坏)。错误文案由调用方(宿主)按自己的
// 语言习惯合成——这里只给机器可判定的语义。择序与 gh config.ResolveModel
// 对齐:默认供应商优先 → 恰一家命中;多家歧义不武断挑选。
type ResolveResult struct {
	Status     string   `json:"status"`
	Resolved   string   `json:"resolved,omitempty"`
	Candidates []string `json:"candidates,omitempty"`
}

// ResolveModelName 对某用户的 settings.json 解析请求模型(裸名或全限定名;
// 空 = 取默认)。fail-fast 语义(歧义/未含如实上报,绝不静默换路由)由
// 调用方消费——gh 运行时的 best-effort 解析(歧义沿用当前)与此互补。
func ResolveModelName(settingsPath, want string) ResolveResult {
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		return ResolveResult{Status: "unreadable"}
	}
	var cfg struct {
		Providers map[string]struct {
			Models []string `json:"models"`
		} `json:"providers"`
		Default string `json:"default"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return ResolveResult{Status: "unreadable"}
	}
	names := make([]string, 0, len(cfg.Providers))
	for n := range cfg.Providers {
		names = append(names, n)
	}
	sort.Strings(names)
	has := func(provider, model string) bool {
		p, ok := cfg.Providers[provider]
		if !ok {
			return false
		}
		for _, m := range p.Models {
			if m == model {
				return true
			}
		}
		return false
	}
	switch {
	case want == "":
		if cfg.Default == "" {
			return ResolveResult{Status: "no_default"}
		}
		return ResolveResult{Status: "ok", Resolved: cfg.Default}
	case strings.Contains(want, "/"):
		provider, model, _ := strings.Cut(want, "/")
		if has(provider, model) {
			return ResolveResult{Status: "ok", Resolved: want}
		}
		return ResolveResult{Status: "not_found"}
	default:
		if dp, _, ok := strings.Cut(cfg.Default, "/"); ok && has(dp, want) {
			return ResolveResult{Status: "ok", Resolved: dp + "/" + want}
		}
		var hits []string
		for _, n := range names {
			if has(n, want) {
				hits = append(hits, n)
			}
		}
		switch len(hits) {
		case 0:
			return ResolveResult{Status: "not_found"}
		case 1:
			return ResolveResult{Status: "ok", Resolved: hits[0] + "/" + want}
		default:
			return ResolveResult{Status: "ambiguous", Candidates: hits}
		}
	}
}

// ---- 宿主 stdio 插件 ----

// pluginNameRe 宿主插件名的合法字符集(与 gh 工具名规则同源;防路径穿越)。
var pluginNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// PluginSpec 一次宿主插件安装的存档(platform/plugins/<name>.json)。
// UID 是原始(未清洗)用户名:目录名清洗不可逆,存量自愈/清单回读不再靠
// 解析 wrapper 内容反抠(openos 时代 readWrapperUID 的替代)。
type PluginSpec struct {
	Name    string   `json:"name"`
	UID     string   `json:"uid"`
	Command []string `json:"command"`
}

// InstallPlugin 把一个宿主 stdio 插件接入某用户的 gh:自动发现模式落
// wrapper(unix sh / Windows .cmd,内容烙完整 argv);显式列表模式
// (settings.json 有 plugins 键)把 {name, command} upsert 进数组。保住
// 「无 plugins 键 = 自动发现」语义,不写 URL 条目。幂等,内容不变不写。
func InstallPlugin(grfHome, name string, command []string) error {
	if !pluginNameRe.MatchString(name) {
		return fmt.Errorf("插件名不合法(限 [A-Za-z0-9._-],1-64 字符): %q", name)
	}
	if len(command) == 0 {
		return fmt.Errorf("command 不能为空")
	}
	pluginsDir := filepath.Join(grfHome, "plugins")
	if err := os.MkdirAll(pluginsDir, 0o755); err != nil {
		return fmt.Errorf("创建插件目录: %w", err)
	}
	if err := writePluginWrapper(pluginsDir, name, command); err != nil {
		return err
	}
	settingsPath := filepath.Join(grfHome, "settings.json")
	return grfsettings.Update(settingsPath, func(all map[string]json.RawMessage, existed bool) error {
		if !existed {
			return grfsettings.ErrSkip // 无/损坏文件 = 自动发现模式或留待修复,不碰
		}
		cur, has := all["plugins"]
		if !has {
			return grfsettings.ErrSkip // 自动发现模式
		}
		var list []map[string]any
		if err := json.Unmarshal(cur, &list); err != nil {
			return fmt.Errorf("settings.json plugins 数组解析失败: %w", err)
		}
		entry := map[string]any{"name": name, "command": command}
		replaced := false
		for i, p := range list {
			if n, _ := p["name"].(string); n == name {
				list[i] = entry
				replaced = true
				break
			}
		}
		if !replaced {
			list = append(list, entry)
		}
		data, err := json.Marshal(list)
		if err != nil {
			return err
		}
		all["plugins"] = data
		return nil
	})
}

// RemovePlugin 移除一个宿主插件:删 wrapper + 显式列表模式下移除命令项。
func RemovePlugin(grfHome, name string) error {
	if !pluginNameRe.MatchString(name) {
		return fmt.Errorf("插件名不合法: %q", name)
	}
	fname := name
	if runtime.GOOS == "windows" {
		fname = name + ".cmd"
	}
	if err := os.Remove(filepath.Join(grfHome, "plugins", fname)); err != nil && !os.IsNotExist(err) {
		return err
	}
	settingsPath := filepath.Join(grfHome, "settings.json")
	return grfsettings.Update(settingsPath, func(all map[string]json.RawMessage, existed bool) error {
		if !existed {
			return grfsettings.ErrSkip
		}
		cur, has := all["plugins"]
		if !has {
			return grfsettings.ErrSkip
		}
		var list []map[string]any
		if err := json.Unmarshal(cur, &list); err != nil {
			return err
		}
		out := list[:0]
		for _, p := range list {
			if n, _ := p["name"].(string); n != name {
				out = append(out, p)
			}
		}
		data, err := json.Marshal(out)
		if err != nil {
			return err
		}
		all["plugins"] = data
		return nil
	})
}

// writePluginWrapper 落自动发现模式的 wrapper(内容不变免写)。
func writePluginWrapper(pluginsDir, name string, command []string) error {
	var path, content string
	if runtime.GOOS == "windows" {
		path = filepath.Join(pluginsDir, name+".cmd")
		parts := make([]string, len(command))
		for i, c := range command {
			parts[i] = `"` + c + `"`
		}
		content = "@echo off\r\n" + strings.Join(parts, " ") + " %*\r\n"
	} else {
		path = filepath.Join(pluginsDir, name)
		parts := make([]string, len(command))
		for i, c := range command {
			parts[i] = shQuote(c)
		}
		content = "#!/bin/sh\nexec " + strings.Join(parts, " ") + " \"$@\"\n"
	}
	if raw, err := os.ReadFile(path); err == nil && string(raw) == content {
		return nil
	}
	// 0700:wrapper 内嵌 MCP 端点令牌,多用户机器上不给其他本地用户读权限
	if err := os.WriteFile(path, []byte(content), 0o700); err != nil {
		return fmt.Errorf("写入插件 wrapper: %w", err)
	}
	return nil
}

// shQuote shell 单引号包裹(uid/令牌可能含空格/引号/元字符,全部参数统一转义)。
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ---- 插件规格存档 ----

func pluginSpecPath(userRoot, name string) string {
	return filepath.Join(platformDir(userRoot), "plugins", name+".json")
}

// ReadPluginSpecs 读某用户全部插件规格(按名有序;无目录返回空)。
func ReadPluginSpecs(userRoot string) []PluginSpec {
	entries, err := os.ReadDir(filepath.Join(platformDir(userRoot), "plugins"))
	if err != nil {
		return nil
	}
	var out []PluginSpec
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(platformDir(userRoot), "plugins", e.Name()))
		if err != nil {
			continue
		}
		var spec PluginSpec
		if json.Unmarshal(raw, &spec) == nil && spec.Name != "" {
			out = append(out, spec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// WritePluginSpec 存档一次安装(0600:command 含令牌)。
func WritePluginSpec(userRoot string, spec PluginSpec) error {
	dir := filepath.Join(platformDir(userRoot), "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(pluginSpecPath(userRoot, spec.Name), append(data, '\n'))
}

// DeletePluginSpec 删除规格存档(幂等)。
func DeletePluginSpec(userRoot, name string) error {
	if err := os.Remove(pluginSpecPath(userRoot, name)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ---- 受管供应商名清单(managed:true 注入用) ----

func managedPath(userRoot string) string {
	return filepath.Join(platformDir(userRoot), "managed-providers.json")
}

// ReadManagedProviders 某用户的受管供应商名(代理层给 GET /v1/agent/models
// 响应注入 managed:true 用;无存档返回空)。
func ReadManagedProviders(userRoot string) []string {
	raw, err := os.ReadFile(managedPath(userRoot))
	if err != nil {
		return nil
	}
	var names []string
	if json.Unmarshal(raw, &names) != nil {
		return nil
	}
	return names
}

// WriteManagedProviders 记录受管供应商名(每次声明后覆盖写)。
func WriteManagedProviders(userRoot string, names []string) error {
	if err := os.MkdirAll(platformDir(userRoot), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(names, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(managedPath(userRoot), append(data, '\n'))
}

// ---- 会话分组索引(goder.js ProjectsIndex 形状的宿主镜像) ----

// indexMutexes 按用户根目录串行化索引读改写(浏览器整存 PUT 与宿主代建
// 追加 POST 并发时保条目不丢;单进程内互斥即可,文件层有原子写兜底)。
var (
	indexGuard sync.Mutex
	indexMutex = map[string]*sync.Mutex{}
)

func indexMutexFor(userRoot string) *sync.Mutex {
	indexGuard.Lock()
	defer indexGuard.Unlock()
	mu, ok := indexMutex[userRoot]
	if !ok {
		mu = &sync.Mutex{}
		indexMutex[userRoot] = mu
	}
	return mu
}

// IndexPath 索引文件路径(platform/index.json)。
func IndexPath(userRoot string) string { return filepath.Join(platformDir(userRoot), "index.json") }

// ReadIndex 读索引原文(无文件返回 nil;调用方自行决定空态语义)。
func ReadIndex(userRoot string) json.RawMessage {
	raw, _ := os.ReadFile(IndexPath(userRoot))
	return raw
}

// WriteIndex 整存索引(浏览器侧 setPersistence 适配器的 save 落点)。
func WriteIndex(userRoot string, raw []byte) error {
	if err := os.MkdirAll(platformDir(userRoot), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(IndexPath(userRoot), raw)
}

// IndexSessionAppend POST /admin/users/{uid}/index/sessions 请求体:把一条
// 会话归进分组项目(宿主无头任务代建会话的落点)。字段名与 goder.js
// persistence.ts 的 ProjectsIndex 严格一致,未知键(automation 等)保真。
type IndexSessionAppend struct {
	SID            string `json:"sid"`
	ProjectID      string `json:"project_id"`
	ProjectName    string `json:"project_name"`
	Title          string `json:"title"`
	Model          string `json:"model"`
	LastResponseID string `json:"last_response_id"`
}

// AppendIndexSession 保真地把一条会话写进索引(确保分组项目存在)。损坏
// 索引报错不覆盖(用户其余分组宝贵,调用方按 best-effort 处理,会话回落
// 「未分组」仍可见)。
func AppendIndexSession(userRoot string, a IndexSessionAppend) error {
	if a.SID == "" || a.ProjectID == "" {
		return fmt.Errorf("sid / project_id 必填")
	}
	if a.ProjectName == "" {
		a.ProjectName = a.ProjectID
	}
	mu := indexMutexFor(userRoot)
	mu.Lock()
	defer mu.Unlock()
	raw, err := os.ReadFile(IndexPath(userRoot))
	if err != nil {
		raw = nil
	}
	all := map[string]json.RawMessage{}
	if raw != nil {
		if err := json.Unmarshal(raw, &all); err != nil {
			return fmt.Errorf("会话索引损坏,跳过归组: %w", err)
		}
	}
	var idx struct {
		Projects []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			CreatedAt string `json:"createdAt"`
		} `json:"projects"`
		Sessions map[string]json.RawMessage `json:"sessions"`
	}
	_ = json.Unmarshal(all["projects"], &idx.Projects)
	if err := json.Unmarshal(all["sessions"], &idx.Sessions); err != nil {
		idx.Sessions = map[string]json.RawMessage{}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	found := false
	for _, p := range idx.Projects {
		if p.ID == a.ProjectID {
			found = true
			break
		}
	}
	if !found {
		idx.Projects = append(idx.Projects, struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			CreatedAt string `json:"createdAt"`
		}{ID: a.ProjectID, Name: a.ProjectName, CreatedAt: now})
	}
	rec, err := json.Marshal(map[string]any{
		"projectId":      a.ProjectID,
		"title":          a.Title,
		"createdAt":      now,
		"lastResponseId": a.LastResponseID,
		"model":          a.Model,
	})
	if err != nil {
		return err
	}
	if idx.Sessions == nil {
		idx.Sessions = map[string]json.RawMessage{}
	}
	idx.Sessions[a.SID] = rec
	projRaw, err := json.Marshal(idx.Projects)
	if err != nil {
		return err
	}
	sessRaw, err := json.Marshal(idx.Sessions)
	if err != nil {
		return err
	}
	if _, ok := all["version"]; !ok {
		all["version"] = json.RawMessage("1")
	}
	all["projects"] = projRaw
	all["sessions"] = sessRaw
	out, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return WriteIndex(userRoot, append(out, '\n'))
}
