// hostsettings_test.go — 宿主管理面域逻辑测试(语义用例自 openos aisync/
// hosttasks/osmcp install 的实战口径移植:保真 upsert/残留清理/默认模型
// 决策链/内容不变不写/起播竞态;解析 fail-fast 择序;插件双模式安装;
// 索引保真追加)。
package ghserver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSettings(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readSettings(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 settings 失败: %v", err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		t.Fatalf("settings 非法 JSON: %v", err)
	}
	return all
}

func declOf(entries []ProviderEntry, managed []string, def string, force bool) ProvidersDecl {
	return ProvidersDecl{Entries: entries, Managed: managed, Default: def, ForceDefault: force}
}

func TestUpsertProvidersBootstrap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "grf-home", "settings.json")
	wrote, err := UpsertProviders(path, declOf(
		[]ProviderEntry{{Name: "OpenOS", BaseURL: "http://x", APIKey: "k", Models: []string{"m1"}}},
		[]string{"OpenOS"}, "OpenOS/m1", true))
	if err != nil || !wrote {
		t.Fatalf("起播应写盘: wrote=%v err=%v", wrote, err)
	}
	all := readSettings(t, path)
	if string(all["default"]) != `"OpenOS/m1"` {
		t.Fatalf("default 应写入,得到 %s", all["default"])
	}
	// 幂等:同声明重放不写盘、不改内容
	before, _ := os.ReadFile(path)
	wrote, err = UpsertProviders(path, declOf(
		[]ProviderEntry{{Name: "OpenOS", BaseURL: "http://x", APIKey: "k", Models: []string{"m1"}}},
		[]string{"OpenOS"}, "OpenOS/m1", true))
	if err != nil || wrote {
		t.Fatalf("重放应不写: wrote=%v err=%v", wrote, err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("内容不应变化")
	}
}

func TestUpsertProvidersFidelityAndDefaultChain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeSettings(t, path, `{
  "system_prompt": "保留我",
  "max_steps": 33,
  "providers": {"Mine": {"base_url": "http://m", "api_key": "mk", "models": ["mm"]}},
  "default": "Mine/mm"
}`)
	decl := declOf(
		[]ProviderEntry{{Name: "P", BaseURL: "http://p", APIKey: "pk", Models: []string{"pm"}}},
		[]string{"P"}, "P/pm", false) // 非强制:不打架用户自选默认
	wrote, err := UpsertProviders(path, decl)
	if err != nil || !wrote {
		t.Fatalf("应写盘: %v %v", wrote, err)
	}
	all := readSettings(t, path)
	if string(all["default"]) != `"Mine/mm"` {
		t.Fatalf("非强制不得覆盖用户自选默认,得到 %s", all["default"])
	}
	if string(all["system_prompt"]) != `"保留我"` || string(all["max_steps"]) != "33" {
		t.Fatal("未知键必须保真")
	}
	var provs map[string]json.RawMessage
	if err := json.Unmarshal(all["providers"], &provs); err != nil {
		t.Fatal(err)
	}
	if _, ok := provs["Mine"]; !ok {
		t.Fatal("声明外供应商不得被碰")
	}
	if _, ok := provs["P"]; !ok {
		t.Fatal("声明条目应写入")
	}
	// 强制:覆盖为受管默认
	if _, err := UpsertProviders(path, declOf(
		[]ProviderEntry{{Name: "P", BaseURL: "http://p", APIKey: "pk", Models: []string{"pm"}}},
		[]string{"P"}, "P/pm", true)); err != nil {
		t.Fatal(err)
	}
	if string(readSettings(t, path)["default"]) != `"P/pm"` {
		t.Fatal("强制应覆盖默认")
	}
}

func TestUpsertProvidersCleanupAndNoCandidate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeSettings(t, path, `{
  "providers": {
    "A": {"base_url": "http://a", "api_key": "ak", "models": ["am"]},
    "B": {"base_url": "http://b", "api_key": "bk", "models": ["bm"]},
    "Mine": {"base_url": "http://m", "api_key": "mk", "models": ["mm"]}
  },
  "default": "B/bm"
}`)
	// managed 全集 [A,B],本次仅声明 A;B 应被清理、Mine 保留;无候选默认
	// 且现默认指向受管条目 → default 随之删除
	if _, err := UpsertProviders(path, declOf(
		[]ProviderEntry{{Name: "A", BaseURL: "http://a", APIKey: "ak", Models: []string{"am"}}},
		[]string{"A", "B"}, "", false)); err != nil {
		t.Fatal(err)
	}
	all := readSettings(t, path)
	var provs map[string]json.RawMessage
	_ = json.Unmarshal(all["providers"], &provs)
	if _, ok := provs["B"]; ok {
		t.Fatal("受管未声明条目应清除")
	}
	if _, ok := provs["Mine"]; !ok {
		t.Fatal("声明外条目不得清除")
	}
	if _, ok := all["default"]; ok {
		t.Fatal("受管默认随条目清除")
	}
}

