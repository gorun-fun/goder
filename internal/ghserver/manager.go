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
}

// Manager 多用户 gh server 进程注册表。
type Manager struct {
	mu     sync.Mutex
	cfg    ManagerConfig
	procs  map[string]*Proc
	ports  map[int]string // 端口 → uid
	nextPt int
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
	return &Manager{
		cfg:    cfg,
		procs:  map[string]*Proc{},
		ports:  map[int]string{},
		nextPt: cfg.PortMin,
	}
}

// uidSan 把任意 uid 映射为安全的目录名(防路径穿越/怪字符)。
var uidSan = regexp.MustCompile(`[^a-zA-Z0-9_.-]`)

// UserDir 某用户的数据目录(<DataRoot>/users/<san>/server-data)。
func (m *Manager) UserDir(uid string) string {
	san := uidSan.ReplaceAllString(uid, "_")
	return filepath.Join(m.cfg.DataRoot, "users", san, "server-data")
}

// userGrfHome 某用户的独立 GRF_HOME(<DataRoot>/users/<san>/grf-home)。
func (m *Manager) userGrfHome(uid string) string {
	san := uidSan.ReplaceAllString(uid, "_")
	return filepath.Join(m.cfg.DataRoot, "users", san, "grf-home")
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

// Get 取(必要时懒启动)某用户的进程。ErrTooManyUsers 触发方提示扩容。
func (m *Manager) Get(uid string) (*Proc, error) {
	m.mu.Lock()
	p := m.procs[uid]
	if p != nil {
		m.mu.Unlock()
		p.Touch()
		if p.Status().Running {
			return p, nil
		}
		// 崩溃/被杀:原地重启(复用已分配端口与目录)。
		st := p.Start()
		if st.Running {
			return p, nil
		}
		return p, fmt.Errorf("gh server 启动失败: %s", st.LastError)
	}
	if m.cfg.MaxUsers > 0 && len(m.procs) >= m.cfg.MaxUsers {
		m.mu.Unlock()
		return nil, fmt.Errorf("托管用户进程已达上限(%d)", m.cfg.MaxUsers)
	}
	port, err := m.allocPort()
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	grfHome, err := m.prepareUserHome(uid)
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
	})
	m.procs[uid] = p
	m.ports[port] = uid
	m.mu.Unlock()

	if err := os.MkdirAll(p.Config().DataDir, 0o755); err != nil {
		return p, err
	}
	if st := p.Start(); !st.Running {
		return p, fmt.Errorf("gh server 启动失败: %s", st.LastError)
	}
	return p, nil
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
	}
}

// StopAll 停止全部用户进程(服务退出时调用)。
func (m *Manager) StopAll() {
	m.mu.Lock()
	procs := make([]*Proc, 0, len(m.procs))
	for _, p := range m.procs {
		procs = append(procs, p)
	}
	m.procs = map[string]*Proc{}
	m.ports = map[int]string{}
	m.mu.Unlock()
	for _, p := range procs {
		p.Stop()
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
	return 0, fmt.Errorf("端口池耗尽(%d-%d)", m.cfg.PortMin, m.cfg.PortMax)
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
