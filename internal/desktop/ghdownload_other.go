//go:build !windows

// ghdownload_other.go — 非 Windows 形态不弹下载 UI:macOS .app 已捆绑 gh,
// Linux zip 亦捆绑;缺失时沿用偏好设置手动配置路径的既有路径。
package desktop

import "fmt"

// ensureGhDownloadUI 非 Windows 不提供交互式下载。
func ensureGhDownloadUI() (string, error) {
	return "", fmt.Errorf("未找到 gh 二进制(未捆绑且未安装)")
}
