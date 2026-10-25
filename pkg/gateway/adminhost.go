// adminhost.go — 宿主管理端点(/admin/* 的扩展):把「嵌入方直写 goder
// 私有文件」升级为 API 声明。覆盖四类此前只有文件协议的能力:
//   - 供应商声明(PUT /users/{uid}/providers)+ 指纹查询(openos 请求路径
//     幂等确保用)+ managed:true 注入(代理层就地完成,全部嵌入方免费);
//   - 裸名模型解析(GET /users/{uid}/resolve-model,结构化结果);
//   - 宿主 stdio 插件安装/清单/卸载(POST /plugins/install 等,规格存档
//     含原始 uid,存量自愈不再解析 wrapper 反抠);
//   - 会话分组索引(GET/PUT /users/{uid}/index + 追加归组端点)与用户
//     目录生命周期(GET /users、DELETE /users/{uid})。
//
// 全部端点要求 PerUserHome 布局(共享 ~/.grf 形态没有按用户隔离的
// settings/插件/索引,409 拒绝);供应商/插件/索引写操作对「从未打开过
// goder 的用户」直接建目录落盘,赶在播种与 gh 首启之前生效。
package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorun-fun/goder/pkg/ghserver"
)

// registerHostAdmin 把宿主管理端点挂进 admin 子路由(Manager 缺失时
// 仅注册用户态依赖项,声明类端点对 fixed-upstream 形态无意义)。
func (g *Gateway) registerHostAdmin(mux *http.ServeMux) {
	mux.HandleFunc("GET /users", g.hUsersList)
	mux.HandleFunc("DELETE /users/{uid}", g.hUserDelete)
	mux.HandleFunc("GET /users/{uid}/providers", g.hProvidersGet)
	mux.HandleFunc("PUT /users/{uid}/providers", g.hProvidersPut)
	mux.HandleFunc("GET /users/{uid}/resolve-model", g.hResolveModel)
	mux.HandleFunc("POST /plugins/install", g.hPluginInstall)
	mux.HandleFunc("GET /plugins", g.hPluginsList)
	mux.HandleFunc("DELETE /plugins", g.hPluginDelete)
	mux.HandleFunc("GET /users/{uid}/index", g.hIndexGet)
	mux.HandleFunc("PUT /users/{uid}/index", g.hIndexPut)
	mux.HandleFunc("POST /users/{uid}/index/sessions", g.hIndexAppend)
}

// requireManaged 托管模式 + PerUserHome 的公共守卫(声明类端点前提)。
func (g *Gateway) requireManaged(w http.ResponseWriter) *ghserver.Manager {
	m := g.opts.Manager
	if m == nil {
		http.Error(w, "not managed", http.StatusConflict)
		return nil
	}
	if !m.PerUserHomeEnabled() {
		http.Error(w, "requires per-user GRF_HOME layout", http.StatusConflict)
		return nil
	}
	return m
}

