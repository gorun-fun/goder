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
	"strings"
	"sync"
	"syscall"
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
}

// Proc 单个 gh server 的句柄。Stop 后不再复用,需要时新建。
type Proc struct {
	mu      sync.Mutex
	cfg     ProcConfig
	cmd     *exec.Cmd
	running bool
	pid     int
	token   string
	lastErr string
	logFile *os.File
	logPath string
	lastUse time.Time
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
	if tok, ok := probeAdopt(p.cfg); ok {
		p.token = tok
		p.running = true
		p.pid = 0
		p.lastErr = ""
		p.lastUse = time.Now()
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
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // 独立进程组,可整组回收
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
	// 回收子进程,避免僵尸。
	go func() { _ = cmd.Wait() }()
	return p.statusLocked()
}

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
		st.Running = true
		st.PID = p.pid
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
	if p.pid == 0 {
		return
	}
	if alive(p.pid) {
		_ = syscall.Kill(-p.pid, syscall.SIGTERM)
		time.Sleep(300 * time.Millisecond)
		if alive(p.pid) {
			_ = syscall.Kill(-p.pid, syscall.SIGKILL)
		}
	}
}

func (p *Proc) cleanupLocked() {
	if p.logFile != nil {
		p.logFile.Close()
		p.logFile = nil
	}
	p.cmd = nil
	p.running = false
	p.pid = 0
	p.token = ""
}

// probeAdopt 探测 addr 上是否已有健康实例且令牌已落盘(上次遗留可收养)。
func probeAdopt(cfg ProcConfig) (string, bool) {
	tokenPath := filepath.Join(cfg.DataDir, "token")
	b, err := os.ReadFile(tokenPath)
	if err != nil {
		return "", false
	}
	tok := strings.TrimSpace(string(b))
	if tok == "" {
		return "", false
	}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://%s/v1/health", cfg.Addr), nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	client := &http.Client{Timeout: 900 * time.Millisecond}
	resp, err := client.Do(req)
	if err != nil {
		return "", false
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", false
	}
	return tok, true
}

func alive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}
