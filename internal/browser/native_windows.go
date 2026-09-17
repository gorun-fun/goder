//go:build windows

// native_windows.go — Windows 上的内嵌浏览器内容。
//
// 机制(同 g-term):先让 Wails 建一座窗口承载内容(WebView2 归它托管,
// SetURL/Reload/ExecJS 都还在),再把它的 HWND 重父级进主窗口做 WS_CHILD
// 子窗口。子窗口不进任务栏/alt-tab,随主窗口移动/缩放/最小化自动跟随;
// 几何完全来自前端上报的面板 rect(SetRect),按主窗口 DPI 换算物理像素。
//
// 显隐一律走托管窗口的 Show/Hide(不裸调 ShowWindow):Wails 需同步 WebView2
// 控制器的可见性,否则首次导航(在隐藏态发生)之后控制器仍是隐藏的,
// 露出子窗口也只会得到一块永久空白。
//
// 只用 user32 的 syscall(与 CI 的 CGO_ENABLED=0 GOOS=windows 交叉编译一致),
// 不引 cgo。
package browser

import (
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	procSetWindowLongPtr = user32.NewProc("SetWindowLongPtrW")
	procGetWindowLongPtr = user32.NewProc("GetWindowLongPtrW")
	procSetWindowPos     = user32.NewProc("SetWindowPos")
	procSetParent        = user32.NewProc("SetParent")
	procGetDpiForWindow  = user32.NewProc("GetDpiForWindow")
)

// Window 样式常量。
const (
	gwlStyle   = uintptr(^uintptr(15)) // GWL_STYLE == -16,以 uintptr 符号扩展传入
	gwlExStyle = uintptr(^uintptr(19)) // GWL_EXSTYLE == -20

	wsChild        = 0x40000000
	wsClipsiblings = 0x04000000
	wsPopup        = 0x80000000
	wsCaption      = 0x00C00000
	wsThickframe   = 0x00040000
	wsSysmenu      = 0x00080000
	wsMinimizebox  = 0x00020000
	wsMaximizebox  = 0x00010000
	wsDlgframe     = 0x00400000

	wsExAppwindow = 0x00040000

	swpNoSize       = uintptr(0x0001)
	swpNomove       = uintptr(0x0002)
	swpNozorder     = uintptr(0x0004)
	swpNoactivate   = uintptr(0x0010)
	swpFramechanged = uintptr(0x0020)
)

// supported:Windows 用 Wails 窗口重父级托管 WebView2。
const supported = true

// allowFirstMouseWebviews:Windows 上子窗口不会吞掉主窗口的点击,无需补丁。
func allowFirstMouseWebviews() {}

// createBrowserView 建托管窗口并把它的 HWND 重父级进主窗口;失败返回 nil
// (调用方放弃原生内容,面板回退 iframe)。
func createBrowserView(app *application.App, mainWin unsafe.Pointer) *view {
	if app == nil || mainWin == nil {
		return nil
	}
	// URL 空串会被 Wails 改写成 "/"(应用自身前端),所以先落 about:blank:
	// 首次导航之前的窗口绝不能被展示,空态由前端绘制。
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:          "browser",
		Title:         "浏览器",
		URL:           "about:blank",
		Frameless:     true,
		Hidden:        true,
		DisableResize: true,
	})
	if win == nil {
		return nil
	}
	child := win.NativeWindow()
	if child == nil || !embedChildWindow(mainWin, child) {
		win.Close()
		return nil
	}
	return &view{h: child, win: win}
}

