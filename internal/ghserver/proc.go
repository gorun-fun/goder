// Package ghserver — gh server 子进程管理。
// Proc 封装单个 `gh server` 的生命周期(启动/收养/就绪等待/令牌读取/停止);
// Manager 在其上提供多用户注册表:一个 uid 一个独立进程(独立端口与数据
// 目录),懒启动、空闲回收、数量上限。桌面形态与多用户 web 网关共用本包。
package ghserver

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Status 进程状态快照(JSON 字段与前端 host/bridge.ts 的 ServerStatusDTO 对齐)。
type Status struct {
	Running   bool   `json:"running"`
	Addr      string `json:"addr"`
	DataDir   string `json:"dataDir"`
	Token     string `json:"token"`
	PID       int    `json:"pid"`
	LastError string `json:"lastError"`
	LogPath   string `json:"logPath"`
}

// ProcConfig 一次进程生命周期的启动参数。
type ProcConfig struct {
	GhBin        string        // gh 可执行文件(名字或绝对路径)
	Addr         string        // 形如 127.0.0.1:7400
	DataDir      string        // gh server -data 目录
	ReadyTimeout time.Duration // 等待健康+令牌的上限;0 = 默认 8s
	// GrfHome 非空时给 gh 进程注入 GRF_HOME(配置/技能/插件按用户隔离;
	// 桌面形态留空沿用 ~/.grf,与桌面端 UI 同一份配置)。
	GrfHome string
}

// Proc 单个 gh server 的句柄。Stop 后不再复用,需要时新建。
type Proc struct {
	mu         sync.Mutex
	cfg        ProcConfig
	cmd        *exec.Cmd
	running    bool
	pid        int
	adoptedPid int // 收养实例的监听进程 pid(Stop 时一并回收,见 killGroupLocked)
	token      string
	lastErr    string
	logFile    *os.File
	logPath    string
	lastUse    time.Time
	// 父进程退出看门狗:read 阻塞在管道上,宿主退出(任意方式,含强杀/
	// 崩溃)管道 EOF → 按 pid 回收 gh,保证不留孤儿。
	watch  *exec.Cmd
	watchW *os.File
}

// NewProc 按配置创建进程句柄(未启动)。
func NewProc(cfg ProcConfig) *Proc {
	if cfg.ReadyTimeout <= 0 {
		cfg.ReadyTimeout = 8 * time.Second
	}
	return &Proc{cfg: cfg, lastUse: time.Now()}
}

// Config 返回启动参数(桌面诊断展示用)。
func (p *Proc) Config() ProcConfig { return p.cfg }

// Start 启动(或收养 addr 上已有的健康实例)。收养场景 PID 为 0,
// Stop 仅清理本地状态。
func (p *Proc) Start() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running && (p.pid == 0 || alive(p.pid)) {
		p.lastUse = time.Now()
		return p.statusLocked()
	}
	p.cleanupLocked()

	// 先探测:上次遗留的健康实例直接收养(读其落盘 token)。
	if tok, apid, ok := probeAdopt(p.cfg); ok {
		p.token = tok
		p.running = true
		p.pid = 0
		p.adoptedPid = apid
		p.lastErr = ""
		p.lastUse = time.Now()
		if apid != 0 {
			// 收养实例不在本进程组:只按 pid 回收(它的进程组属于别人)
			p.startWatchdog(apid, false)
		}
		return p.statusLocked()
	}

	logPath := filepath.Join(p.cfg.DataDir, "server.log")
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		p.lastErr = err.Error()
		return p.statusLocked()
	}

	cmd := exec.Command(p.cfg.GhBin, "server", "-addr", p.cfg.Addr, "-data", p.cfg.DataDir)
	cmd.Stdout = lf
	cmd.Stderr = lf
	cmd.SysProcAttr = childProcAttr() // 平台差异见 proc_unix.go / proc_windows.go
	if p.cfg.GrfHome != "" {
		// 按用户隔离 gh 配置(settings.json/skills/plugins 解析根);
		// 只追加覆盖,继承网关进程的其余环境。
		cmd.Env = append(os.Environ(), "GRF_HOME="+p.cfg.GrfHome)
	}
	if err := cmd.Start(); err != nil {
		lf.Close()
		p.lastErr = err.Error()
		return p.statusLocked()
	}

	p.cmd = cmd
	p.pid = cmd.Process.Pid
	p.logFile = lf
	p.lastErr = ""

	// 等待健康 + 令牌落盘(gh server 启动即写 <data>/token)。
	if err := p.waitReadyLocked(); err != nil {
		p.lastErr = err.Error()
		p.killGroupLocked()
		p.cleanupLocked()
		return p.statusLocked()
	}
	p.running = true
	p.lastUse = time.Now()
	// 亲生子进程按进程组回收(gh 可能再派生子进程)
	p.startWatchdog(p.pid, true)
	// 回收子进程,避免僵尸。
	go func() { _ = cmd.Wait() }()
	return p.statusLocked()
}

// startWatchdog 给 gh 挂父进程退出看门狗:宿主进程退出(正常退出/崩溃/
// 被强杀)时按 pid/进程组回收 gh,保证不留孤儿。平台实现见
// proc_unix.go(sh 管道 EOF)与 proc_windows.go(暂缺,依赖收养兜底)。
// 优雅 Stop 时由 cleanupLocked 主动关闭管道并清掉看门狗。

