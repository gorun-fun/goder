// ghdownload_windows.go — gh 自动下载的 Windows 原生 UI 形态。
// 流程:MessageBox 确认(检查环境并下载)→ TaskDialog 进度条(可取消)
// → 完成或失败提示。TaskDialog 依赖 comctl32 v6 声明(仓库根 syso 内的
// gui manifest 已含);调用失败时静默回退为无进度条下载。静默形态见
// ghdownload_silent.go。
package desktop

import (
	"fmt"
	"sync/atomic"
	"syscall"
	"unsafe"
)

var (
	user32                 = syscall.NewLazyDLL("user32.dll")
	comctl32               = syscall.NewLazyDLL("comctl32.dll")
	procMessageBoxW        = user32.NewProc("MessageBoxW")
	procTaskDialogIndirect = comctl32.NewProc("TaskDialogIndirect")
	procPostMessageW       = user32.NewProc("PostMessageW")
	procSendMessageW       = user32.NewProc("SendMessageW")
)

const (
	mbYesNo        = 0x00000004
	mbIconQuestion = 0x00000020
	mbIconError    = 0x00000010
	mbIconInfo     = 0x00000040
	idYes          = 6

	wmClose = 0x0010

	// TaskDialog 常量(commdlg.h)
	tdCallbackTimer      = 0x00000800
	tdCancelButton       = 0x00000008
	tdiCancelButton      = 2
	tdnTimer             = 4    // 任务对话框回调:定时器
	tdmSetProgressBarPos = 1126 // WM_USER+102 邻域消息(注册表固定值)
)

// mbResult int 返回值转可判定的 int32。
func messageBox(text, caption string, flags uintptr) int32 {
	ret, _, _ := procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(text))),
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(caption))),
		flags,
	)
	return int32(ret)
}

// taskDialogCallback TaskDialog 回调:定时器驱动进度条,并检查下载取消。
// 下载上下文经 activeDownload 全局原子指针传递(避免 unsafe 指针整数转换;
// 同时只有一个下载对话框)。
var activeDownload atomic.Pointer[ghDownload]

func taskDialogCallback(hwnd uintptr, msg uint32, _, _ uintptr, _ uintptr) uintptr {
	dl := activeDownload.Load()
	if dl == nil {
		return 0
	}
	switch msg {
	case tdnTimer:
		procSendMessageW.Call(hwnd, tdmSetProgressBarPos, uintptr(dl.pct.Load()), 0)
		if dl.cancel.Load() || dl.pct.Load() >= 100 {
			procPostMessageW.Call(hwnd, wmClose, 0, 0)
		}
	}
	return 0 // S_OK
}

// taskDialogConfig TASKDIALOGCONFIG(仅用到本流程所需字段;结构布局须与
// WinSDK 一致,字段齐全以保对齐正确)。
type taskDialogConfig struct {
	Size             uint32
	Parent           uintptr
	Instance         uintptr
	Flags            uint32
	Buttons          uintptr
	CommonButtons    uint32
	Icon             uintptr
	Content          *uint16
	Instruction      *uint16
	Additional       *uint16
	VerificationText *uint16
	Footer           *uint16
	Callback         uintptr
	CallbackData     uintptr
	Width            uint32
}

// runProgressDialog 弹出带进度条的可取消 TaskDialog,直到下载结束。
// hwnd 经回调存储,结束(含取消)后 PostMessage WM_CLOSE 关闭。
func runProgressDialog(dl *ghDownload, title string) {
	activeDownload.Store(dl)
	defer activeDownload.Store(nil)
	cfg := &taskDialogConfig{
		Size:        uint32(unsafe.Sizeof(taskDialogConfig{})),
		Flags:       tdCallbackTimer | tdCancelButton,
		Instruction: syscall.StringToUTF16Ptr("正在下载 gh(grf-harness)"),
		Content:     syscall.StringToUTF16Ptr(title + "\n下载完成后将自动继续启动。"),
		Callback:    syscall.NewCallback(taskDialogCallback),
	}
	var btn int32
	_, _, _ = procTaskDialogIndirect.Call(
		uintptr(unsafe.Pointer(cfg)),
		uintptr(unsafe.Pointer(&btn)),
		0, 0,
	)
	if btn == tdiCancelButton {
		dl.cancel.Store(true)
	}
}

// ensureGhDownload gh 缺失时的交互式下载入口(仅 Windows 弹 UI)。
// 返回下载后的 gh 路径;用户拒绝/失败时返回错误(错误信息已弹框展示)。
func ensureGhDownload() (string, error) {
	const caption = "Goder 环境检查"
	p, err := planGhDownload()
	if err != nil {
		messageBox(err.Error(), caption, mbIconError)
		return "", err
	}
	if messageBox(
		"Goder 需要配套的 gh(grf-harness)服务组件,当前系统未检测到。\n\n"+
			"是否现在自动下载并安装?("+p.sizeDesc()+",来自官方下载服务器)",
		caption, mbYesNo|mbIconQuestion) != idYes {
		return "", fmt.Errorf("用户取消 gh 下载;也可在偏好设置里手动配置 gh 路径")
	}
	dl := &ghDownload{version: p.ver}

	// 下载在后台协程;TaskDialog 阻塞展示进度直到回调里检测到结束。
	done := make(chan error, 1)
	go func() { done <- dl.run(p.url, p.dst) }()
	go runProgressDialog(dl, "gh "+p.ver+" → "+p.dst)
	if err = <-done; err != nil {
		dl.cancel.Store(true) // 进度对话框随取消标记关闭
		messageBox("gh 下载失败: "+err.Error(), caption, mbIconError)
		return "", err
	}
	syncPluginsForGh(p.dir, p.ver) // gh 版本可能跳变,已装插件随之同步(best-effort)
	messageBox("gh "+p.ver+" 下载完成,继续启动。", caption, mbIconInfo)
	return p.dst, nil
}
