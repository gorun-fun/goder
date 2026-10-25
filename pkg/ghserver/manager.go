// manager.go — 多用户 gh server 注册表:uid → Proc。每用户独立端口与数据
// 目录(users/<uid>/server-data),首次使用懒启动;支持数量上限与空闲回收。
package ghserver

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

// ManagerConfig Manager 行为参数。
type ManagerConfig struct {
	GhBin        string        // gh 可执行文件(名字或绝对路径)
	DataRoot     string        // 用户数据根目录;每用户 <root>/users/<uid>/server-data
	AddrBase     string        // 监听地址主机部分,默认 127.0.0.1
	PortMin      int           // 用户进程端口池下限(默认 17400)
	PortMax      int           // 上限(默认 18400)
	MaxUsers     int           // 同时托管的用户进程上限;0 = 不限
	IdleTTL      time.Duration // 空闲回收阈值;0 = 不回收
	ReadyTimeout time.Duration // 传给 Proc;0 = 默认
	// PerUserHome true = 每用户独立 GRF_HOME(<root>/users/<uid>/grf-home):
	// settings.json/技能/插件全部按用户隔离,网页设置页(/v1/agent/*)落到
	// 用户自己的配置。false = 沿用宿主 ~/.grf(桌面/共享部署)。
	PerUserHome bool
	// SettingsSeed PerUserHome 时的播种来源(宿主 settings.json 绝对路径;
	// 用户文件不存在则复制一份作初始配置,之后完全独立)。空 = 不播种。
	SettingsSeed string
	// RestartCooldown 崩溃重启的冷却窗口:进程退出后窗口内的 Get 请求
	// 不再触发 Start(返回 ErrStartCooling),防止坏二进制 + 大流量下
	// 的反复 spawn 风暴;0 = 默认 10s。
	RestartCooldown time.Duration
	// ExtraEnv 追加注入每个 gh 子进程的额外环境(KEY=VALUE)。宿主网关
	// 用它透传 gh 侧能力开关,典型如回合事件外发:
	// GRF_TURN_WEBHOOK_URL / GRF_TURN_WEBHOOK_SECRET(openos 等宿主的
	// 无头任务由轮询转事件驱动)。goder-serve 经 GODER_GH_ENV_<KEY>
	// 前缀收集(见 cmd/goder-serve)。
	ExtraEnv []string
	// Hooks 进程生命周期回调(网关的 webhook 转发、运维日志等挂这里;
	// 回调在独立 goroutine 执行,勿阻塞)。
	Hooks ManagerHooks
}

// ManagerHooks 进程生命周期回调。
type ManagerHooks struct {
	// OnStart 进程启动成功(收养成功也计)。
	OnStart func(uid, addr string)
	// OnStop 进程停止(主动回收/空闲回收/退出)。
	OnStop func(uid, reason string)
	// OnCrash 进程异常退出后启动失败(重启被冷却抑制)。
	OnCrash func(uid string)
}

// Manager 多用户 gh server 进程注册表。
type Manager struct {
	mu     sync.Mutex
	cfg    ManagerConfig
	procs  map[string]*Proc
	ports  map[int]string // 端口 → uid
	nextPt int
	// lastFailAt uid → 最近一次启动失败时刻(冷却窗口判定)。
	lastFailAt map[string]time.Time
}

// NewManager 创建注册表(不启动任何进程)。
func NewManager(cfg ManagerConfig) *Manager {
	if cfg.AddrBase == "" {
		cfg.AddrBase = "127.0.0.1"
	}
	if cfg.PortMin == 0 {
		cfg.PortMin = 17400
	}
	if cfg.PortMax == 0 {
		cfg.PortMax = 18400
	}
	if cfg.PortMax < cfg.PortMin {
		cfg.PortMin, cfg.PortMax = cfg.PortMax, cfg.PortMin
	}
	if cfg.RestartCooldown <= 0 {
		cfg.RestartCooldown = 10 * time.Second
	}
	return &Manager{
		cfg:        cfg,
		procs:      map[string]*Proc{},
		ports:      map[int]string{},
		lastFailAt: map[string]time.Time{},
		nextPt:     cfg.PortMin,
	}
}

