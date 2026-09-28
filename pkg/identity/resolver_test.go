// resolver_test.go — single/header 两种 Resolver 的解析行为:固定 uid、
// 头缺失拒绝、空白清洗。
package identity

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSingleResolve(t *testing.T) {
	r := NewSingle(SingleConfig{})
	for i := 0; i < 2; i++ {
		u, err := r.Resolve(httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatalf("single 不应拒绝: %v", err)
		}
		if u.UID != "local" {
			t.Fatalf("默认 uid 应为 local,得到 %q", u.UID)
		}
	}
	if r.LoginURL() != "" || r.Routes() != nil {
		t.Fatal("single 无登录流程")
	}
}

func TestHeaderResolve(t *testing.T) {
	r := NewHeader(HeaderConfig{})

	// 缺头 → 401 语义错误
	if _, err := r.Resolve(httptest.NewRequest(http.MethodGet, "/", nil)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("缺头应返回 ErrUnauthorized,得到 %v", err)
	}

	// 带头 → 解析 uid/name(含空白清洗)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-GRF-UID", "  u42  ")
	req.Header.Set("X-GRF-Name", " 张三 ")
	u, err := r.Resolve(req)
	if err != nil {
		t.Fatalf("带头解析失败: %v", err)
	}
	if u.UID != "u42" || u.Name != "张三" {
		t.Fatalf("解析不符: %+v", u)
	}

	// 自定义头名
	custom := NewHeader(HeaderConfig{UIDHeader: "X-Custom-UID"})
	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	req2.Header.Set("X-Custom-UID", "cu")
	if u, err := custom.Resolve(req2); err != nil || u.UID != "cu" {
		t.Fatalf("自定义头解析不符: %+v %v", u, err)
	}

	// 空白 uid 视同缺失
	req3 := httptest.NewRequest(http.MethodGet, "/", nil)
	req3.Header.Set("X-GRF-UID", "   ")
	if _, err := r.Resolve(req3); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("空白 uid 应拒绝,得到 %v", err)
	}
}
