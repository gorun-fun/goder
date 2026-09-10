// servermanager.go — ServerManager 服务:托管 `gh server` 子进程。
// 启动(或收养上次遗留实例)、健康探测、令牌读取与停止;app 退出时回收。
package main

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

// ServerStatusDTO 与前端 host/bridge.ts 的 ServerStatusDTO 对齐。
type ServerStatusDTO struct {
	Running   bool   `json:"running"`
	Addr      string `json:"addr"`
	DataDir   string `json:"dataDir"`
	Token     string `json:"token"`
	PID       int    `json:"pid"`
	LastError string `json:"lastError"`
}

// ServerManager wails 服务。全局单例:main 启动、服务注册与 /grf-api/token
// 端点共享同一份托管状态。
type ServerManager struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	running bool
	pid     int
	token   string
	addr    string
	dataDir string
	lastErr string
	logFile *os.File
}

// serverManager 全局唯一实例。
var serverManager = &ServerManager{}

// GetServerManager 取全局 ServerManager。
func GetServerManager() *ServerManager { return serverManager }

// ServiceShutdown wails 退出钩子:停掉托管进程。
func (s *ServerManager) ServiceShutdown() {
	s.Stop()
}

func (s *ServerManager) dirs() (addr, dataDir string, err error) {
	cfg, err := (&AppConfig{}).Load()
	if err != nil {
		return "", "", err
	}
	addr = cfg.ServerAddr
	if addr == "" {
		addr = "127.0.0.1:7400"
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", "", err
	}
	dataDir = filepath.Join(base, "grf-harness-ui", "server-data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", "", err
	}
	return addr, dataDir, nil
}

// Status 当前托管状态。
func (s *ServerManager) Status() ServerStatusDTO {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

// statusLocked 调用方已持锁的状态快照(s.mu 非重入,Start/Stop 等持锁
// 路径必须用它,否则自锁死)。
func (s *ServerManager) statusLocked() ServerStatusDTO {
	addr, dataDir, _ := s.dirs()
	st := ServerStatusDTO{Addr: addr, DataDir: dataDir, LastError: s.lastErr}
	if s.running {
		st.Running = true
		st.PID = s.pid
		st.Token = s.token
	} else {
		// 进程死了但标记还在(崩溃/被杀):校正状态。
		if s.pid != 0 && !alive(s.pid) {
			s.cleanup()
		}
	}
	return st
}

// Start 启动 gh server:先探测 addr 是否已有健康实例(含上次遗留)可收养。
func (s *ServerManager) Start() ServerStatusDTO {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running && alive(s.pid) {
		return s.statusLocked()
	}
	s.cleanup()

	addr, dataDir, err := s.dirs()
	if err != nil {
		s.lastErr = err.Error()
		return s.statusLocked()
	}

	cfg, _ := (&AppConfig{}).Load()
	bin := cfg.GhBinary
	if bin == "" {
		bin = "gh"
	}
	if _, err := exec.LookPath(bin); err != nil {
		s.lastErr = fmt.Sprintf("找不到 gh 二进制 %q(请安装 grf-harness 或在偏好设置里配置路径)", bin)
		return s.statusLocked()
	}

	logPath := filepath.Join(dataDir, "server.log")
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		s.lastErr = err.Error()
		return s.statusLocked()
	}

	cmd := exec.Command(bin, "server", "-addr", addr, "-data", dataDir)
	cmd.Stdout = lf
	cmd.Stderr = lf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // 独立进程组,可整组回收
	if err := cmd.Start(); err != nil {
		lf.Close()
		s.lastErr = err.Error()
		return s.statusLocked()
	}

	s.cmd = cmd
	s.pid = cmd.Process.Pid
	s.logFile = lf
	s.addr = addr
	s.dataDir = dataDir
	s.lastErr = ""

	// 等待健康 + 令牌落盘(gh server 启动即写 <data>/token)。
	if err := s.waitReady(addr, dataDir, 8*time.Second); err != nil {
		s.lastErr = err.Error()
		s.killGroup()
		s.cleanup()
		return s.statusLocked()
	}
	s.running = true
	// 回收子进程,避免僵尸。
	go func() { _ = cmd.Wait() }()
	return s.statusLocked()
}

// Stop 停止托管实例。
func (s *ServerManager) Stop() ServerStatusDTO {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.killGroup()
	s.cleanup()
	return s.statusLocked()
}

func (s *ServerManager) killGroup() {
	if s.pid == 0 {
		return
	}
	if alive(s.pid) {
		_ = syscall.Kill(-s.pid, syscall.SIGTERM)
		time.Sleep(300 * time.Millisecond)
		if alive(s.pid) {
			_ = syscall.Kill(-s.pid, syscall.SIGKILL)
		}
	}
}

func (s *ServerManager) cleanup() {
	if s.logFile != nil {
		s.logFile.Close()
		s.logFile = nil
	}
	s.cmd = nil
	s.running = false
	s.pid = 0
	s.token = ""
}

func (s *ServerManager) waitReady(addr, dataDir string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	tokenPath := filepath.Join(dataDir, "token")
	healthURL := fmt.Sprintf("http://%s/v1/health", addr)
	client := &http.Client{Timeout: 900 * time.Millisecond}
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(tokenPath); err == nil {
			s.token = strings.TrimSpace(string(b))
		}
		if s.token != "" {
			req, _ := http.NewRequest(http.MethodGet, healthURL, nil)
			req.Header.Set("Authorization", "Bearer "+s.token)
			if resp, err := client.Do(req); err == nil {
				resp.Body.Close()
				if resp.StatusCode == 200 {
					return nil
				}
			}
		}
		if s.cmd != nil && s.cmd.Process != nil && !alive(s.cmd.Process.Pid) {
			return fmt.Errorf("gh server 进程已退出(详见 %s)", filepath.Join(dataDir, "server.log"))
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("等待 gh server 就绪超时(详见 %s)", filepath.Join(dataDir, "server.log"))
}

func alive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}