func TestUpsertProvidersCorruptSkip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeSettings(t, path, `{not json`)
	wrote, err := UpsertProviders(path, declOf(
		[]ProviderEntry{{Name: "P", BaseURL: "http://p", APIKey: "pk", Models: []string{"pm"}}},
		[]string{"P"}, "P/pm", true))
	if err != nil || wrote {
		t.Fatalf("损坏文件应跳过: wrote=%v err=%v", wrote, err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != `{not json` {
		t.Fatal("损坏文件不得被改写")
	}
}

func TestResolveModelName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeSettings(t, path, `{
  "providers": {
    "A": {"base_url": "x", "api_key": "k", "models": ["a1", "a2"]},
    "B": {"base_url": "x", "api_key": "k", "models": ["b1", "x1"]},
    "C": {"base_url": "x", "api_key": "k", "models": ["c1", "x1"]}
  },
  "default": "A/a1"
}`)
	cases := []struct {
		want, status, resolved string
		cands                  []string
	}{
		{"", "ok", "A/a1", nil},                     // 空 = 默认
		{"A/a2", "ok", "A/a2", nil},                 // 限定名命中
		{"A/b1", "not_found", "", nil},              // 限定名未含
		{"a1", "ok", "A/a1", nil},                   // 默认供应商优先
		{"b1", "ok", "B/b1", nil},                   // 恰一家命中
		{"x1", "ambiguous", "", []string{"B", "C"}}, // 多家歧义,不武断挑选
		{"zz", "not_found", "", nil},
	}
	for _, c := range cases {
		got := ResolveModelName(path, c.want)
		if got.Status != c.status || got.Resolved != c.resolved {
			t.Fatalf("ResolveModelName(%q) = %+v,期望 status=%s resolved=%s", c.want, got, c.status, c.resolved)
		}
		if len(got.Candidates) != len(c.cands) {
			t.Fatalf("ResolveModelName(%q) candidates = %v,期望 %v", c.want, got.Candidates, c.cands)
		}
	}
	if r := ResolveModelName(filepath.Join(t.TempDir(), "none.json"), ""); r.Status != "unreadable" {
		t.Fatalf("缺文件应 unreadable,得到 %s", r.Status)
	}
	writeSettings(t, path, `{"providers": {}}`) // 无默认
	if r := ResolveModelName(path, ""); r.Status != "no_default" {
		t.Fatalf("空名无默认应 no_default,得到 %s", r.Status)
	}
}

func TestInstallPluginModes(t *testing.T) {
	home := filepath.Join(t.TempDir(), "grf-home")
	cmd := []string{"/opt/openos-server", "mcp-shim", "http://127.0.0.1:7712/mcp", "tok", "张 三"}
	// 自动发现模式:无 settings.json → 只落 wrapper
	if err := InstallPlugin(home, "openos", cmd); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "plugins", "openos")); err != nil {
		t.Fatalf("wrapper 应存在: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "settings.json")); !os.IsNotExist(err) {
		t.Fatal("自动发现模式不得起播 settings.json")
	}
	// 显式列表模式:有 plugins 键 → upsert 命令项、保留他人条目
	writeSettings(t, filepath.Join(home, "settings.json"), `{"plugins":[{"name":"other","command":["x"]}]}`)
	if err := InstallPlugin(home, "openos", cmd); err != nil {
		t.Fatal(err)
	}
	var all map[string]json.RawMessage
	raw, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	_ = json.Unmarshal(raw, &all)
	var list []map[string]any
	_ = json.Unmarshal(all["plugins"], &list)
	if len(list) != 2 {
		t.Fatalf("应保留 other 并新增 openos,得到 %d 条", len(list))
	}
	// 幂等:重复安装不改文件
	if err := InstallPlugin(home, "openos", cmd); err != nil {
		t.Fatal(err)
	}
	raw2, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	if string(raw) != string(raw2) {
		t.Fatal("重复安装不应改写 settings.json")
	}
	// 卸载:wrapper 与命令项一并移除,other 保留
	if err := RemovePlugin(home, "openos"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "plugins", "openos")); !os.IsNotExist(err) {
		t.Fatal("wrapper 应删除")
	}
	raw3, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	_ = json.Unmarshal(raw3, &all)
	_ = json.Unmarshal(all["plugins"], &list)
	if len(list) != 1 || list[0]["name"] != "other" {
		t.Fatalf("卸载后应只剩 other,得到 %v", list)
	}
	// 非法名(路径穿越/字符集)拒绝
	for _, bad := range []string{"", "../evil", "带空格 名", strings.Repeat("a", 65)} {
		if err := InstallPlugin(home, bad, cmd); err == nil {
			t.Fatalf("非法名 %q 应拒绝", bad)
		}
	}
}

