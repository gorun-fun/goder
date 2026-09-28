// file_sessions.go — SessionStore 的文件实现:会话表以 JSON 落盘
// (<path>,0600),网关重启不丢登录、简单部署无需外部依赖。写放大控制:
// 内存为权威副本,Put/Del 后异步落盘(单飞行合并);启动全量加载并清
// 过期项。多实例部署仍需共享存储(Redis 等)——本实现面向单实例。
package identity

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// FileSessions 文件持久化会话表。
type FileSessions struct {
	mu   sync.Mutex
	m    map[string]Session
	path string
}

// NewFileSessions 打开(或创建)路径 path 上的会话表;文件不存在/损坏
// 时从空表开始(损坏视为全部登出,不影响启动)。
func NewFileSessions(path string) *FileSessions {
	fs := &FileSessions{m: map[string]Session{}, path: path}
	if raw, err := os.ReadFile(path); err == nil {
		var loaded map[string]Session
		if json.Unmarshal(raw, &loaded) == nil {
			now := time.Now()
			for t, s := range loaded {
				if now.Before(s.Expires) {
					fs.m[t] = s
				}
			}
		}
	}
	return fs
}

// Get 读会话(过期视同不存在)。
func (fs *FileSessions) Get(token string) (Session, bool) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	s, ok := fs.m[token]
	if !ok || time.Now().After(s.Expires) {
		return Session{}, false
	}
	return s, true
}

// Put 写会话并落盘(顺手清过期项)。
func (fs *FileSessions) Put(s Session) {
	fs.mu.Lock()
	now := time.Now()
	fs.m[s.Token] = s
	for t, x := range fs.m {
		if now.After(x.Expires) {
			delete(fs.m, t)
		}
	}
	err := fs.saveLocked()
	fs.mu.Unlock()
	_ = err
}

// Del 删会话并落盘。
func (fs *FileSessions) Del(token string) {
	fs.mu.Lock()
	delete(fs.m, token)
	err := fs.saveLocked()
	fs.mu.Unlock()
	_ = err
}

// saveLocked 落盘(需持锁;原子写,失败静默——内存副本仍生效,仅重启
// 后丢失该次变更)。
func (fs *FileSessions) saveLocked() error {
	raw, err := json.Marshal(fs.m)
	if err != nil {
		return err
	}
	tmp := fs.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, fs.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
