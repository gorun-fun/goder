// browser.go — BrowserManager 服务:内嵌浏览器面板的原生 webview 薄壳。
// 前端 grf-browser 面板经 desktop.BrowserManager.* 导航并上报面板 rect;
// 实际生命周期/布局逻辑在 internal/browser.Manager(app 退出时销毁)。
package desktop

import (
	"context"
	"log/slog"
	"os"

	"git.gorun.fun/share/goder/internal/browser"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// BrowserManager wails 服务。全局单例。
type BrowserManager struct {
	m *browser.Manager
}

var browserManager = &BrowserManager{}

// GetBrowserManager 取全局 BrowserManager。
func GetBrowserManager() *BrowserManager { return browserManager }

// ServiceStartup wails 启动钩子:app 就绪后构建 browser.Manager。
func (b *BrowserManager) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	b.m = browser.NewManager(slog.New(slog.NewTextHandler(os.Stderr, nil)), application.Get())
	return nil
}

// ServiceShutdown wails 退出钩子:销毁内嵌 webview。
func (b *BrowserManager) ServiceShutdown() error {
	if b.m != nil {
		b.m.Close()
	}
	return nil
}

// Navigate 打开(必要时创建)原生 webview 并导航到 url。空 url 仅确保
// 内容存在,不导航。
func (b *BrowserManager) Navigate(url string) {
	if b.m != nil {
		b.m.Navigate(url)
	}
}

// Show / Hide 展示/隐藏原生内容(随浏览器面板激活状态)。
func (b *BrowserManager) Show() {
	if b.m != nil {
		b.m.Show()
	}
}

func (b *BrowserManager) Hide() {
	if b.m != nil {
		b.m.Hide()
	}
}

// SetRect 上报浏览器面板 rect(视口相对 CSS 像素,来自
// Element.getBoundingClientRect());原生内容随之布局。
func (b *BrowserManager) SetRect(x, y, w, h int) {
	if b.m != nil {
		b.m.SetRect(x, y, w, h)
	}
}

// SetBackground 设置原生 webview 底色(CSS 颜色串,来自前端主题)。
func (b *BrowserManager) SetBackground(css string) {
	if b.m != nil {
		b.m.SetBackground(css)
	}
}

// Back / Forward / Reload 驱动原生 webview 自身的导航历史。
func (b *BrowserManager) Back() {
	if b.m != nil {
		b.m.Back()
	}
}

func (b *BrowserManager) Forward() {
	if b.m != nil {
		b.m.Forward()
	}
}

func (b *BrowserManager) Reload() {
	if b.m != nil {
		b.m.Reload()
	}
}
