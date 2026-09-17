// Package browser 持有内嵌浏览器面板的原生 webview。
//
// 浏览器面板只有一块原生内容,直接显示在主窗口内部(任何平台都不开
// 独立 OS 窗口):macOS 上本包自建 WKWebView(共享固定身份的
// WKWebsiteDataStore —— 登录态跨重启持久、所有会话共享),作为主窗口
// contentView 的隐藏子视图嵌入;导航走原生 WebKit 调用。不支持内嵌的
// 平台创建失败,面板保持纯前端(iframe 回退)。
//
// 内容始终属于同一个真实窗口:随窗口移动/缩放/全屏自动跟随,无需
// 层叠修复;几何完全来自前端的 rect 上报(SetRect)。
// 实现移植自 g-term 项目的 internal/browser(多 tab 版本的简化)。
package browser

import (
	"log/slog"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type rect struct{ x, y, w, h int }

// view 是内嵌的原生 webview;nil 表示尚未创建(或平台不支持)。
type view struct {
	v unsafe.Pointer
	// visible 镜像面板的前端可见状态;只有可见时才展示原生内容。
	visible bool
	// navigated:至少加载过一次 URL。此前没有可展示的原生内容,
	// 空态由前端绘制。
	navigated bool
}

// Manager 持有内嵌 webview,并按前端上报的面板 rect 布局。所有方法
// 在 wails app / 主窗口就绪前调用均安全(no-op)。
type Manager struct {
	log     *slog.Logger
	app     *application.App
	mu      sync.Mutex
	mainWin application.Window
	v       *view
	rc      rect
	hasRc   bool
	// bg:前端上报的主题底色(CSS 颜色串)。原生视图创建晚于上报时,
	// ensureView 里补设。
	bg string
}

// NewManager 构建 Manager。app 用于查找主窗口并创建内容;前端只在
// 启动完成后才会调用,届时必然就绪。
func NewManager(log *slog.Logger, app *application.App) *Manager {
	return &Manager{log: log, app: app}
}

// resolve 缓存主窗口。调用方须持有 m.mu。
func (m *Manager) resolve() bool {
	if m.mainWin != nil {
		return true
	}
	if m.app == nil {
		return false
	}
	w, ok := m.app.Window.GetByName("main")
	if !ok || w == nil {
		return false
	}
	m.mainWin = w
	// 此处不加 WindowClosing 监听:窗口关闭路径里做同步主线程往返会
	// 死锁;收尾统一走 ServiceShutdown(主线程安全)。
	allowFirstMouseWebviews()
	return true
}

// ensureView 首次使用时创建内容,否则原样返回。平台无法内嵌时返回 nil
// (下次调用重试)。调用方须持有 m.mu。
func (m *Manager) ensureView() *view {
	if m.v != nil {
		return m.v
	}
		if p := m.mainWin.NativeWindow(); p != nil {
			if v := createBrowserView(p); v != nil {
				m.v = &view{v: v}
				if m.bg != "" {
					setViewBackground(v, m.bg)
				}
				return m.v
			}
		}
	m.log.Error("[browser] 原生 webview 创建失败,面板回退 iframe")
	return nil
}

// Navigate 打开(必要时先创建内容)或导航到 url。可见性由 Show/Hide
// 拥有:仅导航不会展示内容。
func (m *Manager) Navigate(url string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.resolve() {
		m.log.Warn("[browser] 主窗口未就绪,导航被丢弃")
		return
	}
	v := m.ensureView()
	if v == nil {
		return
	}
	if url != "" {
		viewLoadURL(v.v, url)
		v.navigated = true
	}
	m.repositionLocked()
	if v.visible && m.hasRc {
		setChildViewHidden(v.v, false)
	}
}

// Show 展示内嵌内容(面板激活时调用)。内容按需创建,Show 抢在
// Navigate 之前到达也不会丢。
func (m *Manager) Show() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.resolve() {
		return
	}
	v := m.ensureView()
	if v == nil {
		return
	}
	v.visible = true
	if !m.hasRc || !v.navigated {
		return
	}
	// 先布局再展示,避免闪出旧帧。
	m.repositionLocked()
	setChildViewHidden(v.v, false)
}

// Hide 隐藏内嵌内容(离开浏览器面板时调用)。nil 安全。
func (m *Manager) Hide() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.v == nil {
		return
	}
	m.v.visible = false
	setChildViewHidden(m.v.v, true)
}

// SetRect 上报浏览器面板的 rect(视口相对 CSS 像素,即
// Element.getBoundingClientRect() 的返回值)。会触发展示(若此前
// Navigate 先于首个 rect 到达)。
func (m *Manager) SetRect(x, y, w, h int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rc = rect{x, y, w, h}
	m.hasRc = true
	if m.v == nil || !m.v.visible || !m.v.navigated {
		return
	}
	m.repositionLocked()
	setChildViewHidden(m.v.v, false)
}

// SetBackground 设置原生视图底色(css:前端主题卡片色)。WebKit 默认
// 白底,深色主题下视图边缘不足 1px 的发丝缝会露白;置为主题色后不可见。
func (m *Manager) SetBackground(css string) {
	if css == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bg = css
	if m.v != nil {
		setViewBackground(m.v.v, css)
	}
}

// Back / Forward / Reload 驱动视图自身的导航历史(原生调用)。
func (m *Manager) Back() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.v != nil {
		viewGoBack(m.v.v)
	}
}

func (m *Manager) Forward() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.v != nil {
		viewGoForward(m.v.v)
	}
}

func (m *Manager) Reload() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.v != nil {
		viewReload(m.v.v)
	}
}

// Close 销毁内嵌内容(app 退出时调用)。只可从前端调用路径(wails
// 服务 goroutine)与 ServiceShutdown 调用,不要在窗口关闭回调里调
// (teardown 做同步主线程往返,会死锁)。
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.v == nil {
		return
	}
	detachChildView(m.v.v)
	m.v = nil
}

// repositionLocked 把内容布局到上报的面板 rect 上。调用方须持有 m.mu。
func (m *Manager) repositionLocked() {
	if m.v == nil || m.mainWin == nil || !m.hasRc {
		return
	}
	layoutChildView(m.mainWin.NativeWindow(), m.v.v, m.rc.x, m.rc.y, m.rc.w, m.rc.h)
}
