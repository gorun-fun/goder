// proxy.go — 桌面态 /grf-api/* 同源反代与根路由组合。反代核心在
// internal/ghserver.NewProxy;这里只负责解析桌面配置(托管实例优先,
// 远程模式取配置)并挂接 /grf-api/token 端点(前端冷启动零 wails 依赖
// 拿连接信息)。
package desktop

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"git.gorun.fun/share/goder/internal/appcfg"
	"git.gorun.fun/share/goder/internal/ghserver"
)

const proxyPrefix = "/grf-api"

// upstream 当前应转发到的上游(托管实例优先,远程模式取配置)。
func upstreamTarget() string {
	cfg, err := appConfigStore().Load()
	if err == nil && cfg.ServerMode == "remote" && cfg.RemoteURL != "" {
		return strings.TrimRight(cfg.RemoteURL, "/")
	}
	if addr, _, err := (&ServerManager{}).dirs(); err == nil {
		return "http://" + addr
	}
	return "http://127.0.0.1:7400"
}

// rootHandler 组合:/grf-api/* → 代理;/grf-api/token → 托管服务信息
// (同源直读,前端冷启动无需等 wails 调用通道);/grf-api/local-file → 本地
// 文件只读服务(右栏浏览器按路径渲染 html 等,替代 data URL);其余 → 前端
// 静态资源。
func RootHandler(fallback http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/grf-api/token", serveManagedToken)
	mux.HandleFunc("/grf-api/local-file", serveLocalFile)
	mux.Handle(proxyPrefix+"/", desktopProxy())
	mux.Handle(proxyPrefix, desktopProxy())
	mux.Handle("/", fallback)
	return mux
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

// serveLocalFile GET /grf-api/local-file?path=<绝对路径>:只读返回本地文件。
// 右栏内嵌浏览器用它在 iframe 里按本地路径渲染 html(file:// 被 webview
// 的源隔离拦下,data URL 又丢路径上下文,同源路径服务两者皆得)。
// 仅桌面本机场景,不做目录白名单;限制普通文件 + 64MB 上限。
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