func ajson(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func aerr(w http.ResponseWriter, status int, msg string) {
	ajson(w, status, map[string]any{"error": msg})
}

// hUsersList GET /users — 全部用户目录概览(含未在线用户;宿主全量
// 声明同步的遍历面,取代 openos 时代的 ForEachGrfHome 目录扫描)。
func (g *Gateway) hUsersList(w http.ResponseWriter, _ *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	users := m.ListUsers()
	out := make([]map[string]any, 0, len(users))
	for _, u := range users {
		out = append(out, map[string]any{"san": u.San, "running": u.Running, "addr": u.Addr})
	}
	ajson(w, http.StatusOK, map[string]any{"users": out})
}

// hUserDelete DELETE /users/{uid} — 删号级联清理(宿主删用户钩子的落点)。
func (g *Gateway) hUserDelete(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	uid := r.PathValue("uid")
	if uid == "" {
		aerr(w, http.StatusBadRequest, "missing uid")
		return
	}
	if err := m.DeleteUser(uid); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ajson(w, http.StatusOK, map[string]any{"ok": true})
}

// hProvidersGet GET /users/{uid}/providers — settings.json 的 (mtime,size)
// 指纹 + 最近声明的受管名(宿主请求路径上的幂等缓存判定用:指纹与本地
// 缓存一致即免重放声明,保持热路径低开销)。
func (g *Gateway) hProvidersGet(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	uid := r.PathValue("uid")
	sp := filepath.Join(m.UserGrfHome(uid), "settings.json")
	mark := ""
	if st, err := os.Stat(sp); err == nil {
		mark = strconv.FormatInt(st.ModTime().UnixNano(), 10) + ":" + strconv.FormatInt(st.Size(), 10)
	}
	ajson(w, http.StatusOK, map[string]any{
		"mark":    mark,
		"managed": ghserver.ReadManagedProviders(m.UserRoot(uid)),
	})
}

// hProvidersPut PUT /users/{uid}/providers — 应用一次托管供应商声明
// (条目合成与默认模型决策链见 ghserver.ProvidersDecl;受管名清单同步
// 落档,代理层 managed:true 注入与下一轮残留清理都以它为准)。
func (g *Gateway) hProvidersPut(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	uid := r.PathValue("uid")
	if uid == "" {
		aerr(w, http.StatusBadRequest, "missing uid")
		return
	}
	var decl ghserver.ProvidersDecl
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&decl); err != nil {
		aerr(w, http.StatusBadRequest, "请求体解析失败: "+err.Error())
		return
	}
	home, err := m.EnsureUserHome(uid)
	if err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	applied, err := ghserver.UpsertProviders(filepath.Join(home, "settings.json"), decl)
	if err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := ghserver.WriteManagedProviders(m.UserRoot(uid), decl.Managed); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ajson(w, http.StatusOK, map[string]any{"ok": true, "applied": applied})
}

// hResolveModel GET /users/{uid}/resolve-model?name= — 裸名/限定名/空(默认)
// 的结构化解析(宿主无头任务 fail-fast 判定用;错误文案由宿主合成)。
func (g *Gateway) hResolveModel(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	uid := r.PathValue("uid")
	sp := filepath.Join(m.UserGrfHome(uid), "settings.json")
	res := ghserver.ResolveModelName(sp, strings.TrimSpace(r.URL.Query().Get("name")))
	ajson(w, http.StatusOK, res)
}

