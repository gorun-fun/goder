// updater.go — Updater wails 服务:应用自动更新(覆盖 goder 自身与 gh)。
// 检查:前端驱动(打开即查、每小时复查),对比下载服务器目录列表与本地
// 版本(goder 版本号由构建时 -X 注入,gh 版本 exec --version 解析);
// 应用:确认后自动下载 → 安装 → 重启 —— goder 走自替换(macOS 换整个
// .app,Windows/裸二进制换可执行文件)后拉起新进程退出旧进程;gh 下载到
// 托管目录(<配置目录>/bin)后重启托管 gh server。
// 更新说明尽力而为:goder 取发布目录 notes.txt(CI 发版时写入),gh 取
// 源码库 tags API 的提交标题;取不到就只展示版本变化。
package desktop

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"git.gorun.fun/share/goder/internal/appcfg"
)

// appVersion 当前 goder 版本(build 时 -X 注入;本地构建为 "dev",
// 自更新检查跳过 —— 开发构建不与发布版本比较)。
var appVersion = "dev"

// AppVersion 返回当前 goder 版本号(build 时注入,本地构建为 "dev";
// test-serve 测试指导端点的元数据等二进制内消费方使用)。
func AppVersion() string { return appVersion }

// goderDlBase goder 已发布产物的下载基地址(与 gh 同一服务器、同一目录
// 结构 {base}/{平台}/{版本}/)。
const goderDlBase = "https://download.gorun.fun/goder"

// ghTagsAPI gh(grf-harness)源码库 tags API(匿名可读,取 tag 关联提交
// 标题当更新说明)。用数字项目 id:该 GitLab 匿名访问路径形式
// share%2Fgrf-harness 会 404;换 GitLab 时同步改这里,取不到只是说明为空。
const ghTagsAPI = "https://git.gorun.fun/api/v4/projects/21/repository/tags/"

// updateEvent 更新进度事件名(前端 host/bridge.ts onUpdateProgress 订阅)。
const updateEvent = "goder:update-progress"

// notesClient 更新说明探测用 HTTP 客户端(尽力而为,超时收紧)。
var notesClient = &http.Client{Timeout: 6 * time.Second}

// UpdateCompDTO 单个组件(goder/gh)的版本对比;与前端 host/bridge.ts 对齐。
type UpdateCompDTO struct {
	Current string `json:"current"`
	Latest  string `json:"latest"`
	Update  bool   `json:"update"`
}

// UpdateInfoDTO 一次检查的结果;与前端 host/bridge.ts 对齐。
type UpdateInfoDTO struct {
	Goder     UpdateCompDTO `json:"goder"`
	Gh        UpdateCompDTO `json:"gh"`
	GhManaged bool          `json:"ghManaged"` // gh 是否由本程序托管(远程模式/手动配置路径时不自动更新)
	GoderNote string        `json:"goderNote"` // 新版本说明(尽力而为,可能为空)
	GhNote    string        `json:"ghNote"`
	CheckedAt int64         `json:"checkedAt"` // Unix 毫秒
}

// UpdateProgressDTO 更新进度事件载荷;与前端 host/bridge.ts 对齐。
type UpdateProgressDTO struct {
	Which string `json:"which"` // goder | gh
	Phase string `json:"phase"` // download | install | restart | done | error
	Pct   int64  `json:"pct"`   // 0-100(仅 download 阶段有意义)
	Msg   string `json:"msg"`
}

// Updater wails 服务(全局单例)。
type Updater struct {
	mu   sync.Mutex
	info UpdateInfoDTO // 最近一次检查结果
	busy bool          // 是否有更新正在应用(同时只允许一个)
}

// updater 全局唯一实例。
var updater = &Updater{}

// GetUpdater 取全局 Updater。
func GetUpdater() *Updater { return updater }

func init() {
	// 启动后清掉上次自更新残留(旧 .app.old / *.old、update/ 下载目录)。
	go cleanupUpdateLeftovers()
}

