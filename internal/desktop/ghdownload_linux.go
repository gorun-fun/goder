//go:build linux

// ghdownload_linux.go — Linux 上 gh 的静默下载:发行包不再捆绑 gh,缺失时
// 自动下载(与 Windows 落点一致:<配置目录>/bin/gh)。无原生弹窗 UI,
// 进度只打日志 —— main 的环境检查门在主窗体前同步完成下载。
package desktop

import (
	"fmt"
	"log"
)

// ensureGhDownloadUI Linux 形态:静默下载,无对话框。
func ensureGhDownloadUI() (string, error) {
	dir, err := ghPlatformDir()
	if err != nil {
		return "", err
	}
	ver, err := latestGhVersion()
	if err != nil {
		return "", fmt.Errorf("检查下载服务器失败: %w", err)
	}
	dst, err := managedGhPath()
	if err != nil {
		return "", err
	}
	url := ghDlBase + "/" + dir + "/" + ver + "/" + ghExeName()
	dl := &ghDownload{version: ver}
	log.Printf("[ghdownload] 未检测到 gh,自动下载 gh %s → %s", ver, dst)
	if err := dl.run(url, dst); err != nil {
		return "", err
	}
	log.Printf("[ghdownload] gh %s 下载完成", ver)
	return dst, nil
}
