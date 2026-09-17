//go:build !windows

// ghdownload_silent.go — 非 Windows 平台(macOS/Linux)的 gh 自动下载:
// 静默执行、无对话框,进度只打日志 —— main 的环境检查门在主窗体前同步
// 完成下载。Windows 的原生对话框形态见 ghdownload_windows.go。
package desktop

import "log"

// ensureGhDownload 静默形态:计划(planGhDownload)→ 下载 → 日志。
func ensureGhDownload() (string, error) {
	p, err := planGhDownload()
	if err != nil {
		return "", err
	}
	dl := &ghDownload{version: p.ver}
	log.Printf("[ghdownload] 未检测到 gh,自动下载 gh %s → %s", p.ver, p.dst)
	if err := dl.run(p.url, p.dst); err != nil {
		return "", err
	}
	log.Printf("[ghdownload] gh %s 下载完成", p.ver)
	return p.dst, nil
}