// Check 检查更新(goder 与 gh 各自对比下载服务器最新版本),缓存并返回
// 结果。网络失败不报错:对应组件保持无更新,下次再查。
func (u *Updater) Check() UpdateInfoDTO {
	info := UpdateInfoDTO{CheckedAt: time.Now().UnixMilli()}

	// goder 自身:dev 构建不参与自更新比较。
	if v, err := latestDlVersion(goderDlBase); err == nil {
		info.Goder = UpdateCompDTO{
			Current: appVersion,
			Latest:  v,
			Update:  appVersion != "dev" && compareVersion(v, appVersion) > 0,
		}
		if info.Goder.Update {
			info.GoderNote = fetchGoderNote(v)
		}
	} else {
		info.Goder = UpdateCompDTO{Current: appVersion}
		log.Printf("[updater] 检查 goder 更新失败: %v", err)
	}

	// gh:仅托管模式且未手动配置路径时才提供自动更新(否则更新了也不生效)。
	cfg, _ := (&AppConfig{}).Load()
	info.GhManaged = cfg.ServerMode != "remote" && (cfg.GhBinary == "" || cfg.GhBinary == "gh")
	cur := ""
	if bin := GetServerManager().resolveGh(); bin != "" {
		cur = ghBinaryVersion(bin)
	}
	if v, err := latestGhVersion(); err == nil {
		info.Gh = UpdateCompDTO{
			Current: cur,
			Latest:  v,
			// compareGhVersion 含本地构建的开发后缀语义:运行中的
			// "基线-N-ghash" 构建比同基线发布版新,不应提示"更新"。
			Update: info.GhManaged && cur != "" && compareGhVersion(v, cur) > 0,
		}
		if info.Gh.Update {
			info.GhNote = fetchGhNote(v)
		}
	} else {
		info.Gh = UpdateCompDTO{Current: cur}
		log.Printf("[updater] 检查 gh 更新失败: %v", err)
	}

	u.mu.Lock()
	u.info = info
	u.mu.Unlock()
	return info
}

// Status 最近一次检查结果(未检查过为零值)。
func (u *Updater) Status() UpdateInfoDTO {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.info
}

// Apply 应用更新(which = "goder" | "gh"):异步执行(下载耗时数分钟,
// 不能占住调用通道),进度经 goder:update-progress 事件下发;返回只表示
// "已开始",失败同样走事件的 error 阶段。
func (u *Updater) Apply(which string) error {
	if which != "goder" && which != "gh" {
		return fmt.Errorf("未知更新目标 %q", which)
	}
	u.mu.Lock()
	if u.busy {
		u.mu.Unlock()
		return fmt.Errorf("已有更新正在进行")
	}
	u.busy = true
	u.mu.Unlock()
	go func() {
		doneMsg := ""
		var err error
		if which == "gh" {
			doneMsg, err = u.applyGh()
		} else {
			doneMsg, err = u.applyGoder()
		}
		// 先释放 busy 再下发终态事件:前端收到 done/error 后可能立即发起
		// 下一个组件的更新(先 gh 后 goder,一次确认全部更完),若此刻
		// busy 仍被占用,第二次 Apply 会被「已有更新正在进行」拒绝,用户
		// 只好再点一次。applyGh 的服务重启(defer sm.Start)在其 return
		// 前已执行完,不会与 goder 更新里的 Stop/Start 交叉。
		u.mu.Lock()
		u.busy = false
		u.mu.Unlock()
		if err != nil {
			log.Printf("[updater] %s 更新失败: %v", which, err)
			u.emit(UpdateProgressDTO{Which: which, Phase: "error", Msg: err.Error()})
			return
		}
		u.emit(UpdateProgressDTO{Which: which, Phase: "done", Msg: doneMsg})
	}()
	return nil
}

// emit 下发进度事件(wails 未就绪时静默跳过,如测试环境)。
func (u *Updater) emit(p UpdateProgressDTO) {
	if app := application.Get(); app != nil {
		app.Event.Emit(updateEvent, p)
	}
}

