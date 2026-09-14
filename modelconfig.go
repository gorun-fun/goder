// modelconfig.go — ModelConfig 服务:读写 gh 的模型配置(~/.grf/settings.json
// 的 providers 与 default),让设置页的"模型设置"可以直接增删供应商。
// 只改这两个键,其余配置(mouse / max_steps / policy / plugins 等)原样
// 保留;GRF_HOME 可重定位配置目录。
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ProviderDTO 与前端 host/bridge.ts 的 ProviderDTO 对齐。
type ProviderDTO struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`    // 空表示 gh 默认(OpenAI 兼容)
	BaseURL string   `json:"baseUrl"` // 对应 settings.json 的 base_url
	APIKey  string   `json:"apiKey"`  // 对应 api_key
	Models  []string `json:"models"`
}

// ModelConfigDTO 与前端 host/bridge.ts 的 ModelConfigDTO 对齐。
type ModelConfigDTO struct {
	Path      string        `json:"path"`      // settings.json 绝对路径(展示用)
	Providers []ProviderDTO `json:"providers"` // 按名称排序
	Default   string        `json:"default"`   // provider/model
	Writable  bool          `json:"writable"`  // 目录/文件是否可写(决定 UI 只读)
}

// ghProvider settings.json 中单个供应商的原始形状。
type ghProvider struct {
	Type    string   `json:"type,omitempty"`
	BaseURL string   `json:"base_url"`
	APIKey  string   `json:"api_key,omitempty"`
	Models  []string `json:"models,omitempty"`
}

// ModelConfig wails 服务。
type ModelConfig struct{}

// grfSettingsPath 解析 settings.json 路径(GRF_HOME 优先)。
func grfSettingsPath() string {
	if h := strings.TrimSpace(os.Getenv("GRF_HOME")); h != "" {
		return filepath.Join(h, "settings.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "settings.json"
	}
	return filepath.Join(home, ".grf", "settings.json")
}

// Load 读取供应商与默认模型;文件不存在或解析失败时返回空列表。
func (m *ModelConfig) Load() ModelConfigDTO {
	path := grfSettingsPath()
	out := ModelConfigDTO{Path: path, Providers: []ProviderDTO{}, Writable: m.writable(path)}

	raw, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		return out
	}
	if v, ok := all["default"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			out.Default = s
		}
	}
	var ps map[string]ghProvider
	if v, ok := all["providers"]; ok {
		_ = json.Unmarshal(v, &ps)
	}
	names := make([]string, 0, len(ps))
	for n := range ps {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		p := ps[n]
		out.Providers = append(out.Providers, ProviderDTO{
			Name:    n,
			Type:    p.Type,
			BaseURL: p.BaseURL,
			APIKey:  p.APIKey,
			Models:  p.Models,
		})
	}
	return out
}

// Save 写回 providers 与 default,其余键原样保留。
func (m *ModelConfig) Save(cfg ModelConfigDTO) error {
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

	ps := map[string]ghProvider{}
	for _, p := range cfg.Providers {
		name := strings.TrimSpace(p.Name)
		if name == "" {
			continue
		}
		models := make([]string, 0, len(p.Models))
		for _, mm := range p.Models {
			if s := strings.TrimSpace(mm); s != "" {
				models = append(models, s)
			}
		}
		ps[name] = ghProvider{
			Type:    strings.TrimSpace(p.Type),
			BaseURL: strings.TrimSpace(p.BaseURL),
			APIKey:  strings.TrimSpace(p.APIKey),
			Models:  models,
		}
	}
	provRaw, err := json.Marshal(ps)
	if err != nil {
		return err
	}
	defRaw, err := json.Marshal(strings.TrimSpace(cfg.Default))
	if err != nil {
		return err
	}
	all["providers"] = provRaw
	all["default"] = defRaw

	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

// writable 目标文件是否可写(不存在时看目录)。
func (m *ModelConfig) writable(path string) bool {
	if f, err := os.OpenFile(path, os.O_WRONLY, 0o600); err == nil {
		f.Close()
		return true
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	// 探测文件:建完即删,不在配置目录留下垃圾。
	f, err := os.CreateTemp(dir, ".grf-write-test")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	_ = os.Remove(name)
	return true
}
