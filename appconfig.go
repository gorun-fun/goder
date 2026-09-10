// appconfig.go — AppConfig 服务:应用配置与项目索引的文件持久化。
// 前端经 wails Call.ByName("main.AppConfig.*") 调用;纯 web 态自动回退
// localStorage(见 frontend/src/state/persist.ts)。
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
)

// AppConfigDTO 与前端 host/bridge.ts 的 AppConfigDTO 对齐。
type AppConfigDTO struct {
	Scope        string `json:"scope"`
	ServerMode   string `json:"serverMode"` // managed | remote
	RemoteURL    string `json:"remoteUrl"`
	RemoteToken  string `json:"remoteToken"`
	DefaultModel string `json:"defaultModel"`
	GhBinary     string `json:"ghBinary"`
	ServerAddr   string `json:"serverAddr"`
}

func defaultConfig() AppConfigDTO {
	return AppConfigDTO{
		Scope:      "app",
		ServerMode: "managed",
		RemoteURL:  "http://127.0.0.1:7400",
		GhBinary:   "gh",
		ServerAddr: "127.0.0.1:7400",
	}
}

// AppConfig wails 服务(配置文件 + 每个 scope 的项目索引)。
type AppConfig struct{}

func (a *AppConfig) configDir() (string, error) {
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

// Load 读取应用配置(不存在时返回默认值)。
func (a *AppConfig) Load() (AppConfigDTO, error) {
	cfg := defaultConfig()
	dir, err := a.configDir()
	if err != nil {
		return cfg, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
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
func (a *AppConfig) Save(cfg AppConfigDTO) error {
	dir, err := a.configDir()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "config.json"), data, 0o600)
}

var scopeSan = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// LoadIndex 读取某个 scope 的项目索引 JSON(由前端全权定义结构)。
func (a *AppConfig) LoadIndex(scope string) (string, error) {
	dir, err := a.configDir()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(filepath.Join(dir, "index-"+scopeSan.ReplaceAllString(scope, "_")+".json"))
	if os.IsNotExist(err) {
		return "", nil
	}
	return string(data), err
}

// SaveIndex 写入某个 scope 的项目索引 JSON。
func (a *AppConfig) SaveIndex(scope string, indexJSON string) error {
	dir, err := a.configDir()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "index-"+scopeSan.ReplaceAllString(scope, "_")+".json"), []byte(indexJSON), 0o600)
}
