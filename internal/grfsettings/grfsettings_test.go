// grfsettings_test.go — Update 事务语义回归:换键保留其余键、ErrSkip
// 不落盘、缺文件时建新、输出格式与既有手抄一致(两空格缩进 + 尾换行)。
package grfsettings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestUpdate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	seed := "{\n  \"mouse\": true,\n  \"providers\": {\"a\": {\"base_url\": \"x\"}}\n}\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	err := Update(path, func(all map[string]json.RawMessage, existed bool) error {
		if !existed {
			t.Fatal("existed 应为 true")
		}
		if _, ok := all["providers"]; !ok {
			t.Fatal("providers 键应读出")
		}
		all["plugins"] = json.RawMessage(`[{"name":"x"}]`)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		t.Fatalf("落盘 JSON 应合法: %v", err)
	}
	for _, key := range []string{"mouse", "providers", "plugins"} {
		if _, ok := all[key]; !ok {
			t.Errorf("换键应保留其余键,缺 %s", key)
		}
	}
	if string(raw[len(raw)-1:]) != "\n" {
		t.Error("输出应带尾换行(与既有手抄一致)")
	}
}

func TestUpdateSkip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	seed := "{\"mouse\":true}\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Update(path, func(all map[string]json.RawMessage, existed bool) error {
		if !existed {
			t.Fatal("existed 应为 true")
		}
		return ErrSkip
	}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != seed {
		t.Errorf("ErrSkip 不应改动文件: %q", string(raw))
	}
}

func TestUpdateMissingAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	// 缺文件:existed=false,fn 改键后建新落盘
	path := filepath.Join(dir, "sub", "settings.json")
	if err := Update(path, func(all map[string]json.RawMessage, existed bool) error {
		if existed {
			t.Fatal("缺文件时 existed 应为 false")
		}
		all["plugins"] = json.RawMessage(`[]`)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("缺文件时应自动建目录落盘: %v", err)
	}
	// 损坏文件:existed=false + 空文档,fn 决定修复或跳过
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Update(path, func(all map[string]json.RawMessage, existed bool) error {
		if existed {
			t.Fatal("损坏文件 existed 应为 false")
		}
		if len(all) != 0 {
			t.Fatal("损坏文件读出应为空文档")
		}
		return errors.New("x") // 任意其他错误原样上抛且不落盘
	}); err == nil {
		t.Fatal("非 ErrSkip 错误应上抛")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "{not json" {
		t.Errorf("上抛错误时文件应保持原样: %q", string(raw))
	}
}
