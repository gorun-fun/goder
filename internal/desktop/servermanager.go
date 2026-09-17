// servermanager.go — ServerManager wails 服务:桌面态托管 gh server 子进程。
// 单用户形态:进程生命周期经 internal/ghserver.Proc 实现,这里只负责按
// AppConfig 解析启动参数与维护全局单例(main 冷启动、服务注册与
// /grf-api/token 端点共享同一份状态)。
package desktop

import (
	"log"
	"os"
	"path/filepath"
	"sync"

	"git.gorun.fun/share/goder/internal/appcfg"
	"git.gorun.fun/share/goder/internal/ghserver"
)

// ServerManager wails 服务(全局单例)。
type ServerManager struct {
	mu      sync.Mutex
	proc    *ghserver.Proc
	lastErr string
}

// serverManager 全局唯一实例。
var serverManager = &ServerManager{}

// GetServerManager 取全局 ServerManager。
func GetServerManager() *ServerManager { return serverManager }

// ServiceShutdown wails 退出钩子:停掉托管进程(gh server 随 App 关闭,
// 不留孤儿)。
func (s *ServerManager) ServiceShutdown() {
	log.Printf("[servermanager] 退出:回收托管 gh server")
	s.Stop()
}

// dirs 解析当前配置对应的监听地址与数据目录(随 appcfg 目录,含旧名迁移)。
func (s *ServerManager) dirs() (addr, dataDir string, err error) {
	cfg, err := (&AppConfig{}).Load()
	if err != nil {
		return "", "", err
	}
	addr = cfg.ServerAddr
	if addr == "" {
		addr = "127.0.0.1:7400"
	}
	// 配置目录(appcfg.DefaultDir,含旧目录名 grf-harness-ui 迁移)下的 server-data
	base, err := appcfg.DefaultDir()
	if err != nil {
		return "", "", err
	}
	dataDir = filepath.Join(base, "server-data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", "", err
	}
	return addr, dataDir, nil
}

// Status 当前托管状态。
func (s *ServerManager) Status() ghserver.Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == nil {
		addr, dataDir, _ := s.dirs()
		return ghserver.Status{Addr: addr, DataDir: dataDir, LastError: s.lastErr}
	}
	return s.proc.Status()
}

// Start 启动 gh server(已运行/可收养则复用)。
func (s *ServerManager) Start() ghserver.Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	addr, dataDir, err := s.dirs()
	if err != nil {
		s.lastErr = err.Error()
		return s.statusLocked()
	}
	cfg, _ := (&AppConfig{}).Load()
	// 解析顺序:显式配置 → App 包内捆绑副本 → 常见安装目录 → 下载管理
	// 目录(<配置目录>/bin,Windows 首启弹框自动下载落点)→ PATH;
	// Finder/Dock 启动的 App PATH 只有系统目录,不能只靠 LookPath。
	bin := ghserver.ResolveGhBin(cfg.GhBinary)
	if bin == "" {
		if p, merr := managedGhPath(); merr == nil {
			if st, serr := os.Stat(p); serr == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
				bin = p
			}
		}
	}
	// 仍未找到且未显式配置("gh" 是默认值,仅 PATH 查找,视为未配置):
	// Windows 弹框检查环境并自动下载(macOS/Linux 发行包已捆绑 gh,
	// 此路径不会触发)。
	if bin == "" && (cfg.GhBinary == "" || cfg.GhBinary == "gh") {
		if p, derr := ensureGhDownloadUI(); derr == nil {
			bin = p
		} else {
			log.Printf("[servermanager] gh 自动下载未完成: %v", derr)
		}
	}
	if bin == "" {
		s.lastErr = "找不到 gh 二进制(未捆绑且未安装;请在偏好设置里配置路径)"
		return s.statusLocked()
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		s.lastErr = err.Error()
		return s.statusLocked()
	}
	// 配置可能变更(地址/二进制),不一致时重建进程句柄;一致且仍在运行则
	// 直接复用 —— Start 可能被 main 冷启动与前端桥引导各调一次,重复
	// NewProc 会丢掉持有 gh 子进程 pid 的旧句柄,退出时将回收不到进程。
	if s.proc != nil {
		st := s.proc.Status()
		if st.Running && st.Addr == addr && st.DataDir == dataDir {
			s.proc.Touch()
			return st
		}
	}
	s.proc = ghserver.NewProc(ghserver.ProcConfig{GhBin: bin, Addr: addr, DataDir: dataDir})
	st := s.proc.Start()
	s.lastErr = st.LastError
	return st
}

// Stop 停止托管实例。
func (s *ServerManager) Stop() ghserver.Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc != nil {
		st := s.proc.Stop()
		s.lastErr = st.LastError
		return st
	}
	return s.statusLocked()
}

// statusLocked 调用方已持锁的状态快照。
func (s *ServerManager) statusLocked() ghserver.Status {
	if s.proc != nil {
		return s.proc.Status()
	}
	addr, dataDir, _ := s.dirs()
	return ghserver.Status{Addr: addr, DataDir: dataDir, LastError: s.lastErr}
}

// appConfigStore 桌面配置存储(internal/appcfg 的目录封装)。
func appConfigStore() *appcfg.Store {
	dir, err := appcfg.DefaultDir()
	if err != nil {
		return &appcfg.Store{Dir: "."}
	}
	return &appcfg.Store{Dir: dir}
}