// download 受控下载 + 进度事件(复用 ghdownload 的断点/取消骨架,轮询
// 百分比每有变化即下发)。
func (u *Updater) download(which, url, dst string) error {
	dl := &ghDownload{}
	done := make(chan error, 1)
	go func() { done <- dl.run(url, dst) }()
	t := time.NewTicker(300 * time.Millisecond)
	defer t.Stop()
	var last int64 = -1
	for {
		select {
		case err := <-done:
			if err != nil {
				return err
			}
			u.emit(UpdateProgressDTO{Which: which, Phase: "download", Pct: 100})
			return nil
		case <-t.C:
			if p := dl.pct.Load(); p != last {
				last = p
				u.emit(UpdateProgressDTO{Which: which, Phase: "download", Pct: p})
			}
		}
	}
}

// applyGh 更新 gh:停托管服务 → 下载到托管目录(planGhDownload 落点)→
// 同步更新已安装插件 → 重启托管服务(新二进制经 servermanager 的托管目录
// 优先解析立即生效)。返回 done 阶段的提示文案;终态事件由 Apply 统一在
// 释放 busy 之后下发(保证前端能立即接续 goder 更新)。
func (u *Updater) applyGh() (string, error) {
	sm := GetServerManager()
	sm.Stop()
	defer sm.Start() // 失败也要把服务拉回来(幂等:已运行则复用)
	p, err := planGhDownload()
	if err != nil {
		return "", err
	}
	if err := u.download("gh", p.url, p.dst); err != nil {
		return "", err
	}
	u.emit(UpdateProgressDTO{Which: "gh", Phase: "install", Pct: 100, Msg: "正在同步插件"})
	syncPluginsForGh(p.dir, p.ver)
	u.emit(UpdateProgressDTO{Which: "gh", Phase: "install", Pct: 100, Msg: "正在重启 gh 服务"})
	return "gh 已更新到 " + p.ver, nil
}

