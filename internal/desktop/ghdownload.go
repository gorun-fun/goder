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
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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

// latestDlVersion 抓下载服务器目录列表页(静态 HTML),取当前平台最大
// 版本目录(gh 与 goder 共用;目录结构 {base}/{平台}/{版本}/)。
func latestDlVersion(base string) (string, error) {
	dir, err := ghPlatformDir()
	if err != nil {
		return "", err
	}
	resp, err := ghClient.Get(base + "/" + dir + "/")
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
// Access is denied;NTFS 允许把被占用的 exe 改名挪走,只是不能覆盖 —— 故
// 先把旧文件挪到 .old 再放新文件,并对整个交换过程做短重试兜底句柄延迟
// 释放。.old 删除失败(仍被占用)则留待下次覆盖,不阻塞更新。
func installDownload(tmp, dst string) error {
	old := dst + ".old"
	var err error
	for i := 0; i < 20; i++ {
		// 上一轮残留的 .old 此时若仍被占用,删除失败可忽略(随后对 dst 的
		// 改名挪走会再失败并进入重试)。
		_ = os.Remove(old)
		if _, serr := os.Lstat(dst); serr == nil {
			if rerr := os.Rename(dst, old); rerr != nil {
				err = rerr
				time.Sleep(500 * time.Millisecond)
				continue
			}
		}
		if err = os.Rename(tmp, dst); err == nil {
			_ = os.Remove(old)
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("落盘 %s 失败(文件被占用?): %w", dst, err)
}

// compareVersion 比较 dotted 版本号(sort -V 语义的修正版,兼容 semver 式
// 预发布):按 "." 分段,缺段补 "0"(1 与 1.0 相等)。段比较规则见
// compareVersionSeg —— 关键点:数字段带连字符预发布后缀(1-alpha)时,
// 无后缀的裸数字段(正式版 1)排在其上;而 X 与 X.postN 这类"纯字母数字
// 混排段"按自然序(postN 的数字后缀按数值比)。对本项目已发布的
// 0.0.1-alpha.N[.postM] 形态,新旧规则结果完全相同;新规则额外保证:
//   0.0.1-alpha.14 < 0.0.1-beta.1 < 0.0.1-rc.1 < 0.0.1(正式版)
//   0.0.1-alpha.14 < 0.0.1-alpha.14.post9 < ...post11(维持不变)
func compareVersion(a, b string) int {
	as := strings.Split(strings.TrimPrefix(a, "v"), ".")
	bs := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		av, bv := "0", "0" // 缺段补 "0":1 与 1.0 相等
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		if c := compareVersionSeg(av, bv); c != 0 {
			return c
		}
	}
	return 0
}

// compareVersionSeg 比较单个 "." 段。
// 结构化路径:两侧都是"数字前缀[-连字符后缀]"形态(如 1、14、1-alpha)时,
// 数字前缀按数值比;相同时无后缀(正式)大于有后缀(预发布),后缀之间
// 自然序比(alpha < beta < rc)。其余形态(post11 等混排段)整体自然序比。
func compareVersionSeg(x, y string) int {
	if x == y {
		return 0
	}
	xn, xs := splitNumHyphen(x)
	yn, ys := splitNumHyphen(y)
	if xn != "" && yn != "" {
		if c := compareNumericStr(xn, yn); c != 0 {
			return c
		}
		switch {
		case xs == "" && ys == "":
			return 0
		case xs == "":
			return 1 // 正式版段 > 预发布段
		case ys == "":
			return -1
		}
		return natCompare(xs, ys)
	}
	return natCompare(x, y)
}

// splitNumHyphen 拆出"数字前缀 + 连字符后缀":
// "14" → ("14","");"1-alpha" → ("1","alpha");非该形态 → ("",原串)。
func splitNumHyphen(s string) (num, suffix string) {
	if isDigitRun(s) {
		return s, ""
	}
	if i := strings.IndexByte(s, '-'); i > 0 && isDigitRun(s[:i]) {
		return s[:i], s[i+1:]
	}
	return "", s
}

// compareNumericStr 比较两个纯数字串(去前导零后先按位数再字典序)。
func compareNumericStr(x, y string) int {
	x, y = strings.TrimLeft(x, "0"), strings.TrimLeft(y, "0")
	if len(x) != len(y) {
		if len(x) < len(y) {
			return -1
		}
		return 1
	}
	return strings.Compare(x, y)
}

// verTokenRe 自然序比较的最小词:连续数字或连续非数字。
var verTokenRe = regexp.MustCompile(`[0-9]+|[^0-9]+`)

// natCompare 自然序比较:逐词比,数字词按数值比、非数字词按字符串比;
// 数字词排在非数字词前(post9 < post11 的数值序、0 < post0 的补位序
// 都由此成立)。
func natCompare(x, y string) int {
	xt := verTokenRe.FindAllString(x, -1)
	yt := verTokenRe.FindAllString(y, -1)
	for i := 0; i < len(xt) || i < len(yt); i++ {
		var xv, yv string
		if i < len(xt) {
			xv = xt[i]
		}
		if i < len(yt) {
			yv = yt[i]
		}
		if xv == yv {
			continue
		}
		xd, yd := isDigitRun(xv), isDigitRun(yv)
		switch {
		case xd && yd:
			if c := compareNumericStr(xv, yv); c != 0 {
				return c
			}
		case xd:
			return -1
		case yd:
			return 1
		default:
			if c := strings.Compare(xv, yv); c != 0 {
				return c
			}
		}
	}
	return 0
}

// isDigitRun 整串是否为数字(verTokenRe 的词要么全数字要么全非数字)。
func isDigitRun(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// versionHrefRe 目录列表页中的版本目录链接(形如 href="v1.2.3/")。
var versionHrefRe = regexp.MustCompile(`href="(v?[0-9][^"/]*)/"`)
