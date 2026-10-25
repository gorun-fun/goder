// modelconfig.go — ModelConfig 服务:读写 gh 的模型配置(~/.grf/settings.json
// 的 providers 与 default),让设置页的"模型设置"可以直接增删供应商。
// 只改这两个键,其余配置(mouse / max_steps / policy / plugins 等)原样
// 保留;GRF_HOME 可重定位配置目录。
package desktop

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorun-fun/goder/internal/grfsettings"
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
	// gh settings 常用项;指针为 nil 表示文件里没有该键,保存时原样保留
	MaxSteps *int   `json:"maxSteps"`
	Mouse    *bool  `json:"mouse"`
	Policy   string `json:"policy"` // 空表示未设置
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

// grfSettingsPath 解析 settings.json 路径(GRF_HOME 优先,同 grfHome)。
func grfSettingsPath() string {
	return filepath.Join(grfHome(), "settings.json")
}

// Load 读取供应商与默认模型;文件不存在或解析失败时返回空列表。
func (m *ModelConfig) Load() ModelConfigDTO {
	path := grfSettingsPath()
	out := ModelConfigDTO{Path: path, Providers: []ProviderDTO{}, Writable: settingsWritable(path)}

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
	// 常用项:存在才带出(指针为 nil 表示未设置)
	if v, ok := all["max_steps"]; ok {
		var n int
		if err := json.Unmarshal(v, &n); err == nil {
			out.MaxSteps = &n
		}
	}
	if v, ok := all["mouse"]; ok {
		var b bool
		if err := json.Unmarshal(v, &b); err == nil {
			out.Mouse = &b
		}
	}
	if v, ok := all["policy"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			out.Policy = s
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
		if p.Models == nil {
			// settings.json 里缺 models 键时保持空数组:DTO 对齐前端,
			// 序列化为 null 会让前端展开语法抛错(见 chat-panel providers)
			p.Models = []string{}
		}
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

// Save 写回 providers 与 default,其余键原样保留。走 grfsettings 原子
// 事务:与插件保存、启动期 goder-console 烙写串行化,写盘中途被杀不
// 损坏既有配置。
func (m *ModelConfig) Save(cfg ModelConfigDTO) error {
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
	return grfsettings.Update(grfSettingsPath(), func(all map[string]json.RawMessage, _ bool) error {
		all["providers"] = provRaw
		all["default"] = defRaw
		// 常用项:显式设置了才写,空 policy 不落键(沿用原值或省略)
		if cfg.MaxSteps != nil {
			if raw, err := json.Marshal(*cfg.MaxSteps); err == nil {
				all["max_steps"] = raw
			}
		}
		if cfg.Mouse != nil {
			if raw, err := json.Marshal(*cfg.Mouse); err == nil {
				all["mouse"] = raw
			}
		}
		if p := strings.TrimSpace(cfg.Policy); p != "" {
			if raw, err := json.Marshal(p); err == nil {
				all["policy"] = raw
			}
		}
		return nil
	})
}

// settingsWritable 目标文件是否可写(不存在时看目录)。
func settingsWritable(path string) bool {
	if f, err := os.OpenFile(path, os.O_WRONLY, 0o600); err == nil {
		f.Close()
		return true
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	// 探测文件:建完即删,不在配置目录留下垃圾。
	f, err := os.CreateTemp(dir, ".goder-write-test")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	_ = os.Remove(name)
	return true
}

// DetectedModelDTO DetectModels 的单条结果,与前端 host/bridge.ts 对齐。
type DetectedModelDTO struct {
	ID string `json:"id"`
	// CtxLen 上游回报的上下文窗口(token 数);0 = 上游未提供,
	// 前端回落按模型名的估算表(token-hub / OpenRouter / SiliconFlow
	// 等网关在模型对象上带 context_length)。
	CtxLen int `json:"ctxLen"`
}

// DetectModels 询问供应商的模型列表接口(OpenAI 兼容 GET /models),
// 返回模型 id 与可选的上下文窗口;供设置页"自动检测"合并模型列表,
// 并为聊天面板的上下文占用圆环提供真实分母。
func (m *ModelConfig) DetectModels(p ProviderDTO) ([]DetectedModelDTO, error) {
	base := strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
	if base == "" {
		return nil, fmt.Errorf("未配置 Base URL")
	}
	req, err := http.NewRequest(http.MethodGet, base+"/models", nil)
	if err != nil {
		return nil, err
	}
	if k := strings.TrimSpace(p.APIKey); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("接口返回 %s", resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	// OpenAI 形状 {data:[{id}]};兼容裸数组 [{id}]
	var list []map[string]any
	wrapped := struct {
		Data []map[string]any `json:"data"`
	}{}
	if jerr := json.Unmarshal(body, &wrapped); jerr == nil && len(wrapped.Data) > 0 {
		list = wrapped.Data
	} else {
		var bare []map[string]any
		if jerr := json.Unmarshal(body, &bare); jerr != nil {
			return nil, fmt.Errorf("响应不是可识别的模型列表 JSON")
		}
		list = bare
	}
	out := make([]DetectedModelDTO, 0, len(list))
	for _, item := range list {
		id, _ := item["id"].(string)
		if id == "" {
			continue
		}
		out = append(out, DetectedModelDTO{ID: id, CtxLen: modelCtxLen(item)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// modelCtxLen 从模型对象里取上下文窗口,按社区常见字段名依次尝试
// (token-hub 三者同值;OpenRouter/SiliconFlow 用 context_length,
// vLLM 用 max_model_len);数字或数字字符串均可,取首个 >0 的值。
func modelCtxLen(item map[string]any) int {
	for _, key := range []string{"context_length", "context_window", "max_model_len"} {
		switch v := item[key].(type) {
		case float64:
			if v > 0 {
				return int(v)
			}
		case string:
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}
