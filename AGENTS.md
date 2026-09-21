# AGENTS.md

Goder:grf-harness(gh)的 ZCode 风格图形界面。一个 Lit 前端,多种形态:
wails v3 桌面 App(内置托管 `gh server` 子进程)、可嵌入三方页面的 web components
库(`frontend/dist-embed/grf-ui.js`,ESM、零外部依赖、shadow DOM 自隔离),
以及多用户 web 网关(`cmd/grf-web-serve`:一个登录用户一个独立 gh server 进程)。

## 常用命令

- `./build.sh` — 前端 + 桌面二进制 `./goder`
- `./build.sh app` — 组装 macOS `dist/goder.app`(adhoc 签名)
- `./build.sh embed` — 仅构建嵌入库 `frontend/dist-embed/grf-ui.js`
- `./build.sh web` — 纯 web 形态(grf-web-serve 网关:静态 + `/grf-api`,
  http://127.0.0.1:7700;身份模式与多用户参数见 cmd/grf-web-serve 头注释)
- `./start.sh start|stop|restart` — 桌面 App 生命周期(后台运行,PID/日志在 `.run/`)
- 类型检查:`cd frontend && npx tsc --noEmit`;Go:`go build ./... && go vet ./...`
- (无自动化测试;E2E 为真实 gh server + 真实模型的手动浏览器验证,
  playwright-cli 或浏览器驱动)
- **发版(打版)规则**:推送 tag 触发 GitLab CI(`.gitlab-ci.yml`,
  仅 tag 触发)。tag 与产物版本号 = gh(grf-harness)最新发布 tag;
  gh 未更新而本程序再次发版时追加 `.postN`(N 从 0 递增,
  推算脚本 `scripts/version.sh`,tag 名应与推算值一致)。
  发版步骤:`sh scripts/version.sh` 得版本 → 先推送 main →
  `git tag v<版本> && git push origin v<版本>`。
  已发版本以下载服务器目录为准(download.gorun.fun/goder);
  受保护 tag 不可移动,误发的 tag 只能另打新 tag 重触发。
- **版本号约定**:形态 `X.Y.Z[-预发布.N][.postM]`,如
  `0.0.1-alpha.14`、`0.0.1-alpha.14.post11`、`0.0.1-beta.1`、`0.0.1`(正式)。
  预发布后缀递进 alpha(内测)< beta(公测)< rc(候选);同基线本程序
  再发版追加 `.postN`(高于该基线,低于下一个 gh 基线);正式版为无后缀
  裸版本号,压过同号全部预发布与 post。排序有三处实现、必须同一套语义:
  桌面端自动更新 `internal/desktop/ghdownload.go` 的 `compareVersion`、
  发版推算 `scripts/version.sh` 的 `ver_max`(awk)、CI 捆绑 gh 下载
  (调 `sh scripts/version.sh gh`)。不要用 `sort -V` 替代:它把正式版排
  在预发布之下且 postN 按字符串比。改比较规则时三处同改,并用矩阵用例
  (内测/公测/候选/正式/postN/跨基线)验证。

## 结构与分层

```
internal/                Go 共享层(桌面壳与 web 网关同一套实现)
  ghserver/              Proc(单 gh server 生命周期:启动/收养/就绪等待/
                         令牌/停止)+ Manager(uid → Proc:端口池分配、懒启动、
                         空闲回收、数量上限)+ NewProxy(反代核心:去前缀、
                         注入 Bearer、SSE flush、无 Content-Length body 缓冲补齐)
  appcfg/                桌面配置与项目索引的文件持久化(wails AppConfig 薄壳用)
  identity/              身份解析 Resolver:single(单用户)/ header(信任上级
                         网关用户头,被集成推荐)/ sso(Casdoor OAuth2 + 本地
                         会话 cookie;SessionStore 接口预留持久化)
  gateway/               多用户网关:静态托管 + /grf-api 按用户路由(身份 →
                         懒拉起用户进程 → 注入令牌转发)+ auth 端点挂载 + CORS
  browser/               右栏内嵌浏览器面板的原生 webview(macOS 自建
                         WKWebView 子视图/Windows WebView2 重父级子窗),
                         含 Eval/截图与 console/网络捕获钩子(eval.go:
                         macOS 原生 callAsyncJavaScript 回调,Windows
                         void ExecJS + fetch 回报 /grf-eval-report)
plugins/console/         goder-console:智能体驱动界面面板的 MCP 服务(仅绑
                         127.0.0.1,loopback 7450 偏好端口 + 随机令牌;设置页
                         展示名「界面控制」)。工具面 goder_browser_*(右栏
                         浏览器面板:导航/快照 ref 机制/点击输入/console 与
                         网络捕获/截图——快照 JS 移植自 gh grf-browser 插件,
                         合成事件无 isTrusted)、goder_terminal_*(终端面板:
                         新建/输入/增量读缓冲)、goder_ui_*(界面操作经
                         wails 事件 + 前端 shell/console-ui.ts 映射)。
                         含 console-shim 子命令(gh stdio 插件 ↔ HTTP 的行
                         JSON-RPC 转发)与安装器(~/.grf/plugins/goder-console
                         wrapper,自动发现模式直接生效;settings.json 有
                         plugins 键时 upsert 命令项,不破坏自动发现语义)
main.go                  wails v3 桌面入口(仅装配:服务注册、窗口、embed 资源;
                         开头分派 `goder console-shim` 子命令)
internal/desktop/        桌面 wails 服务薄壳(AppConfig/ServerManager/
                         ModelConfig/Desktop/TerminalManager/BrowserManager/
                         ConsoleMCP + rootHandler /grf-api 反代与 /grf-api/token
                         冷启动端点;引用 internal/appcfg、internal/ghserver)
cmd/grf-web-serve/       多用户网关 CLI(GRF_IDENTITY=single|header|sso)
frontend/src/
  core/    无 UI 核心层:api(ORS 客户端 fetch+SSE+看门狗)/ model(会话运行
           时模型)/ store(emitter 响应式基座、scope 编排、persistence、
           automation 操作员 system_prompt 与 <grf-task> 任务块解析)/
           settings(设置状态)
  registry/ UI 注册表:nav(左栏导航)/ side(右栏 tab)/ bottom(底栏 tab)
           三区条目 —— 内置与三方自定义同一条 add/remove/hide/show API
  panels/  按功能分组:chat(chat-panel/messages/status-pop(含自动化任务
           执行入口)/composer/工具卡/ask/审批/任务卡)、sessions
           (session-list,桌面态含「自动化」操作员类别)、files(file-list/
           file-view)、inspector(session-detail/review/browser)、console、
           terminal(仅桌面入口注册,含 xterm)、settings(settings-nav/page)
  shell/   app-shell 布局(registry 驱动)+ builtin-common / builtin-desktop
           (内置条目注册:模块加载即注册,幂等)
  ui/      GrfPanel 基类(panel.ts,同时转出 theme)+ theme.ts(--grf-* 令牌)
  host/    wails 宿主桥(纯 web 态 no-op 回退)
  entries/ desktop.ts(桌面入口,注册桌面条目)/ embed.ts(嵌入库入口)
```

依赖方向:panels/shell → registry/core;core 不依赖 UI;桌面专属能力只经
`host/bridge.ts` 进出。Go 侧桌面壳与网关只做参数装配,进程/反代/身份逻辑
一律在 internal。

## 硬性约束(改代码前必读)

- **双形态不变量**:同一份前端代码同时跑在 wails 桌面、三方嵌入页与
  grf-web-serve 静态页。`@wailsio/runtime` 只能动态 import(嵌入产物不含它,
  `vite.embed.config.ts` 已 external);一切 wails 调用收敛在
  `frontend/src/host/bridge.ts`,纯 web 态必须 no-op 回退。
- 桌面态检测用 `inWails()`(协议/hostname + 真实调用探针),不能只看
  `window._wails`(浏览器懒加载 runtime 后也会置位)。
- **registry 不变量**:界面三区(左导航/右栏/底栏)的条目一律经
  `registry/registry.ts` 注册;新内置面板 = builtin-common(通用)或
  builtin-desktop(桌面专属,visible 守卫 `ctx.desktop`)加条目,
  不许在 chat-panel/app-shell 里硬编码新面板类型。桌面专属模块
  (terminal/review/file-view)只能被 entries/desktop.ts 或
  builtin-desktop 引用,嵌入产物不得包含。
- 嵌入库保持零外部依赖、shadow DOM 样式自隔离;换肤只经 `--grf-*` CSS 变量。
- gh server 无 CORS 头:浏览器端一律走同源 `/grf-api`(桌面反代或网关),
  不要直连;web 形态默认 baseUrl 为同源 `/grf-api`(scope.ts 的
  locationDefaultBase)。
- **多用户网关令牌边界**:用户级 gh 令牌由网关/桌面代理注入,不下发浏览器;
  api client 的 Authorization 仅在配置了 token 时携带。
- header 身份模式信任请求头:只可用于可信上级反代之后(内网),文档已
  注明;改动 identity/gateway 时保持该约束的说明同步。
- `internal/ghserver/proxy.go`:WKWebView 自定义 scheme 请求不带
  Content-Length,转发前必须整体缓冲 body 并补齐长度(Go#16036),
  否则 POST body 丢失。
- **goder-console 接入不变量**:gh 的 plugins 配置「settings.json 无
  plugins 键 = 自动发现 ~/.grf/plugins」语义不可破坏 —— 给 gh 注册
  goder-console 一律走 plugins/console 包的 Install(wrapper/命令项),不要写
  URL 条目(那会把 gh 切到显式列表模式、杀死自动发现)。wrapper 与
  settings 里的端点/令牌由启动期 Install 烙写,端口令牌持久化在
  appcfg 目录 console-mcp.json;goder-console 在 builtinPlugins 里
  不可删。工具命名带 `goder_` 前缀,避免与 grf-browser 插件的
  `browser_*` 撞名(gh 对重名工具取先连者并告警)。浏览器面板求值
  的平台机制(macOS callAsyncJavaScript 回调 / Windows fetch 回报)
  见 internal/browser/eval.go 头注释,改信封格式两边同步。
- 桌面 wails 服务(`internal/desktop/` 下 `appconfig.go`/`servermanager.go`/
  `desktop.go`/`modelconfig.go`/`terminal.go`)的 DTO 与
  `frontend/src/host/bridge.ts` 手工对齐,两边同改保持同步;wails
  `Call.ByName` 按完整包路径 FQN(`bridge.ts` 的 SVC 常量)匹配,挪包时
  两边同步;AppConfig/ServerManager 是薄壳,逻辑改动应落在
  internal/appcfg、internal/ghserver。
- 前端 web 默认 baseUrl、桌面 bootstrap 顺序(先同源代理再补 token)与
  `/grf-api/token` 端点是冷启动链路的一部分,改动需回归桌面+web 两形态。
- **自动化操作员不变量**:操作员 = ProjectsIndex 里 `kind:'operator'` 的
  项目(桌面态经 `Desktop.EnsureHomeDir` 在 `~/<名>` 建工作区目录,
  「自动化」左栏类别仅桌面态显示);其会话首条消息由 scope 注入
  `core/store/automation.ts` 的 system_prompt(记忆用 gh 内置 memory
  工具,project 级落工作区 `.grf/memory.json`),任务沉淀协议
  `<grf-task>` 块同样在 automation.ts 解析、由 chat 任务卡保存进
  `index.automation`(migrateIndex 必须保留该字段,漏拷 web 态重载即
  清空);执行入口在 status-pop,点击即在该操作员下新建 run 变体会话。

## 运行时环境

- 托管模式需 `gh` 可执行文件在 PATH(偏好设置可指定绝对路径);桌面默认
  `gh server -addr 127.0.0.1:7400 -data ~/Library/Application Support/goder/server-data`
- 桌面配置与项目索引存 `~/Library/Application Support/goder/`
  (`index-<scope>.json`);纯 web 态项目索引存 localStorage;网关多用户
  数据在 `GRF_DATA/users/<uid>/server-data`(端口池默认 17400-18400)
- goder-console MCP 仅绑 127.0.0.1(偏好端口 7450,被占随机回退并
  回写 appcfg 目录 console-mcp.json;随机令牌同存,跨启动稳定)
- 模型配置沿用 `~/.grf/settings.json`(GRF_HOME 可重定位)
- 版本:Go 1.26 / wails v3.0.0-beta.19 / lit 3 / vite 7 / TS 5.9 strict

## 约定与文档

- 仓库内注释与文档均用中文,保持一致。
- 改嵌入/对外 API 前先读 `docs/embedding.md`;功能对照与已知限制见
  `README.md`。SSO/身份职责边界表在 embedding.md 第 5 节。
- 本目录是 git 仓库;未经用户明确要求不做提交/推送,重构大改动保持
  工作区可审阅(文件移动用 git mv 保留历史)。