// uidSan 把任意 uid 映射为安全的目录名(防路径穿越/怪字符)。
var uidSan = regexp.MustCompile(`[^a-zA-Z0-9_.-]`)

// sanitizeUID uid → 目录名:uidSan 折叠非法字符后,"." 与 ".." 是字符集
// 放行的点段(filepath.Join 会把它们穿越出 users/,uid=".." 时 UserRoot
// 恰为 DataRoot 本身、DeleteUser 即 RemoveAll(DataRoot)),一并折叠为 _。
func sanitizeUID(uid string) string {
	san := uidSan.ReplaceAllString(uid, "_")
	if san == "." || san == ".." {
		san = "_"
	}
	return san
}

// UserDir 某用户的数据目录(<DataRoot>/users/<san>/server-data)。
func (m *Manager) UserDir(uid string) string {
	return filepath.Join(m.cfg.DataRoot, "users", sanitizeUID(uid), "server-data")
}

// userGrfHome 某用户的独立 GRF_HOME(<DataRoot>/users/<san>/grf-home)。
func (m *Manager) userGrfHome(uid string) string {
	return filepath.Join(m.cfg.DataRoot, "users", sanitizeUID(uid), "grf-home")
}

// prepareUserHome PerUserHome 时建用户 GRF_HOME 并按需播种:用户
// settings.json 不存在且配置了种子则复制一份(一次性快照,之后互不影响)。
func (m *Manager) prepareUserHome(uid string) (string, error) {
	if !m.cfg.PerUserHome {
		return "", nil
	}
	home := m.userGrfHome(uid)
	if err := os.MkdirAll(home, 0o755); err != nil {
		return "", err
	}
	dst := filepath.Join(home, "settings.json")
	if m.cfg.SettingsSeed != "" {
		if _, err := os.Stat(dst); os.IsNotExist(err) {
			if raw, err := os.ReadFile(m.cfg.SettingsSeed); err == nil {
				_ = os.WriteFile(dst, raw, 0o600)
			}
		}
	}
	return home, nil
}

// UserAddr 某用户的监听地址(仅对已存在的进程有意义;未启动返回空)。
func (m *Manager) UserAddr(uid string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p := m.procs[uid]; p != nil {
		return p.Config().Addr
	}
	return ""
}

// Get 取(必要时懒启动)某用户的进程。错误类型化:ErrTooManyUsers(429,
// 触发方提示扩容)/ ErrStartCooling(503,崩溃重启冷却中)/ *StartError
// (503,启动失败明细,含「启动期间被并发 Stop 摘除」的回滚)/
// ErrPortExhausted(503)。
func (m *Manager) Get(uid string) (*Proc, error) {
	for {
		m.mu.Lock()
		p := m.procs[uid]
		cooling := false
		if p != nil {
			cooling = m.coolingLocked(uid)
		} else if m.cfg.MaxUsers > 0 && len(m.procs) >= m.cfg.MaxUsers {
			// 容量预检放锁内:超限直接拒绝,连 PerUserHome 目录也不建
			// (权威判定仍在下方注册段,预检与注册之间的空档由注册段兜底)。
			m.mu.Unlock()
			return nil, &tooManyUsersError{max: m.cfg.MaxUsers}
		}
		m.mu.Unlock()
		if p != nil {
			return m.ensureStarted(uid, p, cooling)
		}

		// 未注册:PerUserHome 的文件 IO(建目录 + 种子复制)在锁外完成,
		// 持锁路径不碰磁盘;prepareUserHome 幂等(MkdirAll + 目标不存在才
		// 播种),IO 期间并发 Get 同 uid 重复执行结果一致。
		grfHome, err := m.prepareUserHome(uid)
		if err != nil {
			return nil, err
		}
		m.mu.Lock()
		if cur := m.procs[uid]; cur != nil {
			// IO 期间并发 Get 已抢先注册:丢弃本次准备,重走既有项路径。
			m.mu.Unlock()
			continue
		}
		if m.cfg.MaxUsers > 0 && len(m.procs) >= m.cfg.MaxUsers {
			m.mu.Unlock()
			return nil, &tooManyUsersError{max: m.cfg.MaxUsers}
		}
		port, err := m.allocPort()
		if err != nil {
			m.mu.Unlock()
			return nil, err
		}
		addr := fmt.Sprintf("%s:%d", m.cfg.AddrBase, port)
		p = NewProc(ProcConfig{
			GhBin:        m.cfg.GhBin,
			Addr:         addr,
			DataDir:      m.UserDir(uid),
			ReadyTimeout: m.cfg.ReadyTimeout,
			GrfHome:      grfHome,
			ExtraEnv:     m.cfg.ExtraEnv,
		})
		m.procs[uid] = p
		m.ports[port] = uid
		delete(m.lastFailAt, uid)
		m.mu.Unlock()

		if err := os.MkdirAll(p.Config().DataDir, 0o755); err != nil {
			return p, err
		}
		return m.ensureStarted(uid, p, false)
	}
}

