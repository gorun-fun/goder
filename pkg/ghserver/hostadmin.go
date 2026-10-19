// hostadmin.go — 宿主管理面的 Manager 侧:用户目录布局的所有权出口与
// 用户生命周期。嵌入方(openos 类桌面宿主)此前被迫复刻 users/<san> 布局与
// uid 清洗规则才能触碰这些目录(写 settings.json/装插件/删号清理),现在
// 全部经 /admin/* 端点表达意图,目录知识收敛回本包。
package ghserver

import (
	"fmt"
	"os"
	"path/filepath"
)

// UserRoot 某用户的根目录(<DataRoot>/users/<san>,含 server-data 与
// grf-home)。平台侧状态(platform/ 子目录:托管供应商清单、宿主插件规格、
// 会话索引)也落在这里,与 gh 感知的两个子目录并列、互不干扰。
func (m *Manager) UserRoot(uid string) string {
	san := uidSan.ReplaceAllString(uid, "_")
	return filepath.Join(m.cfg.DataRoot, "users", san)
}

// UserGrfHome 某用户的独立 GRF_HOME(users/<san>/grf-home)。仅 PerUserHome
// 布局下与 gh 实际使用的路径一致(共享 ~/.grf 形态下本值无意义,宿主管理
// 端点对此形态一律拒绝,见 PerUserHomeEnabled)。
func (m *Manager) UserGrfHome(uid string) string {
	return m.userGrfHome(uid)
}

// PerUserHomeEnabled 是否每用户独立 GRF_HOME 布局(宿主管理端点的前提;
// 共享 ~/.grf 形态没有按用户隔离的 settings/插件,声明类操作会被拒绝)。
func (m *Manager) PerUserHomeEnabled() bool { return m.cfg.PerUserHome }

// EnsureUserHome 建出(幂等)某用户的 grf-home 目录并返回路径。宿主供应商
// 声明/插件安装对「从未打开过 goder 的用户」也要能预先落盘(赶在 goder-serve
// 播种与 gh 首启之前),这是本方法存在的理由——不拉起进程,只准备目录。
func (m *Manager) EnsureUserHome(uid string) (string, error) {
	if !m.cfg.PerUserHome {
		return "", fmt.Errorf("共享 GRF_HOME 形态不支持按用户目录操作")
	}
	home := m.userGrfHome(uid)
	if err := os.MkdirAll(home, 0o755); err != nil {
		return "", err
	}
	return home, nil
}

// UserInfo 用户目录概览(ListUsers 条目)。
type UserInfo struct {
	San     string // 清洗后的目录名(=uid 清洗结果,宿主声明表口径)
	Running bool   // gh 进程是否在跑
	Addr    string // 在跑进程的监听地址
}

// ListUsers 扫描 users/ 下全部用户目录(按目录名有序)。目录名即清洗后的
// uid;不要求进程在跑——宿主的全量声明同步(如托管供应商渲染)恰恰要覆盖
// 「没在线但目录还在」的用户。users 目录不存在时返回空(还没有任何用户)。
func (m *Manager) ListUsers() []UserInfo {
	entries, err := os.ReadDir(filepath.Join(m.cfg.DataRoot, "users"))
	if err != nil {
		return nil
	}
	var out []UserInfo
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		ui := UserInfo{San: e.Name()}
		if addr := m.UserAddr(e.Name()); addr != "" {
			// UserAddr 以原始 uid 查注册表;清洗规则把非安全字符折叠为 _,
			// Get 注册用的原始 uid 与目录名可能不同(如含中文/空格的用户名)。
			// 这类用户查不到运行态只是概览缺一行,进程本身不受影响。
			ui.Running, ui.Addr = true, addr
		}
		out = append(out, ui)
	}
	return out
}

// DeleteUser 删除某用户的全部数据(先停进程再删目录,幂等)。宿主删号级联
// 清理用;目录不存在不报错。注意:以原始 uid 停进程、以清洗名删目录,两者
// 都要做——注册表键是原始 uid,磁盘目录是清洗名。
func (m *Manager) DeleteUser(uid string) error {
	m.Stop(uid) // 幂等:未注册时 no-op
	root := m.UserRoot(uid)
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.RemoveAll(root)
}
