// server.go — MCP JSON-RPC over HTTP:与 gh mcp 包的 httpTransport 客户端
// 严格兼容(单 POST 单 application/json 应答,通知回空体)。鉴权为
// Bearer token(安装期生成的随机值,仅随 shim 参数下发)。
package console

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gorun-fun/goder/internal/browser"
)

// evalReportPath 浏览器求值回报端点(见 internal/browser/eval.go 的
// Windows 机制;macOS 不走此路径,挂着无害)。
const evalReportPath = browser.EvalReportPath

// protocolVersion 与 gh mcp 客户端声明一致(knownVersions 全集内的
// 最新版;客户端对未知版本会拒绝握手)。
const protocolVersion = "2025-06-18"

// Tool 一个 MCP 工具定义与处理器。
type Tool struct {
	Name        string
	Description string
	Schema      map[string]any
	ReadOnly    bool
	// Handler 执行工具。返回 content 与 isError(工具自身失败,协议层
	// 正常);参数问题也按 isError 返回,让模型能看到可修正的提示。
	Handler func(s *Server, args json.RawMessage) ([]Content, bool)
}

// Content 工具返回的内容项(text 或 image;与 gh mcp 客户端的 Content
// 结构对齐)。
type Content struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	Data     string `json:"data,omitempty"` // image 时为 base64
}

// rpcIn JSON-RPC 请求(gh 客户端只发 POST 单请求:id 为数字或缺失)。
type rpcIn struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcErrorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcOut struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      *int64        `json:"id"`
	Result  any           `json:"result,omitempty"`
	Error   *rpcErrorBody `json:"error,omitempty"`
}

// Handler 组装 HTTP 处理器:/mcp(JSON-RPC)+ /goder-eval-report(Windows
// 浏览器求值回报,见 internal/browser/eval.go)。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", s.serveMCP)
	mux.HandleFunc(evalReportPath, s.serveEvalReport)
	return mux
}

// serveEvalReport Windows 求值回报:body 首行调用 id,其余为信封 JSON。
// loopback + Bearer token 双重校验(与 /mcp 同一令牌;回环内任意进程
// 不可伪造应答回报)。
func (s *Server) serveEvalReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	id, payload, _ := strings.Cut(string(body), "\n")
	browser.CompleteEval(id, payload)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) serveMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	var req rpcIn
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	// 通知(无 id):200 空体即可(gh Notify 只看状态码)。
	if req.ID == nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	out := rpcOut{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		out.Result = map[string]any{
			"protocolVersion": s.negotiateVersion(req.Params),
			"capabilities":    map[string]any{},
			"serverInfo":      map[string]any{"name": "goder-console", "version": s.deps.Version},
		}
	case "ping":
		out.Result = map[string]any{}
	case "tools/list":
		tools := make([]map[string]any, 0, len(s.tools))
		for _, t := range s.tools {
			schema := t.Schema
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			tools = append(tools, map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"inputSchema": schema,
				"annotations": map[string]any{"readOnlyHint": t.ReadOnly},
			})
		}
		out.Result = map[string]any{"tools": tools}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			out.Error = &rpcErrorBody{Code: -32602, Message: "params 解析失败: " + err.Error()}
			break
		}
		t, ok := s.byName[p.Name]
		if !ok {
			out.Error = &rpcErrorBody{Code: -32602, Message: "未知工具: " + p.Name}
			break
		}
		text, isErr := t.Handler(s, p.Arguments)
		out.Result = map[string]any{
			"content": text,
			"isError": isErr,
		}
	default:
		out.Error = &rpcErrorBody{Code: -32601, Message: "未知方法: " + req.Method}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// negotiateVersion 回显客户端请求的已知版本(未知/缺省回落到当前版)。
func (s *Server) negotiateVersion(params json.RawMessage) string {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(params, &p)
	switch p.ProtocolVersion {
	case "2024-11-05", "2025-03-26", "2025-06-18":
		return p.ProtocolVersion
	}
	return protocolVersion
}

func (s *Server) checkAuth(r *http.Request) bool {
	if s.token == "" {
		return true
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" || got == r.Header.Get("Authorization") {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

// textErr 工具级失败的统一输出。
func textErr(format string, args ...any) ([]Content, bool) {
	return []Content{{Type: "text", Text: fmt.Sprintf(format, args...)}}, true
}

// textOk 工具成功输出。
func textOk(format string, args ...any) ([]Content, bool) {
	return []Content{{Type: "text", Text: fmt.Sprintf(format, args...)}}, false
}
