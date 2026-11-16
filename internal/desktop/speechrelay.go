// speechrelay.go — 语音输入转写接口的本地同源中继(桌面态)。
//
// 背景:OpenAI 兼容转写接口(尤其局域网自建网关)普遍不带 CORS 头,
// 浏览器直连跨域即被拦;桌面 webview 无法绕过。这里在本地服务上提供
// /goder-api/speech/* 两个同源端点,由 Go 侧服务端转发到用户配置的
// 接口基址(浏览器不再直连),与 /goder-api/token 同一装配模式:
// guardLocalHost 挡 DNS rebinding,LoopbackHostGuard 在最外层兜底。
//
// 安全边界:仅桌面本机可达(回环监听 + Host 白名单);上游基址由
// 请求头 X-Goder-STT-Base 携带(用户自配的转写接口,仅允许 http/https),
// 固定拼接 /models 与 /audio/transcriptions 两个后缀,不透传任意路径;
// API Key 经 Authorization 头透传上游,不落盘、不进日志。网页/嵌入形态
// 无此中继,仍要求接口自身允许跨域(设置页 hint 注明)。
package desktop

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// sttBaseHeader 携转写接口基址(如 http://192.168.3.100:9000/gw/voice/v1)。
// 主通道是 ?base= 查询参数:URL 路由在整条 /goder-api 链路上必然存活,
// 自定义请求头经 wails 资产管道/WKWebView scheme handler 存在不确定性
// (实测 webview 侧丢失,见前端 record.ts);头形式保留兼容。
const sttBaseHeader = "X-Goder-STT-Base"

// 中继上限与超时:转写音频(≤60s 录音)与模型列表都很小,宽放即可。
const (
	speechBodyLimit  = 32 << 20 // 请求体上限(录音 multipart)
	speechRespLimit  = 4 << 20  // 上游响应回读上限(JSON 很小)
	speechModelsWait = 25 * time.Second
	speechSttWait    = 70 * time.Second // 录音上限 60s + 转写余量
)

// serveSpeechModels GET/POST /goder-api/speech/models?base=<基址>:
// 转发 GET {base}/models。Key 经 Authorization 头透传(远程模式同款、
// 生产已验证的头通道)。GET 为主:与 /goder-api/token 同形态,无请求体。
func serveSpeechModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	base := speechBase(r)
	if base == "" {
		log.Printf("speechrelay: models 缺少/非法基址(header=%q query=%q)", r.Header.Get(sttBaseHeader), r.URL.Query().Get("base"))
		http.Error(w, "missing or invalid base", http.StatusBadRequest)
		return
	}
	relayUpstream(w, r, http.MethodGet, base+"/models", nil, "", speechModelsWait)
}

// serveSpeechTranscribe POST /goder-api/speech/transcribe?base=<基址>:
// 三种请求形态(请求体均先整体缓冲再发 —— WKWebView 自定义 scheme 请求
// 不带 Content-Length,流式透传会丢 body,与 ghserver 反代同一坑
// Go#16036;录音 ≤60s 体量小,缓冲无压力):
//   - enc=b64 + text/plain 体(macOS wails 主通道):音频 base64 成纯
//     文本体 —— WKWebView 自定义 scheme 只给 scheme handler 暴露字符串体
//     (聊天 JSON 即此通道),FormData/Blob 体不暴露、会整体丢失(实测
//     字段全空/0 字节文件);Go 侧解码并按查询参数重建 multipart;
//   - 裸音频体(Content-Type: audio/*):同上重建,兼容/测试通道;
//   - multipart/form-data:原样透传(网页直连形态不经此,留作测试)。
func serveSpeechTranscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	base := speechBase(r)
	if base == "" {
		log.Printf("speechrelay: transcribe 缺少/非法基址(header=%q query=%q)", r.Header.Get(sttBaseHeader), r.URL.Query().Get("base"))
		http.Error(w, "missing or invalid base", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, speechBodyLimit))
	if err != nil {
		http.Error(w, "request body too large or unreadable", http.StatusRequestEntityTooLarge)
		return
	}
	ct := r.Header.Get("Content-Type")
	q := r.URL.Query()
	if strings.HasPrefix(ct, "multipart/form-data") {
		relayUpstream(w, r, http.MethodPost, base+"/audio/transcriptions", bytes.NewReader(body), ct, speechSttWait)
		return
	}
	if q.Get("enc") == "b64" {
		dec, derr := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(body)))
		if derr != nil {
			http.Error(w, "invalid base64 audio", http.StatusBadRequest)
			return
		}
		body = dec
		if dur, lead, ok := wavHeadStats(body); ok {
			log.Printf("speechrelay: transcribe b64 音频 %d 字节(时长 %.2fs,头部静音 %.2fs)", len(body), dur.Seconds(), lead.Seconds())
		} else {
			log.Printf("speechrelay: transcribe b64 音频 %d 字节(fmt=%s,非标准 WAV 头)", len(body), q.Get("fmt"))
		}
	}
	// 音频体:按查询参数重建 multipart(file 文件名后缀优先 fmt,退化按 Content-Type)。
	ext := q.Get("fmt")
	if ext == "" {
		ext = audioExt(ct)
	}
	var form bytes.Buffer
	mw := multipart.NewWriter(&form)
	fw, ferr := mw.CreateFormFile("file", "speech."+ext)
	if ferr == nil {
		_, ferr = fw.Write(body)
	}
	if ferr == nil && q.Get("model") != "" {
		ferr = mw.WriteField("model", q.Get("model"))
	}
	if ferr == nil && q.Get("language") != "" {
		ferr = mw.WriteField("language", q.Get("language"))
	}
	if cerr := mw.Close(); ferr == nil {
		ferr = cerr
	}
	if ferr != nil {
		http.Error(w, "build multipart failed", http.StatusInternalServerError)
		return
	}
	relayUpstream(w, r, http.MethodPost, base+"/audio/transcriptions", &form, mw.FormDataContentType(), speechSttWait)
}