// ensureStarted 让已注册的 p 进入运行态:已在跑直接返回;崩溃/未启动则
// (重)启动,冷却窗口内拒绝(崩溃/被杀的原地重启复用已分配端口与目录;
// 坏二进制 + 大流量会反复 spawn 打满 CPU,窗口过后自动恢复尝试)。
// Start 在锁外执行,期间并发 Stop 可能已摘除本项 —— 收尾交给 confirmStart
// 复查注册表成员资格并处理回滚。
func (m *Manager) ensureStarted(uid string, p *Proc, cooling bool) (*Proc, error) {
	p.Touch()
	if p.Status().Running {
		return p, nil
	}
	if cooling {
		return p, ErrStartCooling
	}
	st := p.Start()
	if !st.Running {
		m.markFail(uid)
		m.hookCrash(uid)
		return p, &StartError{LastError: st.LastError}
	}
	return m.confirmStart(uid, p, st)
}

// confirmStart Get/ensureStarted 在 p.Start() 成功后的收尾:复查注册表
// 成员资格 —— Start 在锁外执行,期间并发 Stop 可能已摘除本项,脱离注册
// 表的进程 Manager 不再追踪/回收(会一直跑到自然退出),必须回滚停止并
// 按 StartError(503 语义)上报,调用方稍后重试即走全新流程。
func (m *Manager) confirmStart(uid string, p *Proc, st Status) (*Proc, error) {
	if !m.stillRegistered(uid, p) {
		p.Stop()
		return p, &StartError{LastError: "启动完成前进程已被并发 Stop 摘除,已回滚"}
	}
	m.clearFail(uid)
	m.hookStart(uid, st.Addr)
	return p, nil
}

// stillRegistered uid 的注册项当前是否仍是 p(Get 启动后的成员资格复查)。
func (m *Manager) stillRegistered(uid string, p *Proc) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.procs[uid] == p
}

// coolingLocked 冷却窗口判定(需持 mu)。
func (m *Manager) coolingLocked(uid string) bool {
	t, ok := m.lastFailAt[uid]
	return ok && time.Since(t) < m.cfg.RestartCooldown
}

func (m *Manager) markFail(uid string) {
	m.mu.Lock()
	m.lastFailAt[uid] = time.Now()
	m.mu.Unlock()
}

func (m *Manager) clearFail(uid string) {
	m.mu.Lock()
	delete(m.lastFailAt, uid)
	m.mu.Unlock()
}

func (m *Manager) hookStart(uid, addr string) {
	if m.cfg.Hooks.OnStart != nil {
		go m.cfg.Hooks.OnStart(uid, addr)
	}
}

func (m *Manager) hookCrash(uid string) {
	if m.cfg.Hooks.OnCrash != nil {
		go m.cfg.Hooks.OnCrash(uid)
	}
}

