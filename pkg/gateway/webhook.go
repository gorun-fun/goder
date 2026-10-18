// webhook.go — 进程生命周期事件的 webhook 接线:把 Manager 钩子转发到
// 配置的 WebhookURL(POST JSON 事件体;WebhookSecret 配置时附
// HMAC-SHA256 签名头 X-Goder-Signature)。
package gateway

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"git.gorun.fun/share/goder/pkg/ghserver"
)

// wireWebhook 把进程生命周期回调转发到配置的 WebhookURL(POST JSON,
// 事件体 {type, uid, addr?, reason?, ts};WebhookSecret 配置时附
// X-Goder-Signature: sha256=<hex(body)> HMAC-SHA256 签名头。投递尽力
// 而为,失败记日志)。
func (g *Gateway) wireWebhook(m *ghserver.Manager) {
	hook := g.opts.WebhookURL
	if hook == "" {
		return
	}
	secret := []byte(g.opts.WebhookSecret)
	post := func(body map[string]any) {
		body["ts"] = time.Now().UTC().Format(time.RFC3339)
		raw, err := json.Marshal(body)
		if err != nil {
			return
		}
		req, err := http.NewRequest(http.MethodPost, hook, bytes.NewReader(raw))
		if err != nil {
			log.Printf("webhook 构建请求失败: %v", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if len(secret) > 0 {
			mac := hmac.New(sha256.New, secret)
			_, _ = mac.Write(raw)
			req.Header.Set("X-Goder-Signature", "sha256 "+hex.EncodeToString(mac.Sum(nil)))
		}
		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("webhook 投递失败: %v", err)
			return
		}
		_ = resp.Body.Close()
	}
	m.SetHooks(ghserver.ManagerHooks{
		OnStart: func(uid, addr string) { post(map[string]any{"type": "proc.started", "uid": uid, "addr": addr}) },
		OnStop:  func(uid, reason string) { post(map[string]any{"type": "proc.stopped", "uid": uid, "reason": reason}) },
		OnCrash: func(uid string) { post(map[string]any{"type": "proc.crashed", "uid": uid}) },
	})
}
