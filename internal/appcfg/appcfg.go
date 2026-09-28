// Package appcfg — 桌面应用配置与项目索引的文件持久化。wails 桌面壳的
// AppConfig 服务在其上做薄封装;数据目录为 os.UserConfigDir()/goder。
package appcfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
)

// Config 应用配置。JSON 字段与前端 host/bridge.ts 的 AppConfigDTO 对齐。
// 注:defaultModel 已移除(默认模型是 gh 侧概念,goder 按会话记录继承,
// 不落配置);旧 config.json 里的同名字段读取时被忽略、下次保存自然清除。
type Config struct {
	Scope      string `json:"scope"`
	ServerMode string `json:"serverMode"` // managed | remote
	RemoteURL  string `json:"remoteUrl"`
	RemoteToken string `json:"remoteToken"`
	GhBinary   string `json:"ghBinary"`
	ServerAddr string `json:"serverAddr"`
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

// DefaultDir 配置目录(os.UserConfigDir()/goder)。
// 项目原名 grf-harness-ui:改名后首次启动把旧目录整体迁移过来(配置/索引/
// 托管 gh 的 server-data 一起搬,聊天记录不丢);新目录已存在时以新为准不动。
func DefaultDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "goder")
	legacy := filepath.Join(base, "grf-harness-ui")
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		if _, lerr := os.Stat(legacy); lerr == nil {
			if rerr := os.Rename(legacy, dir); rerr != nil {
				return "", rerr
			}
		}
	}
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

// Save 落盘应用配置(原子写:tmp + rename,进程在写入中途被杀不致
// 损坏既有配置)。
func (s *Store) Save(cfg Config) error {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.Dir, "config.json"), data, 0o600)
}

// atomicWrite 同目录写临时文件后 rename 顶替(同分区保证原子性;
// 失败时清理临时文件,目标文件保持旧内容)。
func atomicWrite(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
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

// SaveIndex 写入某个 scope 的项目索引 JSON(原子写,同 Save)。
func (s *Store) SaveIndex(scope string, indexJSON string) error {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.Dir, "index-"+scopeSan.ReplaceAllString(scope, "_")+".json"), []byte(indexJSON), 0o600)
}
