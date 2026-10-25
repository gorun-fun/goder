// ghdownload.go — gh(grf-harness)按需自动下载:核心下载逻辑(跨平台)。
// 发行包不捆绑 gh 的平台(Windows/Linux)首次启动检测到缺失时,从官方
// 下载服务器(download.gorun.fun/grf-harness)拉取当前系统/架构的最新版
// 到用户配置目录 bin/ 下,作为后续启动的解析候选;macOS .app 正常已捆绑
// gh,仅捆绑副本缺失时静默补齐。
// 流程三平台同构(planGhDownload:平台目录 → 最新版本 → 落点 → URL →
// 大小),交互形态按平台:Windows 弹原生对话框(ghdownload_windows.go),
// 其余静默只打日志(ghdownload_silent.go)。
package desktop

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorun-fun/goder/internal/appcfg"
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

// ghPlatformDir 下载侧平台目录(与 CI 发布目录一致;gh 与 goder 两个产品
// 的发布目录结构相同,updater 也用它拼 goder 的下载地址)。
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

// latestGhVersion gh(grf-harness)下载服务器的最新版本目录。
func latestGhVersion() (string, error) {
	return latestDlVersion(ghDlBase)
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

// ghDownloadPlan 一次自动下载所需的全部参数(平台无关)。
type ghDownloadPlan struct {
	dir string // 下载侧平台目录
	ver string // 最新版本号
	dst string // 落点(<配置目录>/bin/gh[.exe])
	url string // 完整下载 URL
	// 精确大小(HEAD Content-Length);sizeKnown=false 表示探测失败,
	// 提示回退模糊描述。
	size      int64
	sizeKnown bool
}

// sizeDesc 下载大小的用户提示。
func (p ghDownloadPlan) sizeDesc() string {
	if p.sizeKnown {
		return fmt.Sprintf("%.1f MB", float64(p.size)/(1<<20))
	}
	return "约几十 MB"
}

// planGhDownload 解析平台目录/最新版本/落点并组装下载 URL —— 各平台的
// ensureGhDownload 共用入口,保证三平台落点与来源一致。
func planGhDownload() (ghDownloadPlan, error) {
	dir, err := ghPlatformDir()
	if err != nil {
		return ghDownloadPlan{}, err
	}
	ver, err := latestGhVersion()
	if err != nil {
		return ghDownloadPlan{}, fmt.Errorf("检查下载服务器失败: %w", err)
	}
	dst, err := managedGhPath()
	if err != nil {
		return ghDownloadPlan{}, err
	}
	p := ghDownloadPlan{
		dir: dir, ver: ver, dst: dst,
		url: ghDlBase + "/" + dir + "/" + ver + "/" + ghExeName(),
	}
	if sz, serr := remoteContentSize(p.url); serr == nil {
		p.size, p.sizeKnown = sz, true
	}
	return p, nil
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
	// 完整性校验(gh 发布目录的 SHA256SUMS 清单;历史目录无清单跳过),
	// 失败即丢弃 —— 不让未验证的字节顶替可执行文件。
	vctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := verifyDlChecksum(vctx, tmp, url); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := installDownload(tmp, dst); err != nil {
		return err
	}
	// 类 Unix 需要 gh 可执行(创建默认 0666;servermanager 的托管路径
	// 候选按执行位过滤,漏 chmod 会认不出刚下载的 gh)。Windows 上为空操作。
	_ = os.Chmod(dst, 0o755)
	// 完成信号:进度 UI 据此关闭对话框
	d.pct.Store(100)
	return nil
}

// installDownload 把下载完成的 tmp 落到 dst。直接覆盖式改名在 Windows 上
// 会因目标 exe 被占用(刚被杀的 gh server 句柄未释放、杀毒扫描中等)报
// Access is denied;NTFS 允许把被占用的 exe 改名挪走,但前提是目标名不
// 存在 —— 挪到已存在的名字是"替换",替换一个仍被执行的 exe(如上次更新
// 挪出的 .old 又被收养机制接管存活)会被永久拒绝、重试无效。故 .old 恒取
// 不存在的唯一名,整个交换过程另做短重试兜底句柄延迟释放;残留的 .old*
// 在成功后尽力清理(仍被占用的留待下次)。
func installDownload(tmp, dst string) error {
	old := uniqueOldPath(dst)
	var err error
	for i := 0; i < 20; i++ {
		if _, serr := os.Lstat(dst); serr == nil {
			if rerr := os.Rename(dst, old); rerr != nil {
				err = rerr
				time.Sleep(500 * time.Millisecond)
				continue
			}
		}
		if err = os.Rename(tmp, dst); err == nil {
			_ = os.Remove(old)
			cleanStaleOlds(dst)
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("落盘 %s 失败(文件被占用?): %w", dst, err)
}

// uniqueOldPath 取一个当前不存在的 .old 撤退名:优先固定 .old,已存在则
// 递增后缀(.old.2/.old.3…)。已存在的 .old 可能仍被旧 gh 进程占用,
// 正是替换式改名报 Access is denied 的来源,绝不能往它上面挪。
func uniqueOldPath(dst string) string {
	old := dst + ".old"
	for i := 2; ; i++ {
		if _, err := os.Lstat(old); os.IsNotExist(err) {
			return old
		}
		old = fmt.Sprintf("%s.old.%d", dst, i)
	}
}

// cleanStaleOlds 尽力清理 dst 同目录下历次更新挪出的 .old* 残留(仍被
// 占用的跳过,留待下次更新再试)。只匹配同名前缀,不碰其他文件。
func cleanStaleOlds(dst string) {
	dir := filepath.Dir(dst)
	prefix := filepath.Base(dst) + ".old"
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		if strings.HasPrefix(e.Name(), prefix) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
