// manager_test.go — Manager 注册表白盒测试:uid 清洗、容量上限、冷却
// 抑制、Stop 摘除与端口释放、死进程空闲回收、端口池耗尽、Get↔Stop
// 并发竞态回滚。全部用未启动的 Proc 构造注册表状态,不依赖真实 gh 二进制。
package ghserver

import (
	"errors"
	"strings"
	"sync"
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
	// "."/".." 是字符集放行的点段,Join 会穿越出 users/(uid=".." 时
	// UserRoot 恰为 DataRoot 本身,DeleteUser 即 RemoveAll(DataRoot))
	for _, uid := range []string{".", ".."} {
		if root := m.UserRoot(uid); root == "/data" || root == "/data/users" {
			t.Fatalf("uid %q 未折叠点段: UserRoot=%s", uid, root)
		}
		if got := m.UserDir(uid); got == "/data/server-data" {
			t.Fatalf("uid %q 未折叠点段: UserDir=%s", uid, got)
		}
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

// TestManagerConfirmStartRollbackOnConcurrentStop — Get↔Stop 竞态回归:
// Get 在锁外执行 p.Start(),期间并发 Stop 把注册表项摘除后,启动成功也
// 不得把「Manager 不再追踪的运行中进程」交还给调用方 —— 必须回滚停止
// 并按 StartError(503 语义)上报,调用方稍后重试即走全新流程。
//
// 说明:Proc.Start 在单测环境无法真实成功(需 gh 二进制;收养路径又会让
// lsof 定位到测试进程自身、回滚 Stop 误杀测试进程),故直接驱动 Start
// 成功后的收尾 confirmStart —— Get 的回滚语义即由它承载。
func TestManagerConfirmStartRollbackOnConcurrentStop(t *testing.T) {
	// OnStart 经 hookStart 异步执行,用通道同步断言时序。
	startedCh := make(chan string, 2)
	m := NewManager(ManagerConfig{
		DataRoot: t.TempDir(), GhBin: "/nonexistent-gh",
		Hooks: ManagerHooks{OnStart: func(uid, addr string) { startedCh <- uid }},
	})
	// 构造「Start 刚成功」的 proc:running 置位、pid/adoptedPid 均为 0
	// (Stop 只清本地状态,不会误杀外部进程)。
	p := NewProc(ProcConfig{Addr: "127.0.0.1:17401", DataDir: t.TempDir()})
	p.mu.Lock()
	p.running = true
	p.mu.Unlock()
	st := p.Status()
	if !st.Running {
		t.Fatal("前置条件:构造的 proc 应处于运行态")
	}

	// 仍在注册表:正常收尾 —— 清失败标记并触发 OnStart。
	m.procs["u1"] = p
	m.markFail("u1")
	if _, err := m.confirmStart("u1", p, st); err != nil {
		t.Fatalf("未摘除时不应报错: %v", err)
	}
	select {
	case uid := <-startedCh:
		if uid != "u1" {
			t.Fatalf("OnStart 的 uid 不符: %s", uid)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OnStart 应触发一次")
	}
	if _, ok := m.lastFailAt["u1"]; ok {
		t.Fatal("成功收尾应清除失败标记")
	}

	// 并发 Stop 场景:注册表项已被摘除(仅移除映射,p 本身仍在运行 ——
	// 即 Get 的 Start 在锁外执行期间被 Stop 抢先摘除的时序)。
	delete(m.procs, "u1")
	_, err := m.confirmStart("u1", p, st)
	var se *StartError
	if !errors.As(err, &se) {
		t.Fatalf("摘除后应回滚为 StartError,得到 %v", err)
	}
	select {
	case v := <-startedCh:
		t.Fatalf("回滚不应触发 OnStart,得到 %v", v)
	case <-time.After(100 * time.Millisecond):
	}
	if p.Status().Running {
		t.Fatal("回滚后进程应已被停止(不得遗留脱离注册表的运行中进程)")
	}
}

// TestManagerGetStopConcurrentSmoke — 并发烟测:多组 Get(坏二进制,必然
// StartError)与 Stop 交错执行,不得死锁/崩溃/遗留注册项。覆盖 Get 重构后
// 的锁序(锁外 prepareUserHome 文件 IO 与注册段的并发交错);「启动成功 +
// 摘除」的回滚语义由上一个用例确定性覆盖。
func TestManagerGetStopConcurrentSmoke(t *testing.T) {
	m := NewManager(ManagerConfig{
		DataRoot: t.TempDir(), GhBin: "/nonexistent-gh",
		PortMin: 18711, PortMax: 18719, ReadyTimeout: 100 * time.Millisecond,
		PerUserHome: true, // 让锁外的 prepareUserHome 真正做文件 IO
	})
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for range 5 {
				_, _ = m.Get("u1")
			}
		}()
		go func() {
			defer wg.Done()
			for range 5 {
				m.Stop("u1")
			}
		}()
	}
	wg.Wait()
	// 启动失败(坏二进制)的 Get 会留册进入冷却 —— 这是既有设计;并发
	// 正确的判据是:同一 uid 至多一条注册项(无重复建进程/占端口)。
	sts := m.Statuses()
	if len(sts) > 1 {
		t.Fatalf("同一 uid 至多一条注册项,得到 %v", sts)
	}
	m.Stop("u1")
	if sts = m.Statuses(); len(sts) != 0 {
		t.Fatalf("显式 Stop 后注册表应为空,得到 %v", sts)
	}
}