// audioExt 按音频 Content-Type 推文件名后缀(上游常按扩展名识别格式)。
func audioExt(contentType string) string {
	switch {
	case strings.Contains(contentType, "mp4"), strings.Contains(contentType, "m4a"):
		return "mp4"
	case strings.Contains(contentType, "ogg"):
		return "ogg"
	default:
		return "webm"
	}
}

// wavHeadStats 简析前端自产的 44 字节头 16-bit PCM WAV:总时长与头部
// 静音时长(诊断录音丢头用 —— 对照「按下→说话」墙钟即可分辨捕获侧
// 还是识别侧丢音)。非标准头返回 ok=false。
func wavHeadStats(b []byte) (dur, lead time.Duration, ok bool) {
	if len(b) < 46 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return 0, 0, false
	}
	rate := int(binary.LittleEndian.Uint32(b[24:28]))
	if rate <= 0 || binary.LittleEndian.Uint16(b[34:36]) != 16 {
		return 0, 0, false
	}
	samples := (len(b) - 44) / 2
	const thr = 600 // ~2% 满幅视为静音
	n := 0
	for n < samples && n < rate { // 头部静音最多扫 1s
		v := int(int16(binary.LittleEndian.Uint16(b[44+n*2:])))
		if v > thr || v < -thr {
			break
		}
		n++
	}
	return time.Duration(samples) * time.Second / time.Duration(rate),
		time.Duration(n) * time.Second / time.Duration(rate), true
}

// speechBase 解析并校验转写接口基址:优先 ?base= 查询参数,回落
// X-Goder-STT-Base 头;仅 http/https、去尾斜杠,其余(空/坏 URL/
// file:// 等)返回空串由调用方 400。
func speechBase(r *http.Request) string {
	raw := strings.TrimSpace(r.URL.Query().Get("base"))
	if raw == "" {
		raw = strings.TrimSpace(r.Header.Get(sttBaseHeader))
	}
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return strings.TrimRight(raw, "/")
}

// relayUpstream 服务端转发:Authorization 头透传,Content-Type 以
// contentType 参数为准(空 = 沿用入站头;重建 multipart 的场景必须用
// 新边界的 Content-Type),转发上游状态码、Content-Type 与响应体
// (限幅回读)。上游错误原样回传,前端按既有错误文案解读 HTTP 状态。
func relayUpstream(w http.ResponseWriter, r *http.Request, method, target string, body io.Reader, contentType string, wait time.Duration) {
	ctx, cancel := context.WithTimeout(r.Context(), wait)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		http.Error(w, "bad upstream url", http.StatusBadRequest)
		return
	}
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if contentType == "" {
		contentType = r.Header.Get("Content-Type")
	}
	if contentType != "" && body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("speechrelay: %s %s 上游不可达: %v", method, target, err)
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	log.Printf("speechrelay: %s %s → %d", method, target, resp.StatusCode)
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, speechRespLimit))
}
