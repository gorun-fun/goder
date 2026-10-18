// Package grfsettings — gh 配置 settings.json(~/.grf/settings.json)的
// 读改写事务帮助:互斥串行 + 原子落盘(tmp + rename)。桌面设置页的
// 保存(ModelConfig.Save / AgentConfig.PluginsSave)与启动期 goder-console
// 烙写(plugins/console 的 upsertSettings)原本各持一份「ReadFile → 换键
// → MarshalIndent → WriteFile」手抄,既无原子性也无串行化:进程崩溃或
// 启动期后台烙写与用户保存交错时会写出半截文件,走到「损坏按空文档
// 修复」路径把整份 providers 配置清掉。统一收口到本包后:
//   - 进程内并发写经 writeMu 串行化(单次事务内读-改-写不被插入);
//   - 落盘走同目录临时文件 + rename,中途被杀不损坏既有文件(与
//     internal/appcfg 的 atomicWrite 同范式,那边有并发写踩坑实测记录);
//   - 跨进程(gh 自身写 settings.json)仍靠 rename 原子性保证不损坏,
//     最后写者胜出的竞态无法在文件层面消除。
//
// 输出格式与既有手抄保持一致:两空格缩进 + 尾换行 + 0600(令牌等同
// 本地凭据),避免无谓的整文件 diff churn。
package grfsettings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// ErrSkip 在 fn 里返回表示放弃本次写入,文件保持原样(调用方表达
// 「无文件/损坏/无 plugins 键时不碰」这类语义用)。
var ErrSkip = errors.New("grfsettings: 跳过写入")

// writeMu 串行化进程内全部 settings.json 事务(见包注释)。
var writeMu sync.Mutex

// Update 对 settings.json 做一次「读-改-写」事务:读出整份文档为
// RawMessage 映射交给 fn 换键;fn 返回 ErrSkip 则不落盘,其他错误原样
// 上抛。existed 表示文件存在且 JSON 解析成功——false 时 all 是空文档,
// 需要修复语义的调用方照常改键落盘(损坏由本次写入修复),需要
// 「不碰坏文件」语义的在 fn 里返回 ErrSkip。文件不存在时自动建目录。
func Update(path string, fn func(all map[string]json.RawMessage, existed bool) error) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	all := map[string]json.RawMessage{}
	existed := false
	if raw, err := os.ReadFile(path); err == nil {
		if json.Unmarshal(raw, &all) == nil {
			existed = true
		}
	}
	if err := fn(all, existed); err != nil {
		if errors.Is(err, ErrSkip) {
			return nil
		}
		return err
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(data, '\n'), 0o600)
}

// atomicWrite 同目录写固定名临时文件后 rename 顶替(同分区保证原子性;
// 失败时清理临时文件,目标文件保持旧内容)。writeMu 已保证进程内不并发。
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