func (m *Manager) hookStop(uid, reason string) {
	if m.cfg.Hooks.OnStop != nil {
		go m.cfg.Hooks.OnStop(uid, reason)
	}
}

// Stop 停止并移除某用户的进程。
func (m *Manager) Stop(uid string) {
	m.mu.Lock()
	p := m.procs[uid]
	delete(m.procs, uid)
	for port, u := range m.ports {
		if u == uid {
			delete(m.ports, port)
		}
	}
	m.mu.Unlock()
	if p != nil {
		p.Stop()
		m.hookStop(uid, "stop")
	}
}

// StopAll 停止全部用户进程(服务退出时调用)。
func (m *Manager) StopAll() {
	m.mu.Lock()
	procsByUID := make(map[string]*Proc, len(m.procs))
	for uid, p := range m.procs {
		procsByUID[uid] = p
	}
	m.procs = map[string]*Proc{}
	m.ports = map[int]string{}
	m.mu.Unlock()
	for uid, p := range procsByUID {
		p.Stop()
		m.hookStop(uid, "shutdown")
	}
}

// ReapIdle 回收空闲超时的进程,返回被回收的 uid 列表。
// 由服务端起周期协程调用;IdleTTL 为 0 时直接返回。
func (m *Manager) ReapIdle() []string {
	if m.cfg.IdleTTL <= 0 {
		return nil
	}
	m.mu.Lock()
	var idle []string
	for uid, p := range m.procs {
		if p.IdleFor() > m.cfg.IdleTTL && !p.Status().Running {
			// 已死进程直接摘除
			delete(m.procs, uid)
			delete(m.lastFailAt, uid)
			for port, u := range m.ports {
				if u == uid {
					delete(m.ports, port)
				}
			}
			continue
		}
		if p.IdleFor() > m.cfg.IdleTTL {
			idle = append(idle, uid)
		}
	}
	m.mu.Unlock()
	for _, uid := range idle {
		m.Stop(uid)
	}
	return idle
}

// Statuses 全部用户进程状态(uid 有序输出)。
func (m *Manager) Statuses() map[string]Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]Status, len(m.procs))
	for uid, p := range m.procs {
		out[uid] = p.Status()
	}
	return out
}

// allocPort 从端口池取一个空闲端口(尝试绑定探测;池耗尽报错)。
func (m *Manager) allocPort() (int, error) {
	for range m.cfg.PortMax - m.cfg.PortMin + 1 {
		port := m.nextPt
		m.nextPt++
		if m.nextPt > m.cfg.PortMax {
			m.nextPt = m.cfg.PortMin
		}
		if _, used := m.ports[port]; used {
			continue
		}
		ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", m.cfg.AddrBase, port))
		if err != nil {
			continue // 被外部进程占用
		}
		_ = ln.Close()
		return port, nil
	}
	return 0, &portExhaustedError{min: m.cfg.PortMin, max: m.cfg.PortMax}
}

// SortedUIDs Statuses 的辅助:uid 排序列表。
func SortedUIDs(sts map[string]Status) []string {
	out := make([]string, 0, len(sts))
	for uid := range sts {
		out = append(out, uid)
	}
	sort.Strings(out)
	return out
}

// IdleTTL 空闲回收阈值(0 = 不回收)。
func (m *Manager) IdleTTL() time.Duration { return m.cfg.IdleTTL }

// GhBin 配置的 gh 可执行文件(就绪探针用)。
func (m *Manager) GhBin() string { return m.cfg.GhBin }

// SetHooks 运行期挂接/替换生命周期回调(网关创建后配置 webhook 时用;
// nil 字段保留既有值)。
func (m *Manager) SetHooks(h ManagerHooks) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h.OnStart != nil {
		m.cfg.Hooks.OnStart = h.OnStart
	}
	if h.OnStop != nil {
		m.cfg.Hooks.OnStop = h.OnStop
	}
	if h.OnCrash != nil {
		m.cfg.Hooks.OnCrash = h.OnCrash
	}
}