// embedChildWindow 把子窗口 HWND 重父级进主窗口,成为盖在主窗口 WebView2
// 之上的 WS_CHILD 面板。返回是否成功。
func embedChildWindow(parent, child unsafe.Pointer) bool {
	if parent == nil || child == nil {
		return false
	}
	hwndParent := uintptr(parent)
	hwndChild := uintptr(child)

	style := getWindowLongPtr(hwndChild, gwlStyle)
	if style == 0 {
		return false
	}
	// 去掉全部弹窗/边框装饰:纯 WS_CHILD 面板,位置与裁剪只由我们的
	// SetWindowPos 负责。
	style &^= wsPopup | wsCaption | wsThickframe | wsSysmenu | wsMinimizebox | wsMaximizebox | wsDlgframe
	style |= wsChild | wsClipsiblings
	setWindowLongPtr(hwndChild, gwlStyle, style)
	exStyle := getWindowLongPtr(hwndChild, gwlExStyle)
	exStyle &^= wsExAppwindow // 永不进任务栏/alt-tab
	setWindowLongPtr(hwndChild, gwlExStyle, exStyle)

	if r1, _, _ := procSetParent.Call(hwndChild, hwndParent); r1 == 0 {
		return false
	}
	// 让样式变更生效(SWP_FRAMECHANGED)并把子窗口压到同级最上层
	// (同一父窗口的子窗口是兄弟, HWND_TOP 取胜);尺寸交给 layoutChildView。
	const hwndTop = uintptr(0)
	procSetWindowPos.Call(hwndChild, hwndTop, 0, 0, 0, 0,
		swpNomove|swpNoSize|swpNoactivate|swpFramechanged)
	return true
}

// viewLoadURL 导航托管窗口(URL 由 Wails 转交 WebView2)。
func viewLoadURL(v *view, url string) {
	if v == nil || v.win == nil || url == "" {
		return
	}
	v.win.SetURL(url)
}

// viewGoBack / viewGoForward / viewReload:托管窗口上以 JS/原生调用驱动
// 自身历史(与 g-term 同款)。
func viewGoBack(v *view) {
	if v != nil && v.win != nil {
		v.win.ExecJS("history.back()")
	}
}

func viewGoForward(v *view) {
	if v != nil && v.win != nil {
		v.win.ExecJS("history.forward()")
	}
}

func viewReload(v *view) {
	if v != nil && v.win != nil {
		v.win.Reload()
	}
}

// layoutChildView 把子窗口放到面板 rect:前端上报 CSS 像素(视口相对),
// 子窗口坐标是父窗口客户区的物理像素,按主窗口 DPI 缩放。
func layoutChildView(mainWin unsafe.Pointer, v *view, x, y, w, h int) {
	if mainWin == nil || v == nil || v.h == nil {
		return
	}
	scale := 1.0
	if dpi, _, _ := procGetDpiForWindow.Call(uintptr(mainWin)); dpi != 0 {
		scale = float64(dpi) / 96.0
	}
	px := uintptr(int64(float64(x)*scale + 0.5))
	py := uintptr(int64(float64(y)*scale + 0.5))
	pw := uintptr(int64(float64(w)*scale + 0.5))
	ph := uintptr(int64(float64(h)*scale + 0.5))
	procSetWindowPos.Call(uintptr(v.h), 0, px, py, pw, ph, swpNozorder|swpNoactivate)
}

// setViewVisible 显示/隐藏原生内容:必须走托管窗口(Wails 同步 WebView2
// 控制器的可见性;裸 ShowWindow 会让页面永久空白)。
func setViewVisible(v *view, visible bool) {
	if v == nil || v.win == nil {
		return
	}
	if visible {
		v.win.Show()
		return
	}
	v.win.Hide()
}

// setViewBackground 设置内容底色(WebView2 默认白),消除边缘发丝缝露白。
func setViewBackground(v *view, css string) {
	if v == nil || v.win == nil {
		return
	}
	r, g, b, a, ok := parseCSSColor(css)
	if !ok {
		return
	}
	v.win.SetBackgroundColour(application.NewRGBA(
		uint8(r*255+0.5), uint8(g*255+0.5), uint8(b*255+0.5), uint8(a*255+0.5)))
}

// closeView 销毁托管窗口(子窗口 HWND 于是随之销毁,无需还原父子关系)。
func closeView(v *view) {
	if v == nil || v.win == nil {
		return
	}
	v.win.Close()
	v.h = nil
	v.win = nil
}

func getWindowLongPtr(hwnd, index uintptr) uintptr {
	r1, _, _ := procGetWindowLongPtr.Call(hwnd, index)
	return r1
}

func setWindowLongPtr(hwnd, index, value uintptr) {
	procSetWindowLongPtr.Call(hwnd, index, value)
}
