// ghdownload_test.go — installDownload 辅助逻辑的单测(纯文件操作,
// 跨平台可跑;Windows 独有的占用语义无法在 CI 里模拟,靠唯一名规避)。
package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUniqueOldPath(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "gh.exe")
	if err := os.WriteFile(dst, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 无残留:首选固定 .old
	if got := uniqueOldPath(dst); got != dst+".old" {
		t.Fatalf("无残留时应取固定 .old,得到 %q", got)
	}
	// .old 已存在(可能仍被旧进程占用):必须避让,取 .old.2
	if err := os.WriteFile(dst+".old", []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := uniqueOldPath(dst); got != dst+".old.2" {
		t.Fatalf(".old 残留时应取 .old.2,得到 %q", got)
	}
	// 连 .old.2 也存在:继续递增
	if err := os.WriteFile(dst+".old.2", []byte("old2"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := uniqueOldPath(dst); got != dst+".old.3" {
		t.Fatalf("多级残留时应取 .old.3,得到 %q", got)
	}
}

func TestInstallDownloadSwapsAndCleans(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "gh.exe")
	if err := os.WriteFile(dst, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, "gh.exe.part")
	if err := os.WriteFile(tmp, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 预置历史残留:installDownload 成功后应被尽力清掉
	stale := filepath.Join(dir, "gh.exe.old.9")
	if err := os.WriteFile(stale, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installDownload(tmp, dst); err != nil {
		t.Fatalf("installDownload: %v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "new" {
		t.Fatalf("dst 内容应为 new,得到 %q", b)
	}
	if _, err := os.Lstat(tmp); !os.IsNotExist(err) {
		t.Fatal("tmp 应已挪走")
	}
	if _, err := os.Lstat(stale); !os.IsNotExist(err) {
		t.Fatal("残留 .old.9 应被清理")
	}
}
