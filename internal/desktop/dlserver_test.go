// dlserver_test.go — 下载服务器客户端回归:版本择新(正式版 > 同基线
// 预发布)、SHA256SUMS 完整性清单不进插件可安装列表(CI publish 随产物
// 生成清单,gh 0.0.1-alpha.29+),与下载完整性校验面(.sha256 优先 /
// SHA256SUMS 回落 / 无校验面跳过 / 不匹配硬失败)。
package desktop

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLatestPluginsDirFiltersManifests(t *testing.T) {
	dir, err := ghPlatformDir()
	if err != nil {
		t.Skipf("测试平台无下载目录映射: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/" + dir + "/":
			// 版本择新:正式版排在同基线 alpha 之上
			w.Write([]byte(`<a href="0.0.1-alpha.14/">0.0.1-alpha.14/</a><a href="0.0.1/">0.0.1/</a>`))
		case "/" + dir + "/0.0.1/plugins/":
			// SHA256SUMS 是随产物的完整性清单,不是插件
			w.Write([]byte(`<a href="grf-browser">grf-browser</a><a href="SHA256SUMS">SHA256SUMS</a>`))
		default:
			// 旧版本目录不给产物,验证择新跳过它
			if strings.HasSuffix(r.URL.Path, "/plugins/") {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Write([]byte(`<a href="x">x</a>`))
		}
	}))
	defer srv.Close()
	t.Setenv("GODER_DOWNLOAD_BASE", srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rel, err := latestPluginsDir(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if rel == nil {
		t.Fatal("应有插件产物")
	}
	if rel.Version != "0.0.1" {
		t.Errorf("版本择新应选正式版 0.0.1,得到 %q", rel.Version)
	}
	if len(rel.Files) != 1 || rel.Files[0] != "grf-browser" {
		t.Errorf("清单文件应被过滤,期望 [grf-browser],得到 %v", rel.Files)
	}
}

// serveDlChecksumCase 假下载服务器:按 path→内容表应答,其余 404。
func serveDlChecksumCase(files map[string]string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if body, ok := files[r.URL.Path]; ok {
			w.Write([]byte(body))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
}

func TestExpectedDlChecksumSources(t *testing.T) {
	// 同目录同时有 .sha256 与 SHA256SUMS:.sha256 优先
	srv := serveDlChecksumCase(map[string]string{
		"/v1/gh.sha256":  strings.Repeat("a", 64) + "  gh",
		"/v1/SHA256SUMS": strings.Repeat("b", 64) + "  gh",
	})
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if got := expectedDlChecksum(ctx, srv.URL+"/v1/gh"); got != strings.Repeat("a", 64) {
		t.Fatalf(".sha256 应优先,得到 %q", got)
	}

	// 无 .sha256 时回落 SHA256SUMS(含二进制模式的 * 前缀行)
	srv2 := serveDlChecksumCase(map[string]string{
		"/v2/SHA256SUMS": "1111111111111111111111111111111111111111111111111111111111111111  other\n" +
			"2222222222222222222222222222222222222222222222222222222222222222 *gh\n",
	})
	defer srv2.Close()
	if got := expectedDlChecksum(ctx, srv2.URL+"/v2/gh"); got != strings.Repeat("2", 64) {
		t.Fatalf("SHA256SUMS 回落应按文件名命中,得到 %q", got)
	}

	// 两者皆无:空串(调用方跳过校验)
	srv3 := serveDlChecksumCase(map[string]string{"/v3/gh": "binary"})
	defer srv3.Close()
	if got := expectedDlChecksum(ctx, srv3.URL+"/v3/gh"); got != "" {
		t.Fatalf("无校验面应返回空串,得到 %q", got)
	}
}

func TestVerifyDlChecksum(t *testing.T) {
	body := "hello goder"
	sum := sha256.Sum256([]byte(body))
	hexsum := hex.EncodeToString(sum[:])

	// 校验面匹配 → 通过;不匹配 → 硬失败;无校验面 → 跳过通过
	srv := serveDlChecksumCase(map[string]string{"/v/gh.sha256": hexsum + "  gh"})
	defer srv.Close()
	srvBad := serveDlChecksumCase(map[string]string{"/v/gh.sha256": strings.Repeat("c", 64) + "  gh"})
	defer srvBad.Close()
	srvNone := serveDlChecksumCase(map[string]string{})
	defer srvNone.Close()

	f := filepath.Join(t.TempDir(), "gh")
	if err := os.WriteFile(f, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := verifyDlChecksum(ctx, f, srv.URL+"/v/gh"); err != nil {
		t.Fatalf("校验和匹配应通过: %v", err)
	}
	if err := verifyDlChecksum(ctx, f, srvBad.URL+"/v/gh"); err == nil {
		t.Fatal("校验和不匹配应硬失败")
	}
	if err := verifyDlChecksum(ctx, f, srvNone.URL+"/v/gh"); err != nil {
		t.Fatalf("无校验面应跳过: %v", err)
	}
}
