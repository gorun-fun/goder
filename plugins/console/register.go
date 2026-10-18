// register.go — goder-console 的安装面:端口/令牌持久化 + gh 插件接入。
//
// 接入方式(保住「settings.json 无 plugins 键 = 自动发现」语义,不能写
// URL 条目把 gh 切到显式列表模式):
//   - 自动发现模式:向 ~/.grf/plugins/ 落一个 wrapper(unix sh 脚本 /
//     Windows .cmd),内容烙上当前 goder 可执行文件路径与端点令牌,gh
//     自动发现直接收编(stdio 插件)。
//   - 显式列表模式(settings.json 有 plugins 键):把 shim 命令项
//     [exe, console-shim, url, token] upsert 进数组,其余条目原样保留。
//
// 端口与令牌持久化在 goder 配置目录的 console-mcp.json(令牌跨启动稳定:
// 已在跑的 gh 收养场景不至于因令牌轮换而失联;端口被占则换新并回写)。
package console

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"

	"git.gorun.fun/share/goder/internal/grfsettings"
)

// pluginName gh 侧的插件名(工具描述里的归属展示)。
const pluginName = "goder-console"

// defaultPort 桌面进程内 goder-console 监听的偏好端口(7400 是 gh、
// 7610 是 grf-browser serve 的缺省,避开)。
const defaultPort = 7450

// Config 持久化配置(goder 配置目录 console-mcp.json)。
type Config struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// LoadConfig 读取持久化配置;无文件或损坏时生成新令牌(端口回落默认,
// 由 Listen 收敛)。
func LoadConfig(dir string) Config {
	cfg := Config{Port: defaultPort}
	if raw, err := os.ReadFile(filepath.Join(dir, "console-mcp.json")); err == nil {
		_ = json.Unmarshal(raw, &cfg)
	}
	if cfg.Token == "" {
		b := make([]byte, 24)
		_, _ = rand.Read(b)
		cfg.Token = hex.EncodeToString(b)
	}
	return cfg
}

// SaveConfig 落盘配置(目录不存在则建;0600,令牌等同本地凭据)。
func SaveConfig(dir string, cfg Config) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "console-mcp.json"), append(data, '\n'), 0o600)
}

// Listen 按 cfg.Port 绑 127.0.0.1;被占则随机端口(返回实际端口,调用方
// 决定回写)。
func Listen(cfg Config) (net.Listener, Config, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)))
	if err == nil {
		return ln, cfg, nil
	}
	ln, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, cfg, err
	}
	cfg.Port = ln.Addr().(*net.TCPAddr).Port
	return ln, cfg, nil
}

// Install 把 goder-console 接入 gh:落 wrapper(自动发现模式生效)+ 显式
// 列表模式下 upsert 命令项。exe 为当前 goder 可执行文件绝对路径,
// pluginsDir 为 ~/.grf/plugins,settingsPath 为 settings.json,endpoint
// 为 /mcp 完整 URL。每次启动调用,内容幂等(不变不写,避免盘 churn)。
func Install(exe, pluginsDir, settingsPath, endpoint, token string) error {
	if err := os.MkdirAll(pluginsDir, 0o755); err != nil {
		return fmt.Errorf("创建插件目录: %w", err)
	}
	// 自动发现模式的 wrapper(显式列表模式下是冗余文件,无害;列表项
	// 直接指向 exe,不经过 wrapper)
	if err := writeWrapper(exe, pluginsDir, endpoint, token); err != nil {
		return err
	}
	return upsertSettings(exe, settingsPath, endpoint, token)
}

// writeWrapper 落 ~/.grf/plugins/goder-console(unix sh / windows .cmd)。
func writeWrapper(exe, pluginsDir, endpoint, token string) error {
	var path, content string
	if runtime.GOOS == "windows" {
		path = filepath.Join(pluginsDir, pluginName+".cmd")
		content = "@echo off\r\n\"" + exe + "\" console-shim " + endpoint + " " + token + " %*\r\n"
	} else {
		path = filepath.Join(pluginsDir, pluginName)
		content = "#!/bin/sh\nexec \"" + exe + "\" console-shim " + endpoint + " " + token + " \"$@\"\n"
	}
	if raw, err := os.ReadFile(path); err == nil && string(raw) == content {
		return nil // 内容一致,免写
	}
	// 0700:wrapper 内嵌 MCP 端点令牌,多用户机器上不给其他本地用户读权限
	if err := os.WriteFile(path, []byte(content), 0o700); err != nil {
		return fmt.Errorf("写入插件 wrapper: %w", err)
	}
	return nil
}

// upsertSettings settings.json 有 plugins 键(显式列表模式)时,把
// goder-console 命令项 upsert 进去;无键(自动发现)不动文件。走
// grfsettings 原子事务:与设置页的模型/插件保存(同进程)串行化,
// 烙写与用户保存并发交错时不再有写出半截文件的风险。
func upsertSettings(exe, settingsPath, endpoint, token string) error {
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
		entry := map[string]any{
			"name":    pluginName,
			"command": []string{exe, "console-shim", endpoint, token},
		}
		replaced := false
		for i, p := range list {
			if name, _ := p["name"].(string); name == pluginName {
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
