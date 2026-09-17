// hideconsole_other.go — 非 Windows 平台 hideConsole 为 no-op(见
// hideconsole_windows.go)。
//go:build !windows

package desktop

import "os/exec"

func hideConsole(*exec.Cmd) {}
