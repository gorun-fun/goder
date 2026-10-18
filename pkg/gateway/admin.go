// admin.go — 管理 API(/admin/*):Bearer AdminToken 常量时间鉴权 +
// statuses/start/stop/restart 端点(headless 运维与三方后端的编程入口)。
package gateway

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
)

// adminMux /admin/* 子路由:<prefix>/admin/statuses(GET)、
// /admin/start?uid=<>(POST,幂等拉起)、/admin/stop?uid=<>(POST)、
// /admin/restart?uid=<>(POST,停止后拉起 —— 配置变更/进程僵死时用;
// 会换端口,数据目录不变)。Bearer AdminToken 鉴权;start/restart 的
// 启动类错误走 upstreamError 的类型化状态映射。
func (g *Gateway) adminMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/statuses", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if g.opts.Manager == nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"managed": false})
			return
		}
		sts := g.opts.Manager.Statuses()
		out := make(map[string]map[string]any, len(sts))
		for uid, st := range sts {
			out[uid] = map[string]any{
				"running": st.Running, "addr": st.Addr,
				"last_error": st.LastError, "pid": st.PID,
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"managed": true, "users": out})
	})
	startHandler := func(restart bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			uid := r.URL.Query().Get("uid")
			if uid == "" {
				http.Error(w, "missing uid", http.StatusBadRequest)
				return
			}
			if g.opts.Manager == nil {
				http.Error(w, "not managed", http.StatusConflict)
				return
			}
			if restart {
				g.opts.Manager.Stop(uid)
			}
			p, err := g.opts.Manager.Get(uid)
			if err != nil {
				g.upstreamError(w, err)
				return
			}
			st := p.Status()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "uid": uid, "running": st.Running,
				"addr": st.Addr, "pid": st.PID,
			})
		}
	}
	mux.HandleFunc("/start", startHandler(false))
	mux.HandleFunc("/restart", startHandler(true))
	mux.HandleFunc("/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		uid := r.URL.Query().Get("uid")
		if uid == "" {
			http.Error(w, "missing uid", http.StatusBadRequest)
			return
		}
		if g.opts.Manager == nil {
			http.Error(w, "not managed", http.StatusConflict)
			return
		}
		g.opts.Manager.Stop(uid)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"endpoints":["statuses","start?uid=","stop?uid=","restart?uid="]}`))
	})
	return mux
}

// requireAdmin 管理 API 的 Bearer AdminToken 鉴权中间件。
func (g *Gateway) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		// 常量时间比较:管理令牌是长期凭据,时序侧信道不值得留给攻击者。
		want := "Bearer " + g.opts.AdminToken
		if subtle.ConstantTimeCompare([]byte(auth), []byte(want)) != 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"管理令牌无效","type":"unauthorized"}}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}
