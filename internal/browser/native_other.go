//go:build !darwin

// native_other.go — 暂不支持原生内嵌的平台(Linux/Windows)占位实现:
// 所有创建返回 nil,Manager 放弃原生内容,前端浏览器面板回退 iframe。
// (Linux/Windows 的原生内嵌可参照 g-term 项目的 internal/browser 移植:
// GTK4 WebKitGTK 子视图 / wails 子窗口 HWND 重父级。)
package browser

import "unsafe"

func allowFirstMouseWebviews() {}

func createBrowserView(mainWin unsafe.Pointer) unsafe.Pointer { return nil }

func viewLoadURL(view unsafe.Pointer, url string) {}

func viewGoBack(view unsafe.Pointer)    {}
func viewGoForward(view unsafe.Pointer) {}
func viewReload(view unsafe.Pointer)    {}

func layoutChildView(mainWin, view unsafe.Pointer, x, y, w, h int) {}

func setChildViewHidden(view unsafe.Pointer, hidden bool) {}

func setViewBackground(view unsafe.Pointer, css string) {}

func detachChildView(view unsafe.Pointer) {}
