//go:build !darwin && !windows

// native_other.go — 暂不支持原生内嵌的平台(Linux)占位实现:
// supported=false、创建返回 nil,Manager 放弃原生内容,前端浏览器面板
// 用 iframe 回退(见 internal/browser/native_linux* 的 g-term 版本可作
// 移植参照:GTK4 里在 GtkOverlay 上叠 WebKitGTK 子视图)。
package browser

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// supported:该平台尚未提供原生内嵌。
const supported = false

func allowFirstMouseWebviews() {}

func createBrowserView(_ *application.App, _ unsafe.Pointer, _ string) *view { return nil }

func viewLoadURL(_ *view, _ string) {}

func viewGoBack(_ *view)    {}
func viewGoForward(_ *view) {}
func viewReload(_ *view)    {}

func layoutChildView(_ unsafe.Pointer, _ *view, _, _, _, _ int) {}

func setViewVisible(_ *view, _ bool) {}

func setViewBackground(_ *view, _ string) {}

func closeView(_ *view) {}

// evalIn / snapshotIn:无原生 webview 的平台一律不支持。
func evalIn(_ *view, _ string) (string, error) { return "", ErrUnsupported }

func snapshotIn(_ *view) ([]byte, error) { return nil, ErrUnsupported }
