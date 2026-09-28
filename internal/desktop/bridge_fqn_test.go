// bridge_fqn_test.go — 桌面 wails 服务与前端 bridge.ts 的 FQN 对齐守护。
// wails Call.ByName 按「完整包路径.类型.方法」精确匹配:本包挪动/重命名
// 服务或方法时,前端 bridge.ts(SVC 常量 + `${SVC}.X.Y` 调用)不会编译报错,
// 只会在运行时静默失效。本测试反射服务方法集生成 FQN 清单,并从
// frontend/src/host/bridge.ts 提取全部被引用的 FQN,断言每条引用都存在
// ——挪包/改名后此测试先红,提醒同步 bridge.ts(AGENTS.md 的手工对齐
// 约束由此获得机械护栏)。
package desktop

import (
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// servicesForFQN 与 main.go 的 appServices() 保持同一份实例清单
// (那边挪动时这里同改;测试只反射,不触发副作用启动)。
func servicesForFQN() []any {
	return []any{
		&AppConfig{},
		GetServerManager(),
		&ModelConfig{},
		&AgentConfig{},
		&Desktop{},
		GetTerminalManager(),
		GetBrowserManager(),
		GetConsoleMCP(),
		GetUpdater(),
	}
}

// serviceFQNs 反射各服务的导出方法,生成「包路径.类型.方法」清单。
func serviceFQNs() map[string]bool {
	out := map[string]bool{}
	for _, svc := range servicesForFQN() {
		t := reflect.TypeOf(svc)
		pkg := t.Elem().PkgPath()
		typ := t.Elem().Name()
		for i := 0; i < t.NumMethod(); i++ {
			m := t.Method(i)
			if !m.IsExported() {
				continue
			}
			out[pkg+"."+typ+"."+m.Name] = true
		}
	}
	return out
}

// bridgeFQNRefs 从 bridge.ts 源码提取 `${SVC}.Service.Method` 引用
// (SVC 为本包路径的字面量拼接)。
func bridgeFQNRefs(t *testing.T) map[string]bool {
	t.Helper()
	raw, err := os.ReadFile("../../frontend/src/host/bridge.ts")
	if err != nil {
		t.Skipf("读不到 bridge.ts(%v);前端源码不在时跳过", err)
	}
	re := regexp.MustCompile(`\$\{SVC\}\.([A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)`)
	svc := "git.gorun.fun/share/goder/internal/desktop"
	out := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(string(raw), -1) {
		out[svc+"."+m[1]] = true
	}
	return out
}

func TestBridgeFQNAligned(t *testing.T) {
	have := serviceFQNs()
	refs := bridgeFQNRefs(t)
	if len(refs) == 0 {
		t.Fatal("bridge.ts 中未提取到任何 ${SVC}.X.Y 引用:提取正则可能失效")
	}
	for fqn := range refs {
		if !have[fqn] {
			t.Errorf("bridge.ts 引用的 FQN 在 Go 服务方法集中不存在: %s\n(服务/方法挪动或改名后需同步 frontend/src/host/bridge.ts 的 SVC 常量与调用)", fqn)
		}
	}
	// 反向报告(不失败):导出但前端未引用的方法,供人工确认是否有意。
	var unused []string
	for fqn := range have {
		if !refs[fqn] && !strings.HasSuffix(fqn, ".OnStartup") {
			unused = append(unused, fqn)
		}
	}
	if len(unused) > 0 {
		t.Logf("前端未引用的服务方法(%d 个,确认是否有意): %s", len(unused), strings.Join(unused, ", "))
	}
}
