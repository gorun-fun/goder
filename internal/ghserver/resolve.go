// resolve.go — gh 可执行文件解析:独立分发的 .app 内捆绑 gh 副本,用户
// 无需预装;偏好设置的显式配置优先于捆绑副本与常见安装目录,最后才
// 依赖 PATH(桌面 App 从 Finder/Dock 启动时 PATH 往往只有系统目录,
// 不能作为唯一解析途径)。
package ghserver

import (
	"os"
	"os/exec"
	"path/filepath"
)

// ResolveGhBin 解析 gh 可执行文件路径,返回可执行绝对路径;找不到返回空。
// 顺序:configured(显式配置,可为名字或路径)→ 当前可执行文件同目录的
// 捆绑副本(App.app/Contents/MacOS/gh)→ 常见安装目录 → PATH。
func ResolveGhBin(configured string) string {
	for _, cand := range ghCandidates(configured) {
		if p := lookup(cand); p != "" {
			return p
		}
	}
	return ""
}

// ghCandidates 候选列表(未配置时 configured 项缺席)。
func ghCandidates(configured string) []string {
	var cands []string
	if configured != "" {
		cands = append(cands, configured)
	}
	// 捆绑副本:与本程序同目录(build.sh 组装 .app 时拷入 Contents/MacOS)
	if exe, err := os.Executable(); err == nil {
		cands = append(cands, filepath.Join(filepath.Dir(exe), "gh"))
	}
	// 常见安装目录(用户自装但不在 Finder App 的 PATH 里)
	if home, err := os.UserHomeDir(); err == nil {
		cands = append(cands, filepath.Join(home, "bin", "gh"))
	}
	cands = append(cands,
		"/opt/homebrew/bin/gh", // Apple Silicon homebrew
		"/usr/local/bin/gh",    // Intel homebrew / 手动安装
		"/usr/bin/gh",
		"gh", // PATH 兜底
	)
	return cands
}

// lookup 单个候选解析:含路径分隔符直接验证可执行,否则走 PATH 查找。
func lookup(cand string) string {
	if cand == "" {
		return ""
	}
	if filepath.Base(cand) != cand { // 显式路径
		if st, err := os.Stat(cand); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return cand
		}
		return ""
	}
	if p, err := exec.LookPath(cand); err == nil {
		return p
	}
	return ""
}
