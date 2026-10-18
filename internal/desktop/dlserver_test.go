// dlserver_test.go — 下载服务器客户端回归:版本择新(正式版 > 同基线
// 预发布)与 SHA256SUMS 完整性清单不进插件可安装列表(CI publish 随产物
// 生成清单,gh 0.0.1-alpha.29+)。
package desktop

import (
	"context"
	"net/http"
	"net/http/httptest"
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
