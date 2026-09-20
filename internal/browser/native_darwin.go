//go:build darwin

package browser

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <QuartzCore/QuartzCore.h>

// 在 AppKit 主线程同步执行 |work|。NSWindow/NSView 的变更必须在主线程;
// Manager 从 wails 服务 goroutine(Navigate、首次创建)与主线程关闭
// 路径(Close)两处调用,已在主线程时直接执行 —— 否则 dispatch_sync
// 到主队列会死锁。
static void grf_onMainSync(void(^work)(void)) {
	if ([NSThread isMainThread]) {
		work();
	} else {
		dispatch_sync(dispatch_get_main_queue(), work);
	}
}

// WKWebView 默认 acceptsFirstMouse: 返回 NO:主窗口非 key(比如别的
// 子视图持有焦点)时,第一次点击只激活窗口、不投递给 JS —— 切面板要
// 点两下。给类打一次补丁,让首击既激活又命中。
static void grf_allowFirstMouseWebviews(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		Method m = class_getInstanceMethod([WKWebView class], @selector(acceptsFirstMouse:));
		if (m) {
			method_setImplementation(m, imp_implementationWithBlock(^(id self, NSEvent* event) {
				return YES;
			}));
		}
	});
}

// --- 子视图模式 -------------------------------------------------------------
// 浏览器面板由本包自建的 WKWebView 渲染,直接嵌进主窗口 contentView
// —— 没有任何子窗口。内容属于唯一的真实窗口,移动/缩放/全屏自动跟随。
//
// Cookie 持久化:固定身份的 WKWebsiteDataStore(Wails 默认配置的
// webview 不会初始化 cookie 数据库,登录态随网络进程消失)。显式身份
// 的 store 把 cookie/localStorage/缓存持久化到
// ~/Library/WebKit/<app-identity>/WebsiteDataStore/<uuid>/,重启后登录
// 仍在。重置浏览器配置:删除该目录。

// 共享持久浏览器配置的固定身份。
#define GRF_BROWSER_STORE_UUID "6D9A2C31-9F4B-4A8D-83C2-2B7E5C0A41F6"

// 创建浏览器 WKWebView(共享 data store),作为隐藏、零尺寸子视图加入
// mainWin 的 contentView。hooks 非 NULL 时作为 document start 用户脚本
// 注入(每个新文档执行前跑一次:goder-console 的 console/网络捕获钩子)。
// 返回指针多持一次 retain(grf_detachView 释放),嵌入期间保持有效。
// 位置由 Manager 按前端 rect 上报布局。失败返回 NULL。
static void* grf_createBrowserView(void* mainWin, const char* hooks) {
	if (!mainWin) return NULL;
	__block WKWebView* created = nil;
	grf_onMainSync(^{
		@autoreleasepool {
			static WKWebsiteDataStore* store = nil;
			static dispatch_once_t once;
			dispatch_once(&once, ^{
				NSUUID* u = [[NSUUID alloc] initWithUUIDString:@GRF_BROWSER_STORE_UUID];
				store = [WKWebsiteDataStore dataStoreForIdentifier:u];
			});
			WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
			config.websiteDataStore = store;
			if (hooks && hooks[0]) {
				WKUserContentController* ucc = [[WKUserContentController alloc] init];
				[ucc addUserScript:[[WKUserScript alloc]
					initWithSource:[NSString stringWithUTF8String:hooks]
					injectionTime:WKUserScriptInjectionTimeAtDocumentStart
					forMainFrameOnly:YES]];
				config.userContentController = ucc;
			}
			WKWebView* w = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1, 1)
			                                          configuration:config];
			[w setWantsLayer:YES];
			w.hidden = YES;
			NSWindow* mw = (__bridge NSWindow*)mainWin;
			[mw.contentView addSubview:w];
			created = [w retain];
		}
	});
	if (!created) return NULL;
	return (__bridge void*)created;
}

// 在浏览器视图中加载绝对 URL。
static void grf_viewLoadURL(void* view, const char* url) {
	if (!view || !url) return;
	grf_onMainSync(^{
		@autoreleasepool {
			NSString* s = [NSString stringWithUTF8String:url];
			NSURLRequest* req = [NSURLRequest requestWithURL:[NSURL URLWithString:s]];
			[(__bridge WKWebView*)view loadRequest:req];
		}
	});
}

// 真导航的后退/前进与刷新(自有视图,无需 ExecJS 往返)。
static void grf_viewGoBack(void* view) {
	if (!view) return;
	grf_onMainSync(^{ @autoreleasepool { [(__bridge WKWebView*)view goBack]; } });
}

static void grf_viewGoForward(void* view) {
	if (!view) return;
	grf_onMainSync(^{ @autoreleasepool { [(__bridge WKWebView*)view goForward]; } });
}

static void grf_viewReload(void* view) {
	if (!view) return;
	grf_onMainSync(^{ @autoreleasepool { [(__bridge WKWebView*)view reload]; } });
}

