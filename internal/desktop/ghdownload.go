// ghdownload.go — gh(grf-harness)按需自动下载:核心下载逻辑(跨平台)。
// Windows/Linux 发行包不捆绑 gh,首次启动检测到缺失时从官方下载服务器
// (download.gorun.fun/grf-harness)拉取当前系统/架构的最新版到用户配置
// 目录 bin/ 下,作为后续启动的解析候选。
// 交互形态按平台:Windows 弹原生对话框(ghdownload_windows.go),
// Linux 静默下载(ghdownload_linux.go),macOS .app 已捆绑(no-op)。
package desktop

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"git.gorun.fun/share/goder/internal/appcfg"
)

// ghDlBase gh 已发布产物的下载基地址(与 CI 捆绑来源一致)。
const ghDlBase = "https://download.gorun.fun/grf-harness"

// ghClient 下载用 HTTP 客户端(gh 二进制几十 MB,超时放宽)。
var ghClient = &http.Client{Timeout: 15 * time.Minute}

// ghExeName 当前平台的 gh 可执行文件名。
func ghExeName() string {
	if runtime.GOOS == "windows" {
		return "gh.exe"
	}
	return "gh"
}

// managedGhPath 托管下载的目标路径(<配置目录>/bin/gh[.exe])。
func managedGhPath() (string, error) {
	dir, err := appcfg.DefaultDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "bin", ghExeName()), nil
}

// ghPlatformDir 下载侧平台目录(与 CI 发布目录一致)。
func ghPlatformDir() (string, error) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "darwin/arm64":
		return "macos-arm64", nil
	case "darwin/amd64":
		return "macos", nil
	case "linux/amd64":
		return "linux", nil
	case "linux/arm64":
		return "linux-arm64", nil
	case "windows/amd64":
		return "windows", nil
	case "windows/arm64":
		return "windows-arm64", nil
	}
	return "", fmt.Errorf("无 gh 发行包的平台 %s/%s", runtime.GOOS, runtime.GOARCH)
}

// latestGhVersion 抓下载服务器目录列表页(静态 HTML),取最大版本目录。
func latestGhVersion() (string, error) {
	dir, err := ghPlatformDir()
	if err != nil {
		return "", err
	}
	resp, err := ghClient.Get(ghDlBase + "/" + dir + "/")
	if err != nil {
		return "", fmt.Errorf("访问下载服务器失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("下载服务器返回 %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	// 目录链接形如 href="v1.2.3/" 或 href="1.2.3/"
	best := ""
	for _, m := range versionHrefRe.FindAllStringSubmatch(string(body), -1) {
		v := strings.Trim(m[1], "/")
		if best == "" || compareVersion(v, best) > 0 {
			best = v
		}
	}
	if best == "" {
		return "", fmt.Errorf("下载服务器目录页无版本条目")
	}
	return best, nil
}

// remoteContentSize 探测远端文件大小(HEAD Content-Length);失败返回错误,
// 调用方自行回退到模糊提示。
func remoteContentSize(url string) (int64, error) {
	resp, err := ghClient.Head(url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.ContentLength <= 0 {
		return 0, fmt.Errorf("HEAD 返回 %d(长度 %d)", resp.StatusCode, resp.ContentLength)
	}
	return resp.ContentLength, nil
}

// ghDownload 一次受控下载:progress 上报百分比(0-100),cancel 置位后中止。
type ghDownload struct {
	cancel  atomic.Bool
	pct     atomic.Int64
	total   int64
	version string
}

// run 执行下载:先落临时文件,成功后原子改名到目标路径。
func (d *ghDownload) run(url, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	resp, err := ghClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("下载返回 %d", resp.StatusCode)
	}
	d.total = resp.ContentLength

	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	var copied int64
	buf := make([]byte, 128<<10)
	for {
		if d.cancel.Load() {
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("已取消")
		}
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				os.Remove(tmp)
				return werr
			}
			copied += int64(n)
			if d.total > 0 {
				d.pct.Store(copied * 100 / d.total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(tmp)
			return rerr
		}
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return err
	}
	// 类 Unix 需要 gh 可执行(创建默认 0666;servermanager 的托管路径
	// 候选按执行位过滤,漏 chmod 会认不出刚下载的 gh)。Windows 上为空操作。
	_ = os.Chmod(dst, 0o755)
	// 完成信号:进度 UI 据此关闭对话框
	d.pct.Store(100)
	return nil
}

// compareVersion 比较 dotted 数字版本号(sort -V 语义的简化版):
// 逐段数值比较,段数少者视为补 0;非数字段按字符串比较兜底。
func compareVersion(a, b string) int {
	as := strings.Split(strings.TrimPrefix(a, "v"), ".")
	bs := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		av, bv := "0", "0"
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		an, aerr := strconv.Atoi(av)
		bn, berr := strconv.Atoi(bv)
		switch {
		case aerr != nil || berr != nil:
			if c := strings.Compare(av, bv); c != 0 {
				return c
			}
		case an != bn:
			if an < bn {
				return -1
			}
			return 1
		}
	}
	return 0
}

// versionHrefRe 目录列表页中的版本目录链接(形如 href="v1.2.3/")。
var versionHrefRe = regexp.MustCompile(`href="(v?[0-9][^"/]*)/"`)
