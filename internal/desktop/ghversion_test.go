// ghversion_test.go gh 版本择新比较的回归:本地构建的 git describe 开发
// 后缀(<基线>-N-g<hash>[-dirty])必须排在基线发布版之上、下一基线之下;
// 发布版本之间的排序语义与 compareVersion 保持一致。
package desktop

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSplitGhDevSuffix(t *testing.T) {
	cases := []struct {
		in           string
		wantBaseline string
		wantCommits  int
	}{
		{"0.0.1-alpha.20", "0.0.1-alpha.20", 0},
		{"0.0.1-alpha.20-dirty", "0.0.1-alpha.20", 0},
		{"0.0.1-alpha.20-4-gead76cc", "0.0.1-alpha.20", 4},
		{"0.0.1-alpha.20-4-gead76cc-dirty", "0.0.1-alpha.20", 4},
		{"0.0.1-alpha.14.post11", "0.0.1-alpha.14.post11", 0},
		{"0.0.1", "0.0.1", 0},
	}
	for _, c := range cases {
		b, n := splitGhDevSuffix(c.in)
		if b != c.wantBaseline || n != c.wantCommits {
			t.Errorf("splitGhDevSuffix(%q) = (%q,%d),期望 (%q,%d)", c.in, b, n, c.wantBaseline, c.wantCommits)
		}
	}
}

func TestCompareGhVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int // a 相对 b:1 新 / 0 相等 / -1 旧
	}{
		// 本地 dev 构建在基线之上
		{"0.0.1-alpha.20-4-gead76cc-dirty", "0.0.1-alpha.20", 1},
		{"0.0.1-alpha.20", "0.0.1-alpha.20-4-gead76cc-dirty", -1},
		{"0.0.1-alpha.20-4-gead76cc", "0.0.1-alpha.20-9-gabcdef0", -1},
		{"0.0.1-alpha.20-dirty", "0.0.1-alpha.20", 0},
		// 基线不同按 compareVersion:跨基线 dev 仍受基线约束
		{"0.0.1-alpha.20-4-gead76cc", "0.0.1-alpha.19", 1},
		{"0.0.1-alpha.20-4-gead76cc", "0.0.1-beta.1", -1},
		{"0.0.1-alpha.20-4-gead76cc", "0.0.1", -1},
		// 发布版语义不变(与 compareVersion 一致)
		{"0.0.1-alpha.14", "0.0.1-alpha.14.post11", -1},
		{"0.0.1", "0.0.1-rc.1", 1},
		{"0.0.1-alpha.20", "0.0.1-alpha.20", 0},
	}
	for _, c := range cases {
		if got := compareGhVersion(c.a, c.b); got != c.want {
			t.Errorf("compareGhVersion(%q,%q) = %d,期望 %d", c.a, c.b, got, c.want)
		}
	}
}

// TestGhBinNewer 用假 gh 脚本验证择新探测:candidate 版本更新才返回 true;
// 非 grf-harness 的同名程序(GitHub CLI 形态)不参与择新。
func TestGhBinNewer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 gh 脚本仅类 Unix 可用")
	}
	dir := t.TempDir()
	fake := func(name, output string) string {
		p := filepath.Join(dir, name)
		script := "#!/bin/sh\ncat <<'EOF'\n" + output + "\nEOF\n"
		if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	managed := fake("gh-managed", "grf-harness 0.0.1-alpha.20\n配置文件: x")
	newer := fake("gh-newer", "grf-harness 0.0.1-alpha.20-4-gead76cc-dirty")
	older := fake("gh-older", "grf-harness 0.0.1-alpha.19")
	ghcli := fake("gh-ghcli", "gh version 2.43.0 (abc 2024-01-01)")
	broken := filepath.Join(dir, "gh-broken")

	if !ghBinNewer(newer, managed) {
		t.Error("dev 构建应比同基线托管副本新")
	}
	if ghBinNewer(older, managed) {
		t.Error("旧发布版不应判新")
	}
	if ghBinNewer(managed, managed) {
		t.Error("同版本不应判新(维持托管优先)")
	}
	if ghBinNewer(ghcli, managed) {
		t.Error("非 grf-harness 程序不应参与择新")
	}
	if ghBinNewer(broken, managed) {
		t.Error("探测失败不应判新")
	}
	if !strings.Contains(ghBinaryVersion(newer), "alpha.20-4") {
		t.Errorf("ghBinaryVersion 解析不符: %q", ghBinaryVersion(newer))
	}
	if ghBinaryVersion(ghcli) != "" {
		t.Error("GitHub CLI 的 --version 输出应判为非本产品")
	}
}