// syncPluginsForGh gh 更新后把 ~/.grf/plugins/ 里已安装的插件同步到新版:
// 插件产物随 gh 版本发布(目录 {base}/{平台}/{版本}/plugins/),只换 gh
// 不换插件会留下旧插件配新 gh 的组合。只覆盖本地已存在的同名文件(用户
// 没装的不强推);逐个尽力而为,单个失败只记日志,不影响 gh 更新结果。
// 本地一个插件都没有时不访问网络(首装路径零开销)。
func syncPluginsForGh(dir, ver string) {
	local := filepath.Join(grfHome(), "plugins")
	ents, err := os.ReadDir(local)
	if err != nil {
		return // 目录不存在 = 一个插件都没装
	}
	var names []string
	for _, e := range ents {
		n := e.Name()
		if !e.IsDir() && !strings.HasPrefix(n, ".") && !strings.HasSuffix(n, ".md") && !isStaleOldName(n) {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	files, ok, err := listDlDir(ctx, fmt.Sprintf("%s/%s/%s/plugins/", ghDlBase, dir, ver))
	if err != nil || !ok {
		log.Printf("[updater] 同步插件:%s/%s 无插件产物,跳过(%v)", dir, ver, err)
		return
	}
	remote := make(map[string]bool, len(files))
	for _, f := range files {
		remote[f] = true
	}
	n := 0
	for _, name := range names {
		if !remote[name] {
			continue
		}
		url := fmt.Sprintf("%s/%s/%s/plugins/%s", ghDlBase, dir, ver, name)
		if err := downloadFile(ctx, url, filepath.Join(local, name)); err != nil {
			log.Printf("[updater] 同步插件 %s 失败: %v", name, err)
			continue
		}
		n++
	}
	if n > 0 {
		log.Printf("[updater] 已随 gh %s 同步更新 %d 个插件", ver, n)
	}
}

// applyGoder 更新 goder 自身:下载 zip → 解包 → 自替换(见 installGoder)
// → 停 gh(新进程会重新拉起)→ 启动新进程 → 退出当前进程。返回 done
// 阶段的提示文案;终态事件由 Apply 统一下发(前端把 restart 阶段视为
// 完成,之后进程即将退出)。
func (u *Updater) applyGoder() (string, error) {
	dir, err := ghPlatformDir()
	if err != nil {
		return "", err
	}
	ver, err := latestDlVersion(goderDlBase)
	if err != nil {
		return "", err
	}
	if appVersion != "dev" && compareVersion(ver, appVersion) <= 0 {
		return "", fmt.Errorf("当前已是最新版本(%s)", appVersion)
	}
	base, err := appcfg.DefaultDir()
	if err != nil {
		return "", err
	}
	work := filepath.Join(base, "update", ver)
	_ = os.RemoveAll(work) // 上次失败残留
	if err := os.MkdirAll(work, 0o755); err != nil {
		return "", err
	}
	zipPath := filepath.Join(work, "goder.zip")
	url := goderDlBase + "/" + dir + "/" + ver + "/" + goderZipName()
	if err := u.download("goder", url, zipPath); err != nil {
		return "", err
	}
	u.emit(UpdateProgressDTO{Which: "goder", Phase: "install", Pct: 100, Msg: "正在安装"})
	exDir := filepath.Join(work, "x")
	if err := unzip(zipPath, exDir); err != nil {
		return "", err
	}
	newExe, err := installGoder(exDir)
	if err != nil {
		return "", err
	}
	// 先停 gh 再起新进程:避免新进程收养一个即将被旧进程退出逻辑杀掉的
	// gh(servermanager.ServiceShutdown 在退出时回收托管进程)。
	GetServerManager().Stop()
	u.emit(UpdateProgressDTO{Which: "goder", Phase: "restart", Msg: "正在重启应用"})

	cmd := exec.Command(newExe)
	hideConsole(cmd)
	cmd.Dir = filepath.Dir(newExe)
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("启动新版本失败: %w", err)
	}
	time.Sleep(500 * time.Millisecond) // 让新进程先完成启动
	if app := application.Get(); app != nil {
		app.Quit()
	}
	return "goder 已更新到 " + ver, nil
}

// goderZipName 当前平台的 goder 发布 zip 名(与 CI 产物名一致:
// goder-macos-arm64.zip / goder-windows-amd64.zip / goder-linux-arm64.zip)。
func goderZipName() string {
	osName := runtime.GOOS
	if osName == "darwin" {
		osName = "macos"
	}
	return fmt.Sprintf("goder-%s-%s.zip", osName, runtime.GOARCH)
}

// goderExeName 当前平台的 goder 可执行文件名(zip 内)。
func goderExeName() string {
	if runtime.GOOS == "windows" {
		return "goder.exe"
	}
	return "goder"
}

// installGoder 把解包出的新版替换到当前运行位置,返回新版本可执行路径。
// 两种形态:macOS .app(整体换 .app,旧包改名 .old 留待启动清理)与裸
// 二进制(Windows 先改名旧 exe 再落新文件;类 Unix 运行中二进制不可
// 截断,先写 .new 再 rename 顶替 —— rename 不影响已映射的旧 inode)。
func installGoder(exDir string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	if runtime.GOOS == "darwin" && strings.HasSuffix(filepath.Dir(exe), "Contents/MacOS") {
		appRoot := filepath.Dir(filepath.Dir(filepath.Dir(exe))) // .../goder.app
		newApp := filepath.Join(exDir, "goder.app")
		if st, err := os.Stat(newApp); err != nil || !st.IsDir() {
			return "", fmt.Errorf("更新包内未找到 goder.app")
		}
		old := appRoot + ".old"
		_ = os.RemoveAll(old)
		if err := os.Rename(appRoot, old); err != nil {
			return "", fmt.Errorf("移开当前 App 失败(安装位置可能无写权限): %w", err)
		}
		if err := os.Rename(newApp, appRoot); err != nil {
			_ = os.Rename(old, appRoot) // 尽力回滚
			return "", err
		}
		return filepath.Join(appRoot, "Contents", "MacOS", "goder"), nil
	}
	newBin := filepath.Join(exDir, goderExeName())
	if _, err := os.Stat(newBin); err != nil {
		return "", fmt.Errorf("更新包内未找到 %s", goderExeName())
	}
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return "", fmt.Errorf("移开当前程序失败: %w", err)
		}
		if err := copyFile(newBin, exe, 0o755); err != nil {
			_ = os.Rename(old, exe)
			return "", err
		}
		return exe, nil
	}
	tmp := exe + ".new"
	if err := copyFile(newBin, tmp, 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return exe, nil
}