// 把内嵌子视图放到 (x, y, w, h):主窗口视口相对 CSS 像素(左上原点),
// 翻转为 AppKit 左下原点的 contentView 坐标。对隐藏视图设置 frame 安全。
static void grf_layoutView(void* mainWin, void* view, int x, int y, int w, int h) {
	if (!mainWin || !view) return;
	grf_onMainSync(^{
		@autoreleasepool {
			NSWindow* mw = (__bridge NSWindow*)mainWin;
			NSView* v = (__bridge NSView*)view;
			NSRect b = mw.contentView.bounds;
			CGFloat fy = b.size.height - (CGFloat)(y + h);
			[v setFrame:NSMakeRect((CGFloat)x, fy, (CGFloat)w, (CGFloat)h)];
		}
	});
}

// 设置 webview 底色(underPageBackgroundColor 与 layer 背景同时置),
// 消除边缘发丝缝露出的 WebKit 默认白。
static void grf_setViewBackground(void* view, double r, double g, double b, double a) {
	if (!view) return;
	grf_onMainSync(^{
		@autoreleasepool {
			NSView* v = (__bridge NSView*)view;
			NSColor* c = [NSColor colorWithCalibratedRed:r green:g blue:b alpha:a];
			if ([v isKindOfClass:[WKWebView class]]) {
				[(WKWebView*)v setUnderPageBackgroundColor:c];
			}
			v.layer.backgroundColor = [c CGColor];
		}
	});
}

// 显示/隐藏内嵌子视图。
static void grf_setViewHidden(void* view, bool hidden) {
	if (!view) return;
	grf_onMainSync(^{
		@autoreleasepool {
			((__bridge NSView*)view).hidden = hidden;
		}
	});
}

// 从主窗口移除内嵌子视图并释放创建时多持的 retain。
static void grf_detachView(void* view) {
	if (!view) return;
	grf_onMainSync(^{
		@autoreleasepool {
			NSView* v = (__bridge NSView*)view;
			[v removeFromSuperview];
			CFRelease((__bridge CFTypeRef)view);
		}
	});
}
*/
import "C"

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// supported:macOS 走本包自建的 WKWebView 子视图。
const supported = true

func allowFirstMouseWebviews() {
	C.grf_allowFirstMouseWebviews()
}

// createBrowserView 创建共享持久 data store 的 WKWebView,隐藏嵌入
// 主窗口 contentView;失败返回 nil。app 未使用(macOS 无需托管窗口)。
// hooks 作为 document start 用户脚本注入(console/网络捕获钩子)。
func createBrowserView(_ *application.App, mainWin unsafe.Pointer, hooks string) *view {
	if mainWin == nil {
		return nil
	}
	var ch *C.char
	if hooks != "" {
		ch = C.CString(hooks)
		defer C.free(unsafe.Pointer(ch))
	}
	p := C.grf_createBrowserView(mainWin, ch)
	if p == nil {
		return nil
	}
	return &view{h: p}
}

// viewLoadURL 在视图中加载绝对 URL。
func viewLoadURL(v *view, url string) {
	if v == nil || v.h == nil || url == "" {
		return
	}
	c := C.CString(url)
	defer C.free(unsafe.Pointer(c))
	C.grf_viewLoadURL(v.h, c)
}

// viewGoBack / viewGoForward 步进视图自身导航历史;viewReload 刷新。
func viewGoBack(v *view) {
	if v != nil && v.h != nil {
		C.grf_viewGoBack(v.h)
	}
}

func viewGoForward(v *view) {
	if v != nil && v.h != nil {
		C.grf_viewGoForward(v.h)
	}
}

func viewReload(v *view) {
	if v != nil && v.h != nil {
		C.grf_viewReload(v.h)
	}
}

// layoutChildView 把内嵌子视图布局到面板 rect(视口相对 CSS 像素,
// 左上原点;y 在内部翻转)。
func layoutChildView(mainWin unsafe.Pointer, v *view, x, y, w, h int) {
	if mainWin == nil || v == nil || v.h == nil {
		return
	}
	C.grf_layoutView(mainWin, v.h, C.int(x), C.int(y), C.int(w), C.int(h))
}

// setViewVisible 显示/隐藏内嵌子视图。
func setViewVisible(v *view, visible bool) {
	if v == nil || v.h == nil {
		return
	}
	C.grf_setViewHidden(v.h, C.bool(!visible))
}

// setViewBackground 设置视图底色,消除边缘发丝缝露出的 WebKit 默认白。
func setViewBackground(v *view, css string) {
	if v == nil || v.h == nil {
		return
	}
	r, g, b, a, ok := parseCSSColor(css)
	if !ok {
		return
	}
	C.grf_setViewBackground(v.h, C.double(r), C.double(g), C.double(b), C.double(a))
}

// closeView 从主窗口移除内嵌子视图并释放嵌入时的 retain。
func closeView(v *view) {
	if v == nil || v.h == nil {
		return
	}
	C.grf_detachView(v.h)
	v.h = nil
}