// Stop 终止托管实例(收养实例仅清理本地状态)。
func (p *Proc) Stop() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.killGroupLocked()
	p.cleanupLocked()
	return p.statusLocked()
}

// Status 当前状态快照。
func (p *Proc) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.statusLocked()
}

// Token 进程令牌(未就绪为空)。
func (p *Proc) Token() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.token
}

// Touch 标记最近使用(空闲回收计时用)。
func (p *Proc) Touch() {
	p.mu.Lock()
	p.lastUse = time.Now()
	p.mu.Unlock()
}

// IdleFor 距最近使用经过了多久。
func (p *Proc) IdleFor() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	return time.Since(p.lastUse)
}

func (p *Proc) statusLocked() Status {
	st := Status{Addr: p.cfg.Addr, DataDir: p.cfg.DataDir, LastError: p.lastErr, LogPath: p.logPath}
	if p.running {
		// 进程死了但标记还在(崩溃/被杀):校正状态。
		if p.pid != 0 && !alive(p.pid) {
			p.cleanupLocked()
			return st
		}
		// 收养实例死亡同样校正(pid 探测失败时 adoptedPid 可能为 0,跳过)
		if p.pid == 0 && p.adoptedPid != 0 && !alive(p.adoptedPid) {
			p.cleanupLocked()
			return st
		}
		st.Running = true
		if p.pid != 0 {
			st.PID = p.pid
		} else if p.adoptedPid != 0 {
			st.PID = p.adoptedPid
		}
		st.Token = p.token
	}
	return st
}

func (p *Proc) waitReadyLocked() error {
	deadline := time.Now().Add(p.cfg.ReadyTimeout)
	tokenPath := filepath.Join(p.cfg.DataDir, "token")
	healthURL := fmt.Sprintf("http://%s/v1/health", p.cfg.Addr)
	client := &http.Client{Timeout: 900 * time.Millisecond}
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(tokenPath); err == nil {
			p.token = strings.TrimSpace(string(b))
		}
		if p.token != "" {
			req, _ := http.NewRequest(http.MethodGet, healthURL, nil)
			req.Header.Set("Authorization", "Bearer "+p.token)
			if resp, err := client.Do(req); err == nil {
				resp.Body.Close()
				if resp.StatusCode == 200 {
					return nil
				}
			}
		}
		if p.cmd != nil && p.cmd.Process != nil && !alive(p.cmd.Process.Pid) {
			return fmt.Errorf("gh server 进程已退出(详见 %s)", p.logPath)
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("等待 gh server 就绪超时(详见 %s)", p.logPath)
}

func (p *Proc) killGroupLocked() {
	// 收养实例不属于本进程组,单独按 pid 回收(桌面退出时 gh 随之关闭,
	// 不留孤儿;杀失败静默——进程可能已退出)。先记录再清理,避免与
	// cleanupLocked 交互遗漏。
	adopted := p.adoptedPid
	p.adoptedPid = 0
	if adopted != 0 && alive(adopted) {
		killProcTree(adopted, false)
	}
	if p.pid == 0 {
		return
	}
	if alive(p.pid) {
		killProcTree(p.pid, true)
	}
}

// waitExit 轮询等待进程退出;仍在存活返回 true(调用方应 SIGKILL)。
func waitExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !alive(pid) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
	return alive(pid)
}

func (p *Proc) cleanupLocked() {
	if p.logFile != nil {
		p.logFile.Close()
		p.logFile = nil
	}
	// 优雅回收后看门狗无用武之地:关管道 + 结束 sh,避免常驻。
	if p.watchW != nil {
		p.watchW.Close()
		p.watchW = nil
	}
	if p.watch != nil && p.watch.Process != nil {
		watch := p.watch
		_ = watch.Process.Kill()
		go func() { _ = watch.Wait() }()
		p.watch = nil
	}
	p.cmd = nil
	p.running = false
	p.pid = 0
	p.adoptedPid = 0
	p.token = ""
}

// probeAdopt 探测 addr 上是否已有健康实例且令牌已落盘(上次遗留可收养)。
// 返回(令牌, 监听进程 pid, 是否可收养);pid 探测失败为 0(不影响收养,
// 仅退出回收时按 pid 杀不到,由 start.sh stop 兜底)。
func probeAdopt(cfg ProcConfig) (string, int, bool) {
	tokenPath := filepath.Join(cfg.DataDir, "token")
	b, err := os.ReadFile(tokenPath)
	if err != nil {
		return "", 0, false
	}
	tok := strings.TrimSpace(string(b))
	if tok == "" {
		return "", 0, false
	}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://%s/v1/health", cfg.Addr), nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	client := &http.Client{Timeout: 900 * time.Millisecond}
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, false
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", 0, false
	}
	return tok, listenerPID(cfg.Addr), true
}

// listenerPID 找 addr 上监听进程的 pid(lsof;非 POSIX 平台或未安装时返回 0)。
func listenerPID(addr string) int {
	port := addr
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		port = addr[i+1:]
	}
	out, err := exec.Command("lsof", "-tiTCP:"+port, "-sTCP:LISTEN").Output()
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return 0
	}
	n, err := strconv.Atoi(fields[0])
	if err != nil {
		return 0
	}
	return n
}

// alive 的平台实现见 proc_unix.go / proc_windows.go。
