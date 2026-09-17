// desktop.go — Desktop 服务:桌面态专属能力(原生目录选择、在文件管理器
// 中显示路径、git 状态/差异读取)。前端经 Call.ByName("desktop.Desktop.*")
// 调用;纯 web 态不适用。
package desktop

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Desktop wails 服务。
type Desktop struct{}

// UserName 当前系统用户名(左栏底部身份展示用)。
func (d *Desktop) UserName() (string, error) {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username, nil
	}
	return "user", nil
}

// PickFolder 打开原生目录选择器;返回所选目录绝对路径,取消返回空串。
func (d *Desktop) PickFolder() (string, error) {
	return application.Get().Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
}

// Reveal 在系统的文件管理器中显示该路径(macOS Finder / Windows 资源
// 管理器 / Linux 桌面默认)。
func (d *Desktop) Reveal(path string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", "-R", path).Start()
	case "windows":
		return exec.Command("explorer.exe", "/select,", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}

// ---------- 目录浏览(左栏文件列表) ----------

// FileEntryDTO 与前端 host/bridge.ts 的 FileEntryDTO 对齐。
type FileEntryDTO struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"` // Unix 毫秒
}

// ListDir 列出目录一级条目(目录在前、同类型名称升序);"." 开头的隐藏
// 条目(.git/.DS_Store 等)不返回。
func (d *Desktop) ListDir(path string) ([]FileEntryDTO, error) {
	ents, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntryDTO, 0, len(ents))
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // 条目在枚举与取信息之间被删除:跳过
		}
		out = append(out, FileEntryDTO{
			Name:    e.Name(),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().UnixMilli(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// ReadFile 读取文本文件内容(右栏预览);上限 2MB,疑似二进制(前 8KB
// 含 NUL 字节)或目录返回错误。
func (d *Desktop) ReadFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s 是目录", path)
	}
	if info.Size() > 2<<20 {
		return "", fmt.Errorf("文件超过 2MB,不支持预览")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	head := b
	if len(head) > 8192 {
		head = head[:8192]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return "", fmt.Errorf("二进制文件,不支持预览")
	}
	return string(b), nil
}

// imageMimes 图片扩展名 → MIME(ReadImage 用)。
var imageMimes = map[string]string{
	"png":  "image/png",
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"gif":  "image/gif",
	"webp": "image/webp",
	"svg":  "image/svg+xml",
	"bmp":  "image/bmp",
	"ico":  "image/x-icon",
}

// ReadImage 读取图片文件为 data URL(右栏预览;上限 10MB);按扩展名给
// MIME,未知扩展名返回错误。
func (d *Desktop) ReadImage(path string) (string, error) {
	mime, ok := imageMimes[strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))]
	if !ok {
		return "", fmt.Errorf("不支持的图片格式:%s", filepath.Ext(path))
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s 是目录", path)
	}
	if info.Size() > 10<<20 {
		return "", fmt.Errorf("图片超过 10MB,不支持预览")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}

// ---------- git(审查面板) ----------

// GitEntryDTO 与前端 host/bridge.ts 的 GitEntryDTO 对齐。
type GitEntryDTO struct {
	Path     string `json:"path"`
	OrigPath string `json:"origPath"` // 重命名前的原路径(R 状态)
	Index    string `json:"index"`    // 暂存区状态(X 列)
	Work     string `json:"work"`     // 工作区状态(Y 列)
}

// GitStatusDTO 与前端 host/bridge.ts 的 GitStatusDTO 对齐。
type GitStatusDTO struct {
	Branch    string        `json:"branch"`
	Upstream  string        `json:"upstream"`
	Ahead     int           `json:"ahead"`
	Behind    int           `json:"behind"`
	Entries   []GitEntryDTO `json:"entries"`
	Additions int           `json:"additions"` // 行级变更(+)：工作区+暂存 vs HEAD
	Deletions int           `json:"deletions"` // 行级变更(-)
}

// GitStatus 读取仓库状态(porcelain v1 + 分支行);非 git 仓库返回带
// stderr 的错误。
func (d *Desktop) GitStatus(cwd string) (GitStatusDTO, error) {
	out, err := gitOutput(cwd, "status", "--porcelain=v1", "-b")
	if err != nil {
		return GitStatusDTO{}, err
	}
	dto := GitStatusDTO{Entries: []GitEntryDTO{}}
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 4 {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			parseBranchLine(strings.TrimSpace(line[3:]), &dto)
			continue
		}
		entry := GitEntryDTO{Index: line[0:1], Work: line[1:2]}
		path := line[3:]
		if i := strings.Index(path, " -> "); i >= 0 {
			entry.OrigPath = path[:i]
			path = path[i+4:]
		}
		entry.Path = path
		dto.Entries = append(dto.Entries, entry)
	}
	// 行级变更统计(状态浮窗「更改 +x -y」用)：numstat vs HEAD,含暂存与
	// 工作区;二进制文件列为 "-" 会被 Atoi 跳过;无提交/出错时保持 0。
	if out, err := gitOutput(cwd, "diff", "--numstat", "HEAD"); err == nil {
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			if n, err := strconv.Atoi(f[0]); err == nil {
				dto.Additions += n
			}
			if n, err := strconv.Atoi(f[1]); err == nil {
				dto.Deletions += n
			}
		}
	}
	return dto, nil
}

// GitDiff 读取单文件 diff 文本(staged=true 取已暂存差异)。
func (d *Desktop) GitDiff(cwd string, path string, staged bool) (string, error) {
	args := []string{"diff", "--no-color", "--no-ext-diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", path)
	return gitOutput(cwd, args...)
}

// gitOutput 在 cwd 执行 git 子命令,失败时带 stderr 返回错误。
func gitOutput(cwd string, args ...string) (string, error) {
	full := append([]string{"-C", cwd, "--no-optional-locks"}, args...)
	cmd := exec.Command("git", full...)
	hideConsole(cmd) // Windows:git 是控制台程序,不隐藏会闪 cmd 窗口
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%s", msg)
	}
	return stdout.String(), nil
}

// parseBranchLine 解析 "main...origin/main [ahead 1, behind 2]" 等
// porcelain 分支行。
func parseBranchLine(s string, dto *GitStatusDTO) {
	if rest, ok := strings.CutPrefix(s, "No commits yet on "); ok {
		dto.Branch = rest
		return
	}
	if i := strings.Index(s, "..."); i >= 0 {
		dto.Branch = s[:i]
		rest := s[i+3:]
		if j := strings.IndexByte(rest, ' '); j >= 0 {
			dto.Upstream = rest[:j]
		} else {
			dto.Upstream = rest
		}
	} else if i := strings.IndexByte(s, ' '); i >= 0 {
		dto.Branch = s[:i]
	} else {
		dto.Branch = s
	}
	if i := strings.IndexByte(s, '['); i >= 0 {
		for _, part := range strings.Split(strings.Trim(s[i:], "[]"), ", ") {
			fields := strings.Fields(part)
			if len(fields) != 2 {
				continue
			}
			if n, err := strconv.Atoi(fields[1]); err == nil {
				if fields[0] == "ahead" {
					dto.Ahead = n
				} else if fields[0] == "behind" {
					dto.Behind = n
				}
			}
		}
	}
}
