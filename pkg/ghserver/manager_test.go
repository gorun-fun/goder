// manager_test.go — Manager 注册表白盒测试:uid 清洗、容量上限、冷却
// 抑制、Stop 摘除与端口释放、死进程空闲回收、端口池耗尽。全部用未
// 启动的 Proc 构造注册表状态,不依赖真实 gh 二进制。
package ghserver

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestUserDirSanitizesUID(t *testing.T) {
	m := NewManager(ManagerConfig{DataRoot: "/data"})
	got := m.UserDir("../etc/passwd")
	// 路径分隔符被清洗为单段目录名 —— 不再存在 "/../" 穿越
	if strings.Contains(got, string([]byte{'/', '.', '.', '/'})) {
		t.Fatalf("uid 路径穿越未被清洗: %s", got)
	}
	if !strings.HasSuffix(got, "server-data") {
		t.Fatalf("目录结构不符: %s", got)
	}
}

func TestManagerMaxUsers(t *testing.T) {
	m := NewManager(ManagerConfig{DataRoot: t.TempDir(), GhBin: "/nonexistent-gh", MaxUsers: 1})
	m.procs["u1"] = NewProc(ProcConfig{Addr: "127.0.0.1:17401"})
	if _, err := m.Get("u2"); !errors.Is(err, ErrTooManyUsers) {
		t.Fatalf("超上限应返回 ErrTooManyUsers,得到 %v", err)
	}
	// 已注册用户不受上限影响(不会 exec,走未运行分支)
	if _, err := m.Get("u1"); err == nil {
		t.Fatal("未运行进程的 Get 不应成功")
	}
}

func TestManagerCoolingSuppressesRestart(t *testing.T) {
	m := NewManager(ManagerConfig{DataRoot: t.TempDir(), GhBin: "/nonexistent-gh", RestartCooldown: time.Minute})
	m.procs["u1"] = NewProc(ProcConfig{Addr: "127.0.0.1:17401"})
	m.markFail("u1")
	if _, err := m.Get("u1"); !errors.Is(err, ErrStartCooling) {
		t.Fatalf("冷却窗口内应返回 ErrStartCooling,得到 %v", err)
	}
}

func TestManagerStopRemovesProcAndPort(t *testing.T) {
	m := NewManager(ManagerConfig{DataRoot: t.TempDir(), GhBin: "/nonexistent-gh"})
	m.procs["u1"] = NewProc(ProcConfig{Addr: "127.0.0.1:17401"})
	m.ports[17401] = "u1"
	m.Stop("u1")
	if _, ok := m.procs["u1"]; ok {
		t.Fatal("Stop 后进程仍在注册表")
	}
	if _, ok := m.ports[17401]; ok {
		t.Fatal("Stop 后端口仍被占用")
	}
	if m.UserAddr("u1") != "" {
		t.Fatal("Stop 后地址仍暴露")
	}
	if len(m.Statuses()) != 0 {
		t.Fatal("Stop 后 Statuses 应为空")
	}
	// 未注册 uid 的 Stop 幂等
	m.Stop("nobody")
}

func TestManagerReapIdle(t *testing.T) {
	m := NewManager(ManagerConfig{DataRoot: t.TempDir(), GhBin: "/nonexistent-gh", IdleTTL: time.Nanosecond})
	dead := NewProc(ProcConfig{Addr: "127.0.0.1:17401"})
	dead.lastUse = time.Now().Add(-time.Hour)
	m.procs["dead"] = dead
	m.ports[17401] = "dead"

	// "活着"的空闲进程:running 标记置位且 pid/adoptedPid 均为 0
	// (statusLocked 视为存活,不会触发进程探测)
	live := NewProc(ProcConfig{Addr: "127.0.0.1:17402"})
	live.lastUse = time.Now().Add(-time.Hour)
	live.mu.Lock()
	live.running = true
	live.mu.Unlock()
	m.procs["idle-alive"] = live
	m.ports[17402] = "idle-alive"

	reaped := m.ReapIdle()
	if _, ok := m.procs["dead"]; ok {
		t.Fatal("已死空闲进程应被直接摘除")
	}
	found := false
	for _, uid := range reaped {
		if uid == "dead" {
			t.Fatal("直接摘除的死进程不应出现在返回列表")
		}
		if uid == "idle-alive" {
			found = true
		}
	}
	if !found {
		t.Fatalf("活着但空闲的进程应被回收,返回 %v", reaped)
	}
	if _, ok := m.procs["idle-alive"]; ok {
		t.Fatal("空闲进程未被摘除")
	}
}

func TestManagerPortExhaustion(t *testing.T) {
	m := NewManager(ManagerConfig{
		DataRoot: t.TempDir(), GhBin: "/nonexistent-gh",
		PortMin: 17401, PortMax: 17401,
	})
	m.ports[17401] = "u1"
	if _, err := m.allocPort(); !errors.Is(err, ErrPortExhausted) {
		t.Fatalf("池耗尽应返回 ErrPortExhausted,得到 %v", err)
	}
}

func TestManagerGetAllocatesDistinctPorts(t *testing.T) {
	m := NewManager(ManagerConfig{
		DataRoot: t.TempDir(), GhBin: "/definitely-not-gh",
		PortMin: 18411, PortMax: 18419, ReadyTimeout: 100 * time.Millisecond,
	})
	// GhBin 不存在:Start 失败 → StartError(503 语义),但注册表与端口
	// 已分配,可验证每用户端口互不冲突。
	_, err1 := m.Get("u1")
	_, err2 := m.Get("u2")
	var se *StartError
	if err1 == nil || !errors.As(err1, &se) {
		t.Fatalf("坏二进制应产生 StartError,得到 %v", err1)
	}
	if err2 == nil {
		t.Skipf("u2 意外成功(环境异常)")
	}
	sts := m.Statuses()
	if len(sts) < 2 {
		t.Fatalf("两用户应各有注册项,得到 %d", len(sts))
	}
	addrs := map[string]bool{}
	for _, st := range sts {
		if addrs[st.Addr] {
			t.Fatalf("端口冲突: %s", st.Addr)
		}
		addrs[st.Addr] = true
	}
}