func TestPluginSpecAndManagedRoundtrip(t *testing.T) {
	root := t.TempDir()
	if err := WritePluginSpec(root, PluginSpec{Name: "openos", UID: "张三", Command: []string{"a", "b"}}); err != nil {
		t.Fatal(err)
	}
	specs := ReadPluginSpecs(root)
	if len(specs) != 1 || specs[0].UID != "张三" || len(specs[0].Command) != 2 {
		t.Fatalf("规格存档往返失败: %+v", specs)
	}
	if err := DeletePluginSpec(root, "openos"); err != nil {
		t.Fatal(err)
	}
	if len(ReadPluginSpecs(root)) != 0 {
		t.Fatal("规格应删除")
	}
	if err := WriteManagedProviders(root, []string{"OpenOS", "TokenHub"}); err != nil {
		t.Fatal(err)
	}
	names := ReadManagedProviders(root)
	if len(names) != 2 || names[0] != "OpenOS" {
		t.Fatalf("受管名往返失败: %v", names)
	}
}

func TestIndexAppendFidelity(t *testing.T) {
	root := t.TempDir()
	// 预置:已有项目 + 会话 + automation 等未知键(保真)
	preset := `{"version":1,"projects":[{"id":"old","name":"旧","createdAt":"2026-01-01T00:00:00Z"}],` +
		`"sessions":{"s-old":{"projectId":"old"}},"automation":[{"kind":"x"}],"lastActiveSessionId":"s-old"}`
	if err := WriteIndex(root, []byte(preset)); err != nil {
		t.Fatal(err)
	}
	if err := AppendIndexSession(root, IndexSessionAppend{
		SID: "s-new", ProjectID: "fixer", ProjectName: "自动修复",
		Title: "修复登录页", Model: "P/m", LastResponseID: "r1",
	}); err != nil {
		t.Fatal(err)
	}
	raw := ReadIndex(root)
	var idx struct {
		Projects []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"projects"`
		Sessions          map[string]json.RawMessage `json:"sessions"`
		Automation        []json.RawMessage          `json:"automation"`
		LastActiveSession json.RawMessage            `json:"lastActiveSessionId"`
	}
	if err := json.Unmarshal(raw, &idx); err != nil {
		t.Fatal(err)
	}
	if len(idx.Projects) != 2 || idx.Projects[1].ID != "fixer" || idx.Projects[1].Name != "自动修复" {
		t.Fatalf("应确保新项目且保留旧项目: %+v", idx.Projects)
	}
	var sess struct {
		ProjectID      string `json:"projectId"`
		Title          string `json:"title"`
		LastResponseID string `json:"lastResponseId"`
	}
	if err := json.Unmarshal(idx.Sessions["s-new"], &sess); err != nil {
		t.Fatal(err)
	}
	if sess.ProjectID != "fixer" || sess.Title != "修复登录页" || sess.LastResponseID != "r1" {
		t.Fatalf("新会话条目不符: %+v", sess)
	}
	if len(idx.Automation) != 1 || string(idx.LastActiveSession) != `"s-old"` {
		t.Fatal("未知键(automation/lastActiveSessionId)必须保真")
	}
	// 损坏索引:报错不覆盖
	if err := WriteIndex(root, []byte("{broken")); err != nil {
		t.Fatal(err)
	}
	if err := AppendIndexSession(root, IndexSessionAppend{SID: "s", ProjectID: "p"}); err == nil {
		t.Fatal("损坏索引应报错")
	}
	if raw := ReadIndex(root); string(raw) != "{broken" {
		t.Fatal("损坏索引不得被覆盖")
	}
}