// copyFile 复制文件并设权限(跨文件系统落点不能用 rename 时的路径)。
func copyFile(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// unzip 解包 zip 到 dst(目录项建目录,普通文件按 zip 记录的权限落盘;
// 越界路径条目跳过)。发布 zip 由 CI 的 `zip -qry` 产出,无符号链接。
func unzip(src, dst string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	root := filepath.Clean(dst)
	for _, f := range r.File {
		p := filepath.Join(root, filepath.FromSlash(f.Name))
		if p != root && !strings.HasPrefix(p, root+string(os.PathSeparator)) {
			continue
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		mode := f.FileInfo().Mode()
		if mode.Perm() == 0 {
			mode = 0o644
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		err = writeZipEntry(rc, p, mode)
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// writeZipEntry 把一个 zip 条目内容写成文件(带权限)。
func writeZipEntry(rc io.Reader, dst string, mode os.FileMode) error {
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, rc); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ghBinaryVersion 执行 gh --version 解析当前版本(首行第二列,如
// "grf-harness 0.0.1-alpha.14");首列产物名不是 grf-harness(如 PATH 里
// 的同名 GitHub CLI)或执行失败返回空串。
func ghBinaryVersion(bin string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--version")
	hideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(out))
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	fields := strings.Fields(line)
	if len(fields) >= 2 && strings.HasPrefix(fields[0], "grf-harness") {
		return fields[1]
	}
	return ""
}

// fetchGhNote gh 新版本说明:源码库 tags API 的 tag 信息(轻量 tag 取关联
// 提交标题);尽力而为,失败返回空。发布目录不带 v 前缀而 git tag 带,
// 两种都探测。
func fetchGhNote(ver string) string {
	for _, tag := range []string{"v" + ver, ver} {
		resp, err := notesClient.Get(ghTagsAPI + tag)
		if err != nil || resp.StatusCode != 200 {
			if resp != nil {
				resp.Body.Close()
			}
			continue
		}
		var t struct {
			Message string `json:"message"`
			Commit  struct {
				Title   string `json:"title"`
				Message string `json:"message"`
			} `json:"commit"`
		}
		err = json.NewDecoder(resp.Body).Decode(&t)
		resp.Body.Close()
		if err != nil {
			continue
		}
		for _, s := range []string{t.Message, t.Commit.Title, t.Commit.Message} {
			if s = strings.TrimSpace(s); s != "" {
				return s
			}
		}
	}
	return ""
}

// fetchGoderNote goder 新版本说明:发布目录里的 notes.txt(CI 发版时从
// tag 提交信息写入;旧版本目录没有,取不到返回空)。
func fetchGoderNote(ver string) string {
	dir, err := ghPlatformDir()
	if err != nil {
		return ""
	}
	resp, err := notesClient.Get(goderDlBase + "/" + dir + "/" + ver + "/notes.txt")
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
		}
		return ""
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// cleanupUpdateLeftovers 启动后清理上次自更新的残留:旧包(.app.old /
// *.old)与 update/ 下载工作目录。稍作延迟 —— Windows 上旧进程退出与新
// 进程启动有短暂重叠,.old 可能仍被占用;清不掉就留给下次。
func cleanupUpdateLeftovers() {
	time.Sleep(5 * time.Second)
	updater.mu.Lock()
	busy := updater.busy
	updater.mu.Unlock()
	if busy { // 极端时序:刚启动就点了更新,别动它的工作目录
		return
	}
	if exe, err := os.Executable(); err == nil {
		if p, err := filepath.EvalSymlinks(exe); err == nil {
			exe = p
		}
		if runtime.GOOS == "darwin" && strings.HasSuffix(filepath.Dir(exe), "Contents/MacOS") {
			_ = os.RemoveAll(filepath.Dir(filepath.Dir(filepath.Dir(exe))) + ".old")
		} else {
			_ = os.Remove(exe + ".old")
		}
	}
	if dir, err := appcfg.DefaultDir(); err == nil {
		_ = os.RemoveAll(filepath.Join(dir, "update"))
	}
}
