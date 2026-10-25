// proxy.go — 桌面态 /goder-api/* 同源反代与根路由组合。反代核心在
// internal/ghserver.NewProxy;这里只负责解析桌面配置(托管实例优先,
// 远程模式取配置)并挂接 /goder-api/token 端点(前端冷启动零 wails 依赖
// 拿连接信息)。
package desktop

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gorun-fun/goder/internal/appcfg"
	"github.com/gorun-fun/goder/pkg/ghserver"
)

const proxyPrefix = "/goder-api"

// rootHandler 组合:/goder-api/* → 代理;/goder-api/token → 托管服务信息
// (同源直读,前端冷启动无需等 wails 调用通道);/goder-api/local-file → 本地
// 文件只读服务(右栏浏览器按路径渲染 html 等,替代 data URL);其余 → 前端
// 静态资源。/goder-api 整段过本机 Host 校验(见 LoopbackHostGuard)。
func RootHandler(fallback http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/goder-api/token", guardLocalHost(serveManagedToken))
	mux.HandleFunc("/goder-api/local-file", guardLocalHost(serveLocalFile))
	mux.Handle(proxyPrefix+"/", LoopbackHostGuard(desktopProxy()))
	mux.Handle(proxyPrefix, LoopbackHostGuard(desktopProxy()))
	mux.Handle("/", fallback)
	return mux
}

// localHostAllowed 本机敏感端点放行的 Host 白名单:127.0.0.1 / localhost /
// *.localhost(wails 生产源 goder.localhost 等)与空 Host(部分内嵌
// webview 不带)。防 DNS rebinding:恶意网页以自有域名解析到 127.0.0.1,
// 请求的 Host 是攻击者域名而非本机已知主机名,一律不放行。
func localHostAllowed(host string) bool {
	host = strings.ToLower(host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host == "" || host == "127.0.0.1" || host == "localhost" || strings.HasSuffix(host, ".localhost")
}

// guardLocalHost 单端点的 Host 白名单中间件(403 拒绝非本机主机名)。
func guardLocalHost(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !localHostAllowed(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// LoopbackHostGuard 本地 HTTP 服务的敏感路径整段 Host 守卫:/goder-api*
// 与 /wails/*(wails 调用通道,经 transport.Handler 挂进本地服务器,且
// wails v3 transport 自身不做来源校验)只放行本机已知主机名,其余路径
// (静态资产,公开内容)直通。包装在本地服务最外层使用(Windows 生产态
// 与 test-serve 的组装点);此前只有 token/local-file 两个端点有守卫,
// rebinding 页面仍可借 /goder-api 反代(服务端注入 Bearer)或直调
// /wails/runtime 服务(终端/更新器)改动机器状态。
func LoopbackHostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if (strings.HasPrefix(p, "/goder-api") || strings.HasPrefix(p, "/wails/")) && !localHostAllowed(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// localFileTypes 本地文件服务的 Content-Type(缺省按内容嗅探退化)。
var localFileTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".htm":  "text/html; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".txt":  "text/plain; charset=utf-8",
}

// serveLocalFile GET /goder-api/local-file?path=<绝对路径>:只读返回本地文件。
// 右栏内嵌浏览器用它在 iframe 里按本地路径渲染 html(file:// 被 webview
// 的源隔离拦下,data URL 又丢路径上下文,同源路径服务两者皆得)。
// 仅桌面本机场景;双层防线:guardLocalHost 挡外域页面,localFileAllowed
// 收窄可读面到 主目录/gh 数据目录/项目索引登记的项目目录。限制普通文件
// + 64MB 上限。
func serveLocalFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}
	if !localFileAllowed(path) {
		http.Error(w, "path not allowed", http.StatusForbidden)
		return
	}
	if st.Size() > 64<<20 {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	if ct, ok := localFileTypes[strings.ToLower(filepath.Ext(path))]; ok {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, path)
}

// localFileAllowed local-file 服务的路径白名单:落在用户主目录、托管 gh
// 数据目录或项目索引登记的项目目录之内才放行。Host 白名单(上方)防的
// 是外域页面借 DNS rebinding 命中端点;这里防的是 UI 层一旦被注入后把
// 任意系统文件(/etc、其他用户目录)回读外传——右栏浏览器/文件预览的
// 合法场景(项目文件、~ 下文档)不受影响。
func localFileAllowed(path string) bool {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		real = path // Stat 已成功,个别平台评估失败时退回原路径
	}
	for _, root := range localFileRoots() {
		abs, err := filepath.Abs(root)
		if err != nil || abs == "" {
			continue
		}
		if ev, err := filepath.EvalSymlinks(abs); err == nil {
			abs = ev // 根目录自身是符号链接(macOS 数据目录常见)时按真实路径比
		}
		prefix := filepath.Clean(abs) + string(filepath.Separator)
		if strings.HasPrefix(filepath.Clean(real), prefix) {
			return true
		}
	}
	return false
}

// localFileRoots 收集允许根目录:用户主目录、托管 gh server 数据目录、
// 全部 scope 项目索引里登记的项目目录(项目可建在任意位置,用户自选)。
func localFileRoots() []string {
	var roots []string
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		roots = append(roots, home)
	}
	if st := GetServerManager().Status(); st.DataDir != "" {
		roots = append(roots, st.DataDir)
	}
	dir, err := appcfg.DefaultDir()
	if err != nil {
		return roots
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return roots
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "index-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		// 只取 path 字段;索引其余结构由前端全权定义,这里不耦合。
		var idx struct {
			Projects []struct {
				Path string `json:"path"`
			} `json:"projects"`
		}
		if json.Unmarshal(data, &idx) != nil {
			continue
		}
		for _, p := range idx.Projects {
			if p.Path != "" {
				roots = append(roots, p.Path)
			}
		}
	}
	return roots
}

// desktopProxy 桌面态代理:每请求解析上游;托管模式下注入进程令牌
// (与 web 网关同一条路径:浏览器不直接持有 gh 令牌)。
func desktopProxy() http.Handler {
	return ghserver.NewProxy(ghserver.ProxyOptions{
		Prefix: proxyPrefix,
		Resolve: func(*http.Request) (ghserver.Upstream, error) {
			cfg, err := appConfigStore().Load()
			if err != nil {
				cfg = appcfg.Default()
			}
			if cfg.ServerMode == "remote" && cfg.RemoteURL != "" {
				t, err := url.Parse(strings.TrimRight(cfg.RemoteURL, "/"))
				if err != nil {
					return ghserver.Upstream{}, err
				}
				// 远程模式:令牌由浏览器携带(配置里手填的那份),原样转发。
				return ghserver.Upstream{Target: t}, nil
			}
			// 托管模式:注入当前进程令牌。
			st := GetServerManager().Status()
			t, err := url.Parse("http://" + st.Addr)
			if err != nil {
				return ghserver.Upstream{}, err
			}
			return ghserver.Upstream{Target: t, Token: st.Token}, nil
		},
	})
}

// serveManagedToken 托管模式下的连接信息(仅本机 webview 的 wails:// 源可
// 访问;远程模式返回 remote 配置由前端本地掌握,不经此端点)。
func serveManagedToken(w http.ResponseWriter, r *http.Request) {
	cfg, err := appConfigStore().Load()
	if err != nil {
		cfg = appcfg.Default()
	}
	resp := map[string]any{"mode": cfg.ServerMode}
	if cfg.ServerMode == "managed" {
		st := GetServerManager().Status()
		resp["running"] = st.Running
		resp["addr"] = st.Addr
		resp["token"] = st.Token
	} else {
		resp["token"] = cfg.RemoteToken
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
