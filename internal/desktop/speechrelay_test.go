// speechrelay_test.go — 语音输入本地中继的转发回归:models/transcribe
// 两端点的上游转发(Authorization/Content-Type 透传、状态与响应体回传)、
// 基址校验(缺头/非 http/https 拒 400)与方法限制。
package desktop

import (
	"bytes"
	"encoding/base64"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// speechUpstream 模拟 OpenAI 兼容转写接口,记录收到的请求要素。
type speechUpstream struct {
	models      *httptest.Server
	stt         *httptest.Server
	sttAuth     string
	sttCT       string
	sttBodyLen  int
	sttFormFile bool
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
	t.Cleanup(func() {
		u.models.Close()
		u.stt.Close()
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