// hPluginInstall POST /plugins/install {uid, name, command} — 安装宿主
// stdio 插件(wrapper + 显式列表 upsert + 规格存档,规格含原始 uid)。
func (g *Gateway) hPluginInstall(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	var req struct {
		UID     string   `json:"uid"`
		Name    string   `json:"name"`
		Command []string `json:"command"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		aerr(w, http.StatusBadRequest, "请求体解析失败: "+err.Error())
		return
	}
	if req.UID == "" || req.Name == "" {
		aerr(w, http.StatusBadRequest, "uid / name 必填")
		return
	}
	home, err := m.EnsureUserHome(req.UID)
	if err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := ghserver.InstallPlugin(home, req.Name, req.Command); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := ghserver.WritePluginSpec(m.UserRoot(req.UID), ghserver.PluginSpec{
		Name: req.Name, UID: req.UID, Command: req.Command,
	}); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ajson(w, http.StatusOK, map[string]any{"ok": true})
}

// hPluginsList GET /plugins — 全部已安装宿主插件的清单(规格存档里的
// 原始 uid 是存量自愈的遍历面,取代解析 wrapper 内容反抠)。
func (g *Gateway) hPluginsList(w http.ResponseWriter, _ *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	out := []map[string]any{}
	for _, u := range m.ListUsers() {
		for _, spec := range ghserver.ReadPluginSpecs(m.UserRoot(u.San)) {
			out = append(out, map[string]any{"uid": spec.UID, "san": u.San, "name": spec.Name})
		}
	}
	ajson(w, http.StatusOK, map[string]any{"plugins": out})
}

// hPluginDelete DELETE /plugins?uid=&name= — 卸载宿主插件。
func (g *Gateway) hPluginDelete(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	uid, name := r.URL.Query().Get("uid"), r.URL.Query().Get("name")
	if uid == "" || name == "" {
		aerr(w, http.StatusBadRequest, "uid / name 必填")
		return
	}
	if err := ghserver.RemovePlugin(m.UserGrfHome(uid), name); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := ghserver.DeletePluginSpec(m.UserRoot(uid), name); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ajson(w, http.StatusOK, map[string]any{"ok": true})
}

// hIndexGet GET /users/{uid}/index — 会话分组索引原文(无文件返回 null)。
func (g *Gateway) hIndexGet(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	raw := ghserver.ReadIndex(m.UserRoot(r.PathValue("uid")))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if len(raw) == 0 {
		_, _ = w.Write([]byte("null"))
		return
	}
	_, _ = w.Write(raw)
}

// hIndexPut PUT /users/{uid}/index — 整存索引(浏览器侧 setPersistence
// 适配器的 save 落点;与追加端点经同一把用户级互斥锁串行)。
func (g *Gateway) hIndexPut(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		aerr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := ghserver.WriteIndex(m.UserRoot(r.PathValue("uid")), raw); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ajson(w, http.StatusOK, map[string]any{"ok": true})
}

// hIndexAppend POST /users/{uid}/index/sessions — 保真追加一条会话到分组
// 项目(宿主无头任务代建会话的归组落点;读改写在服务端一把锁内完成,
// 消掉 GET→merge→PUT 的丢更新窗口)。
func (g *Gateway) hIndexAppend(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	var a ghserver.IndexSessionAppend
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&a); err != nil {
		aerr(w, http.StatusBadRequest, "请求体解析失败: "+err.Error())
		return
	}
	if err := ghserver.AppendIndexSession(m.UserRoot(r.PathValue("uid")), a); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ajson(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- 用户态索引端点(身份即鉴权,非 admin) ----

// hUserIndexGet / hUserIndexPut <prefix>/index — 浏览器侧 goder 嵌入件的
// 会话索引 load/save 落点(经网关身份解析定位用户;openos 的
// setPersistence 适配器从 user_settings 镜像切换到这里后,goder.index 的
// 权威存储收敛进 goder-serve,宿主不再扮演存储中介)。
func (g *Gateway) hUserIndexGet(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	u, err := g.opts.Resolver.Resolve(r)
	if err != nil {
		g.unauthorized(w)
		return
	}
	raw := ghserver.ReadIndex(m.UserRoot(u.UID))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if len(raw) == 0 {
		_, _ = w.Write([]byte("null"))
		return
	}
	_, _ = w.Write(raw)
}

func (g *Gateway) hUserIndexPut(w http.ResponseWriter, r *http.Request) {
	m := g.requireManaged(w)
	if m == nil {
		return
	}
	u, err := g.opts.Resolver.Resolve(r)
	if err != nil {
		g.unauthorized(w)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		aerr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := ghserver.WriteIndex(m.UserRoot(u.UID), raw); err != nil {
		aerr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ajson(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- managed:true 注入(GET /v1/agent/models 代理特化) ----

// injectManagedModels 对 GET /v1/agent/models 的代理响应注入 managed:true
// (嵌入约定的「平台托管只读」语义,原由每个嵌入方各自在反代层改写;现由
// 网关统一完成——声明过受管供应商的嵌入方全部免费获得)。命中则就地应答
// 并返回 true;任何失败回落常规代理(不因注入面破坏正常链路)。
func (g *Gateway) injectManagedModels(w http.ResponseWriter, r *http.Request, up ghserver.Upstream, uid string) bool {
	if r.Method != http.MethodGet || r.URL.Path != g.prefix+"/v1/agent/models" || g.opts.Manager == nil {
		return false
	}
	m := g.opts.Manager
	if !m.PerUserHomeEnabled() {
		return false
	}
	managed := ghserver.ReadManagedProviders(m.UserRoot(uid))
	if len(managed) == 0 {
		return false
	}
	target := up.Target.String() + "/v1/agent/models"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		return false
	}
	if up.Token != "" {
		req.Header.Set("Authorization", "Bearer "+up.Token)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil || resp.StatusCode != http.StatusOK {
		return false
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		return false
	}
	var provs []any
	if err := json.Unmarshal(body["providers"], &provs); err != nil {
		return false
	}
	set := map[string]bool{}
	for _, n := range managed {
		set[n] = true
	}
	for _, p := range provs {
		if pm, ok := p.(map[string]any); ok {
			if n, _ := pm["name"].(string); set[n] {
				pm["managed"] = true
			}
		}
	}
	body["providers"], err = json.Marshal(provs)
	if err != nil {
		return false
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
	return true
}
