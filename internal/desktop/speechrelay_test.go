// speechrelay_test.go — 语音本地中继的转发回归:models/transcribe/tts
// 三端点的上游转发(Authorization/Content-Type 透传、状态与响应体回传)、
// 基址校验(缺头/非 http/https 拒 400)与方法限制。
package desktop

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// speechUpstream 模拟 OpenAI 兼容语音接口,记录收到的请求要素。
type speechUpstream struct {
	models      *httptest.Server
	stt         *httptest.Server
	tts         *httptest.Server
	sttAuth     string
	sttCT       string
	sttBodyLen  int
	sttFormFile bool
	ttsAuth     string
	ttsCT       string
	ttsPayload  map[string]any
}

func newSpeechUpstream(t *testing.T) *speechUpstream {
	t.Helper()
	u := &speechUpstream{}
	u.models = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" || r.Method != http.MethodGet {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"qwen3-asr-0.6b"}]}`))
	}))
	u.stt = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/audio/transcriptions" || r.Method != http.MethodPost {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		u.sttAuth = r.Header.Get("Authorization")
		u.sttCT = r.Header.Get("Content-Type")
		u.sttBodyLen = int(r.ContentLength)
		u.sttFormFile = r.FormValue("model") == "qwen3-asr-0.6b" && r.FormValue("language") != ""
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"你好世界"}`))
	}))
	u.tts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/audio/speech" || r.Method != http.MethodPost {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		u.ttsAuth = r.Header.Get("Authorization")
		u.ttsCT = r.Header.Get("Content-Type")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &u.ttsPayload)
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write([]byte("RIFFfake-wav-bytes"))
	}))
	t.Cleanup(func() {
		u.models.Close()
		u.stt.Close()
		u.tts.Close()
	})
	return u
}

func relayReq(t *testing.T, method, path, base string, body *bytes.Buffer, ct string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		rdr = bytes.NewReader(body.Bytes())
	} else {
		rdr = bytes.NewReader(nil)
	}
	// 基址主通道:?base= 查询参数(与前端一致);头形式见回落测试
	req := httptest.NewRequest(method, "http://127.0.0.1"+path+"?base="+url.QueryEscape(base), rdr)
	req.Header.Set("Authorization", "Bearer test-key")
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	w := httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	return w
}

func TestSpeechRelayModels(t *testing.T) {
	u := newSpeechUpstream(t)
	w := relayReq(t, http.MethodGet, "/goder-api/speech/models", u.models.URL+"/", nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("models 中继状态 = %d, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "qwen3-asr-0.6b") {
		t.Fatalf("models 中继应回传上游列表, got %s", w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "json") {
		t.Fatalf("应透传上游 Content-Type, got %q", ct)
	}
}

// 头形式(X-Goder-STT-Base)保留兼容:查询参数缺位时回落。
func TestSpeechRelayModelsHeaderFallback(t *testing.T) {
	u := newSpeechUpstream(t)
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/goder-api/speech/models", nil)
	req.Header.Set(sttBaseHeader, u.models.URL)
	w := httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "qwen3-asr-0.6b") {
		t.Fatalf("头回落应可用, code = %d, body = %s", w.Code, w.Body.String())
	}
}

func TestSpeechRelayTranscribe(t *testing.T) {
	u := newSpeechUpstream(t)
	// 构造与前端一致的 multipart(file + model + language)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "speech.webm")
	_, _ = fw.Write([]byte("\x1a\x00fake-webm-audio"))
	_ = mw.WriteField("model", "qwen3-asr-0.6b")
	_ = mw.WriteField("language", "zh-CN")
	_ = mw.Close()

	w := relayReq(t, http.MethodPost, "/goder-api/speech/transcribe", u.stt.URL, &buf, mw.FormDataContentType())
	if w.Code != http.StatusOK {
		t.Fatalf("transcribe 中继状态 = %d, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "你好世界") {
		t.Fatalf("transcribe 中继应回传上游 text, got %s", w.Body.String())
	}
	if u.sttAuth != "Bearer test-key" {
		t.Fatalf("Authorization 应透传上游, got %q", u.sttAuth)
	}
	if !strings.HasPrefix(u.sttCT, "multipart/form-data") {
		t.Fatalf("multipart Content-Type 应透传(含边界), got %q", u.sttCT)
	}
	if !u.sttFormFile {
		t.Fatal("上游应收到完整的 form 字段(model/language)")
	}
	if u.sttBodyLen <= 0 {
		t.Fatalf("上游应收到带 Content-Length 的请求体(整体缓冲补齐), got %d", u.sttBodyLen)
	}
}

// 裸音频体(macOS wails 主通道:fetch 的 FormData 体经 WKWebView 自定义
// scheme 丢失,浏览器改发裸音频 + 查询参数,Go 侧重建 multipart)。
func TestSpeechRelayTranscribeRawAudio(t *testing.T) {
	u := newSpeechUpstream(t)
	q := url.Values{"base": {u.stt.URL}, "model": {"qwen3-asr-0.6b"}, "language": {"zh-CN"}}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/goder-api/speech/transcribe?"+q.Encode(), strings.NewReader("fake-raw-audio"))
	req.Header.Set("Content-Type", "audio/webm")
	req.Header.Set("Authorization", "Bearer test-key")
	w := httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "你好世界") {
		t.Fatalf("裸音频中继应回传上游 text, code = %d, body = %s", w.Code, w.Body.String())
	}
	if !strings.HasPrefix(u.sttCT, "multipart/form-data") {
		t.Fatalf("上游应收到的 multipart(重建), got %q", u.sttCT)
	}
	if !u.sttFormFile {
		t.Fatal("重建的 multipart 应含完整 form 字段(model/language)")
	}
}

// b64 通道(macOS wails 实际形态):音频 base64 成纯文本体,Go 解码重建 multipart。
func TestSpeechRelayTranscribeBase64(t *testing.T) {
	u := newSpeechUpstream(t)
	q := url.Values{"base": {u.stt.URL}, "model": {"qwen3-asr-0.6b"}, "language": {"zh"}, "enc": {"b64"}, "fmt": {"webm"}}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/goder-api/speech/transcribe?"+q.Encode(),
		strings.NewReader(base64.StdEncoding.EncodeToString([]byte("fake-webm-audio-payload"))))
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	w := httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "你好世界") {
		t.Fatalf("b64 中继应回传上游 text, code = %d, body = %s", w.Code, w.Body.String())
	}
	if !u.sttFormFile {
		t.Fatal("解码重建的 multipart 应含完整 form 字段(model/language)")
	}
	if u.sttBodyLen <= 0 {
		t.Fatalf("上游应收到带长度的请求体, got %d", u.sttBodyLen)
	}
}

// TTS 中继:text/plain 文本体 + 查询参数(WKWebView 字符串体才存活)→
// 重建 OpenAI 兼容 JSON 转发上游,音频响应透传。
func TestSpeechRelayTts(t *testing.T) {
	u := newSpeechUpstream(t)
	q := url.Values{"base": {u.tts.URL}, "model": {"qwen3-tts-12hz-0.6b-base"}, "voice": {"daji"}, "speed": {"1.5"}}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/goder-api/speech/tts?"+q.Encode(), strings.NewReader("  你好,世界 "))
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	req.Header.Set("Authorization", "Bearer test-key")
	w := httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("tts 中继状态 = %d, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "RIFFfake-wav-bytes") {
		t.Fatalf("tts 中继应回传上游音频, got %s", w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "audio/") {
		t.Fatalf("应透传上游音频 Content-Type, got %q", ct)
	}
	if u.ttsAuth != "Bearer test-key" {
		t.Fatalf("Authorization 应透传上游, got %q", u.ttsAuth)
	}
	if !strings.Contains(u.ttsCT, "application/json") {
		t.Fatalf("上游应收 JSON 体, got %q", u.ttsCT)
	}
	if u.ttsPayload["model"] != "qwen3-tts-12hz-0.6b-base" || u.ttsPayload["voice"] != "daji" {
		t.Fatalf("上游应收到 model/voice, got %v", u.ttsPayload)
	}
	if u.ttsPayload["input"] != "你好,世界" {
		t.Fatalf("文本应去首尾空白后进 input, got %q", u.ttsPayload["input"])
	}
	if sp, ok := u.ttsPayload["speed"].(float64); !ok || sp != 1.5 {
		t.Fatalf("speed 应转数值透传, got %v (%T)", u.ttsPayload["speed"], u.ttsPayload["speed"])
	}
}

// TTS:speed 缺省不带(部分网关不识别)、JSON 转义安全(文本含引号/换行)。
func TestSpeechRelayTtsEscaping(t *testing.T) {
	u := newSpeechUpstream(t)
	q := url.Values{"base": {u.tts.URL}, "model": {"tts-1"}, "voice": {"alloy"}}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/goder-api/speech/tts?"+q.Encode(), strings.NewReader(`含"引号"与\n换行`))
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	w := httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("tts 中继状态 = %d, body = %s", w.Code, w.Body.String())
	}
	if _, has := u.ttsPayload["speed"]; has {
		t.Fatalf("speed 未配置时不应下发, got %v", u.ttsPayload)
	}
	if in, _ := u.ttsPayload["input"].(string); !strings.Contains(in, `"引号"`) {
		t.Fatalf("特殊字符应经 JSON 编码安全送达, got %q", in)
	}
}

// TTS 校验:缺 base / 空文本 400,非 POST 405。
func TestSpeechRelayTtsValidation(t *testing.T) {
	u := newSpeechUpstream(t)
	q := url.Values{"base": {u.tts.URL}, "model": {"tts-1"}}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/goder-api/speech/tts?"+q.Encode(), strings.NewReader("   "))
	w := httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("空白文本应拒 400, got %d", w.Code)
	}
	w = relayReq(t, http.MethodPost, "/goder-api/speech/tts", "", bytes.NewBufferString("hi"), "text/plain")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("缺 base 应拒 400, got %d", w.Code)
	}
	req = httptest.NewRequest(http.MethodPut, "http://127.0.0.1/goder-api/speech/tts?base=http://x&model=tts-1", nil)
	w = httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT 应拒 405, got %d", w.Code)
	}
}

func TestSpeechRelayBaseValidation(t *testing.T) {
	for _, base := range []string{"", "ftp://x/v1", "not-a-url"} {
		w := relayReq(t, http.MethodGet, "/goder-api/speech/models", base, nil, "")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("base = %q 应拒 400, got %d", base, w.Code)
		}
	}
}

func TestSpeechRelayMethodGuard(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "http://127.0.0.1/goder-api/speech/models?base=http://x", nil)
	w := httptest.NewRecorder()
	RootHandler(http.NotFoundHandler()).ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT 应拒 405, got %d", w.Code)
	}
}
