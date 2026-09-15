// Package appcfg — 桌面应用配置与项目索引的文件持久化。wails 桌面壳的
// AppConfig 服务在其上做薄封装;数据目录为 os.UserConfigDir()/grf-harness-ui。
package appcfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
)

// Config 应用配置。JSON 字段与前端 host/bridge.ts 的 AppConfigDTO 对齐。
type Config struct {
	Scope        string `json:"scope"`
	ServerMode   string `json:"serverMode"` // managed | remote
	RemoteURL    string `json:"remoteUrl"`
	RemoteToken  string `json:"remoteToken"`
	DefaultModel string `json:"defaultModel"`
	GhBinary     string `json:"ghBinary"`
	ServerAddr   string `json:"serverAddr"`
}

// Default 默认配置。
func Default() Config {
	return Config{
		Scope:      "app",
		ServerMode: "managed",
		RemoteURL:  "http://127.0.0.1:7400",
		GhBinary:   "gh",
		ServerAddr: "127.0.0.1:7400",
	}
}

// DefaultDir 配置目录(os.UserConfigDir()/grf-harness-ui)。
func DefaultDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "grf-harness-ui")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// Store 指定目录的配置与索引存取。
type Store struct {
	Dir string
}

// Load 读取应用配置(不存在时返回默认值)。
func (s *Store) Load() (Config, error) {
	cfg := Default()
	data, err := os.ReadFile(filepath.Join(s.Dir, "config.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	_ = json.Unmarshal(data, &cfg)
	return cfg, nil
}

// Save 落盘应用配置。
func (s *Store) Save(cfg Config) error {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.Dir, "config.json"), data, 0o600)
}

var scopeSan = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// LoadIndex 读取某个 scope 的项目索引 JSON(结构由前端全权定义)。
func (s *Store) LoadIndex(scope string) (string, error) {
	data, err := os.ReadFile(filepath.Join(s.Dir, "index-"+scopeSan.ReplaceAllString(scope, "_")+".json"))
	if os.IsNotExist(err) {
		return "", nil
	}
	return string(data), err
}

// SaveIndex 写入某个 scope 的项目索引 JSON。
func (s *Store) SaveIndex(scope string, indexJSON string) error {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.Dir, "index-"+scopeSan.ReplaceAllString(scope, "_")+".json"), []byte(indexJSON), 0o600)
}
