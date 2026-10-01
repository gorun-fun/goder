// relaunch.go — 自更新接力启动(跨平台共用):applyGoder 拉起新版本进程时
// 附 --wait-pid=<旧进程 pid>,新进程在一切初始化(含 WebView2 环境)之前
// 先等旧进程完全退出,再继续正常启动。
//
// 为什么必须等:旧进程 Quit 后到内核回收之间的窗口里,新旧两个 goder
// 并存 —— Windows 上 wails 的 WebView2 用户数据目录按可执行文件名落
// %AppData%(新旧进程同名同目录),旧进程的 browser 进程持锁时新进程
// 创建 WebView2 环境会失败,wails 的全局错误回调直接退出进程,表现为
// 「更新完不自动打开」;macOS WKWebView 无此独占锁故无症状。同时重叠
// 还会踩 goder-console 端口烙写互踩(见 AGENTS.md 对双进程并存的警告)。
// 平台等待原语在 relaunch_windows.go / relaunch_other.go。
package main

import (
	"strconv"
	"strings"
	"time"
)

// relaunchWaitFlag 接力参数前缀(值 = 旧进程 pid)。
const relaunchWaitFlag = "--wait-pid="

// relaunchWaitTimeout 等待旧进程退出的上限:正常退出远快于此;超时放行,
// 行为退化为普通启动(不硬等一个僵死的旧进程)。
const relaunchWaitTimeout = 15 * time.Second

// relaunchSettleDelay 旧进程退出后的额外缓冲:WebView2 的 browser 进程是
// 旧 goder 的子进程,宿主退出后其自行退出与释放用户数据目录锁有短暂
// 延迟,直接抢跑仍可能撞锁。
const relaunchSettleDelay = time.Second

// waitRelaunchParent 解析接力参数,命中则阻塞等待旧进程退出。抢在 main
// 的一切初始化之前调用;参数不存在(普通启动/子命令形态)时零开销。
func waitRelaunchParent(args []string) {
	for _, a := range args[1:] {
		if !strings.HasPrefix(a, relaunchWaitFlag) {
			continue
		}
		if pid, err := strconv.Atoi(strings.TrimPrefix(a, relaunchWaitFlag)); err == nil && pid > 0 {
			waitProcessExit(pid, relaunchWaitTimeout)
			time.Sleep(relaunchSettleDelay)
		}
		return
	}
}
