//go:build darwin

// native_darwin_eval.go — 面板 WKWebView 的 JS 求值与截图(cgo 回调桥)。
// //export 要求所在文件的前导区只含声明,故与 native_darwin.go(前导区
// 有函数定义)分文件;本文件自带 dispatch_async,不依赖那边的静态函数。
// 求值/截图一律异步派发到主线程:完成回调也在主线程执行,若调用方同步
// 占着主线程会死锁,异步 + 等待表(见 eval.go)两不相扰。
//
// extern 原型必须与 cgo 为 //export 函数生成的原型完全一致(纯 C 类型:
// C.ulonglong→unsigned long long、C.int→int、*C.char→char*、
// unsafe.Pointer→void*),否则 _cgo_export.c 里两份声明冲突。
package browser

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// Go 侧 //export 提供的完成回调(见文件底部)。
extern void goder_evalDone(unsigned long long cookie, int ok, char* res, char* err);
extern void goder_shotDone(unsigned long long cookie, void* data, int len, char* err);

// goder_evalJS 在 webview 里求值 JS,结果(字符串)或错误经 goder_evalDone
// 按 cookie 回传。用 callAsyncJavaScript 而非 evaluateJavaScript:后者不
// await Promise,信封表达式(async IIFE)拿到的是 Promise 对象,完成
// 回调报 "unsupported type";callAsyncJavaScript 的函数体本身是 async,
// return 的 Promise 会被解析出最终字符串。
static void goder_evalJS(void* view, const char* js, unsigned long long cookie) {
	if (!view || !js) { goder_evalDone(cookie, 0, "", "视图不存在"); return; }
	NSString* body = [@"return " stringByAppendingString:[NSString stringWithUTF8String:js]];
	dispatch_async(dispatch_get_main_queue(), ^{
		[(WKWebView*)view callAsyncJavaScript:body
		                            arguments:@{}
		                              inFrame:nil
		                       inContentWorld:[WKContentWorld pageWorld]
		                  completionHandler:^(id result, NSError* error) {
			char* res = "";
			if (result) res = (char*)[[NSString stringWithFormat:@"%@", result] UTF8String];
			char* err = error ? (char*)[error.localizedDescription UTF8String] : (char*)"";
			goder_evalDone(cookie, error == nil, res, err);
		}];
	});
}

// goder_snapshotView 截取 webview 当前视口画面为 PNG,经 goder_shotDone 回传。
// 视图隐藏(用户不在浏览器面板)时画面可能是最后一帧,由调用方知晓。
static void goder_snapshotView(void* view, unsigned long long cookie) {
	if (!view) { goder_shotDone(cookie, NULL, 0, "视图不存在"); return; }
	dispatch_async(dispatch_get_main_queue(), ^{
		WKWebView* w = (WKWebView*)view;
		WKSnapshotConfiguration* cfg = [[WKSnapshotConfiguration alloc] init];
		cfg.rect = w.bounds;
		[w takeSnapshotWithConfiguration:cfg completionHandler:^(NSImage* img, NSError* error) {
			if (error || !img) {
				char* e = error ? (char*)[error.localizedDescription UTF8String] : (char*)"空图像";
				goder_shotDone(cookie, NULL, 0, e);
				return;
			}
			NSData* tiff = [img TIFFRepresentation];
			NSBitmapImageRep* rep = tiff ? [NSBitmapImageRep imageRepWithData:tiff] : nil;
			NSData* png = rep ? [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
			if (!png) { goder_shotDone(cookie, NULL, 0, "PNG 编码失败"); return; }
			goder_shotDone(cookie, (void*)png.bytes, (int)png.length, (char*)"");
		}];
	});
}
*/
import "C"

import (
	"unsafe"
)

// evalIn darwin 实现:原生 evaluateJavaScript + 完成回调进等待表。
func evalIn(v *view, envelope string) (string, error) {
	id := nextEvalCookie()
	ch := registerEvalWaiter(id)
	cJs := C.CString(envelope)
	defer C.free(unsafe.Pointer(cJs))
	C.goder_evalJS(v.h, cJs, C.ulonglong(id))
	res, err := waitEval(id, ch)
	return res.text, err
}

// snapshotIn darwin 实现:takeSnapshot → PNG。
func snapshotIn(v *view) ([]byte, error) {
	id := nextEvalCookie()
	ch := registerEvalWaiter(id)
	C.goder_snapshotView(v.h, C.ulonglong(id))
	res, err := waitEval(id, ch)
	return res.png, err
}

// goder_evalDone cgo 求值完成回调(主线程):字符串立即复制后唤醒等待方。
//
//export goder_evalDone
func goder_evalDone(cookie C.ulonglong, ok C.int, res, errStr *C.char) {
	out := evalResult{text: C.GoString(res)}
	if ok == 0 {
		out.err = C.GoString(errStr)
	}
	deliverEval(uint64(cookie), out)
}

// goder_shotDone cgo 截图完成回调(主线程):PNG 字节复制后唤醒等待方。
//
//export goder_shotDone
func goder_shotDone(cookie C.ulonglong, data unsafe.Pointer, n C.int, errStr *C.char) {
	out := evalResult{}
	if msg := C.GoString(errStr); msg != "" {
		out.err = msg
	} else if n > 0 && data != nil {
		out.png = C.GoBytes(data, n)
	} else {
		out.err = "空截图"
	}
	deliverEval(uint64(cookie), out)
}
