# AGENTS.md

Goder:grf-harness(gh)的 ZCode 风格图形界面。一个 Lit 前端,多种形态:
wails v3 桌面 App(内置托管 `gh server` 子进程)、可嵌入三方页面的 web components
库(`frontend/dist-embed/goder.js`,ESM、零外部依赖、shadow DOM 自隔离),
以及多用户 web 网关(`cmd/goder-serve`:一个登录用户一个独立 gh server 进程)。

## 常用命令

- `./build.sh` — 前端 + 桌面二进制 `./goder`
- `./build.sh app` — 组装 macOS `dist/goder.app`(adhoc 签名)
- `./build.sh embed` — 仅构建嵌入库 `frontend/dist-embed/goder.js`
- `./build.sh web` — 纯 web 形态(goder-serve 网关:静态 + `/goder-api`,
  http://127.0.0.1:7700;身份模式与多用户参数见 cmd/goder-serve 头注释)
- `./run.sh start|stop|restart` — 桌面 App 生命周期(后台运行,PID/日志在 `.run/`)
- `./goder test-serve [--port 7460]` — 无头测试形态:同一份二进制不建窗口,
  经本地 HTTP 服务器(令牌门槛)把完整桌面 UI 暴露给浏览器,wails 服务
  调用走 `/wails/runtime`、自定义事件经 `/test-serve/events` SSE 回传
  (testserve.go/localserv.go;前端探针 bridge.ts detectDesktopHost)。
  测试指导全文内嵌二进制、经 `/test-serve/guide` 端点分发(docs/
  testing.md 为源,响应头带版本/平台元数据)。AI/发布版 E2E 主战场;
  勿与桌面 App 同时运行(goder-console 烙写互踩)
- 类型检查:`cd frontend && npx tsc --noEmit`;Go:`go build ./... && go vet ./... && gofmt -l pkg cmd internal plugins`(gofmt 须无输出)
- 单元测试:`cd frontend && npm test`(vitest,按模块拆分在 frontend/tests/:
  registry/markdown/chat-model 归约器/automation 协议块/i18n/storage/
  retry-policy/发送管线/工具词典/scope 生命周期/scripted-api 测试装具);
  `go test ./...`(pkg 基座面:ghserver 进程管理与反代、identity、
  gateway;internal/desktop 含 gh 下载与 bridge FQN 对齐守护)
- (自动化测试以 test-serve + 浏览器驱动为主,指导见 `docs/testing.md`;
  人工 E2E 为真实 gh server + 真实模型的手动浏览器验证,playwright-cli
  或浏览器驱动)
- **发版(打版)规则**:推送 tag 触发 GitLab CI(`.gitlab-ci.yml`,
  仅 tag 触发;发布机地址/用户/目录 DEPLOY_HOST/DEPLOY_USER/DEPLOY_DIR
  经 CI/CD 变量注入,内网信息不入库——openos 同套约定)。tag 与产物
  版本号 = gh(grf-harness)最新发布 tag;
  gh 未更新而本程序再次发版时追加 `.postN`(N 从 0 递增,
  推算脚本 `scripts/version.sh`,tag 名应与推算值一致)。
  发版步骤:`sh scripts/version.sh` 得版本 → 先推送 main →
  `git tag v<版本> && git push origin v<版本>`。
  publish 为每个产物随发 `.sha256` 校验文件;下载侧(internal/desktop
  的 verifyDlChecksum)按同目录 `.sha256`/`SHA256SUMS` 校验完整性,
  校验面存在即强制匹配、皆无则跳过(历史已发目录)——改校验约定时
  CI 与客户端两边同步。
  已发版本以下载服务器目录为准(download.gorun.fun/goder);
  受保护 tag 不可移动,误发的 tag 只能另打新 tag 重触发。
- **版本号约定**:形态 `X.Y.Z[-预发布.N][.postM]`,如
  `0.0.1-alpha.14`、`0.0.1-alpha.14.post11`、`0.0.1-beta.1`、`0.0.1`(正式)。
  预发布后缀递进 alpha(内测)< beta(公测)< rc(候选);同基线本程序
  再发版追加 `.postN`(高于该基线,低于下一个 gh 基线);正式版为无后缀
  裸版本号,压过同号全部预发布与 post。排序有三处实现、必须同一套语义:
  桌面端自动更新 `internal/desktop/version.go` 的 `compareVersion`
  (单一实现,包内所有择新排序共用;曾存在第四套语义相反的私有副本导致
  正式版发布后插件仍选 alpha 目录,已删)、
  发版推算 `scripts/version.sh` 的 `ver_max`(awk)、CI 捆绑 gh 下载
  (调 `sh scripts/version.sh gh`)。不要用 `sort -V` 替代:它把正式版排
  在预发布之下且 postN 按字符串比。改比较规则时三处同改,并用矩阵用例
  (内测/公测/候选/正式/postN/跨基线)验证。

## 结构与分层

```
pkg/                     Go 公开层(三方 Go module 可 import 的基座面;
                         桌面壳与 web 网关同一套实现)
  ghserver/              gh server 进程管理:Proc(单进程生命周期:启动/
                         收养/就绪等待/令牌/停止、Unix 管道 + Windows Job
                         看门狗;托管 gh 默认注入 GRF_SERVER_ACCESS_LOG=off
                         ——gh 0.0.1-alpha.29+ 起每请求一行访问日志会灌满
                         server.log 且与 goder 反代视角重复,宿主可经
                         ExtraEnv(GODER_GH_ENV_*)覆盖开启)+
                         Manager(uid → 进程注册表:端口池分配、
                         懒启动、空闲回收、崩溃重启冷却、数量上限、
                         PerUserHome 隔离)+ NewProxy(反代核心:去前缀、
                         注入 Bearer、SSE flush、无 Content-Length body
                         缓冲补齐、请求体上限)+ 类型化错误(errors.go:
                         容量类 429 / 未就绪与冷却 503)+
                         hostadmin/hostsettings(宿主管理面域逻辑:用户
                         目录布局所有权、托管供应商声明 upsert、裸名解析、
                         插件安装、会话索引;openos 类宿主经网关 /admin/*
                         消费,不再直写 goder 私有文件)
  identity/              用户身份解析 Resolver:single(单用户)/ header
                         (信任上级网关用户头,被集成推荐)/ sso(Casdoor
                         OAuth2 + 本地会话 cookie;SessionStore 可注入,
                         file_sessions.go 提供 GODER_SESSIONS_FILE 文件
                         持久化,单实例定位,分布式需自换实现)
  gateway/               多用户 web 网关:静态托管 + /goder-api 按用户路由
                         (身份 → 懒拉起用户进程 → 注入令牌转发)+ auth
                         端点挂载 + CORS(通配/白名单)+ /healthz/ready +
                         /admin/* 管理 API(statuses/start/stop/restart,
                         Bearer AdminToken)+ webhook + 请求日志 +
                         宿主管理面(adminhost.go,声明式集成:供应商声明/
                         managed 注入/裸名解析/插件安装/会话索引/用户目录
                         生命周期,见 embedding.md「宿主管理面」)
internal/                Go 桌面专属层
  appcfg/                桌面配置与项目索引的文件持久化(原子写)
  grfsettings/           gh 配置 settings.json 的读改写事务(互斥串行 +
                         tmp/rename 原子落盘):桌面设置页保存与 goder-console
                         启动烙写共用,杜绝三处手抄与非原子写的并发交错
  desktop/               桌面 wails 服务薄壳(AppConfig/ServerManager/
                         ModelConfig/AgentConfig/Desktop/TerminalManager/
                         BrowserManager/ConsoleMCP/Updater + rootHandler
                         /goder-api 反代与 /goder-api/token 冷启动端点;
                         本地服务敏感路径 Host 白名单 proxy.go 的
                         LoopbackHostGuard(/goder-api* 与 /wails/* 仅放行
                         本机主机名,防 DNS rebinding 借回环服务驱动机器
                         —— wails transport 自身无来源校验;本地服务组装点
                         main.go/testserve.go 包最外层);version.go 版本比较
                         单一实现(三处同步之一,见版本号约定);dlserver.go
                         下载服务器客户端(gh 引导/自更新/插件技能安装共用,
                         落盘前按同目录 .sha256/SHA256SUMS 校验完整性);
                         agentskills.go 技能面;
                         /goder-api/local-file 本地文件只读服务带目录
                         白名单(用户主目录/gh 数据目录/项目索引登记目录,
                         proxy.go 的 localFileAllowed——改允许面时同步);
                         引用 internal/appcfg、internal/grfsettings、
                         pkg/ghserver)
  browser/               右栏内嵌浏览器面板的原生 webview(macOS 自建
                         WKWebView 子视图/Windows WebView2 重父级子窗),
                         含 Eval/截图与 console/网络捕获钩子(eval.go:
                         macOS 原生 callAsyncJavaScript 回调,Windows
                         void ExecJS + fetch 回报 /goder-eval-report)
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
cmd/goder-serve/       多用户网关 CLI(GODER_IDENTITY=single|header|sso;
                         运维 env:GODER_ADMIN_TOKEN/GODER_WEBHOOK_URL/
                         GODER_WEBHOOK_SECRET(事件回调 HMAC 签名)/
                         GODER_GH_ENV_<KEY>(透传环境给 gh 子进程,如
                         GRF_TURN_WEBHOOK_* 回合事件外发、
                         GRF_SERVER_ACCESS_LOG=on 覆盖托管默认的关闭)/
                         GODER_CORS_ORIGINS/GODER_ACCESS_LOG/GODER_SESSIONS_FILE)
frontend/src/
  core/    无 UI 核心层:api(ORS 客户端 fetch+SSE+看门狗+非流式超时;
           fetch.ts 传输层注入 + scripted-api.ts 可编程假后端——接入方
           AI 自动化测试的数据面,经 setApiFetch 装载,指导见
           docs/integration-testing.md、示例页 frontend/test-harness.html;
           agent-dto 为 gh 智能体配置 DTO,桌面桥与网页 agent-api 共用)/
           model(会话运行时模型)/ store(emitter 响应式基座——subscribe
           全量 + subscribeSession 会话定向,流式 delta 只唤醒关注该会话
           的面板、scope 编排(引用计数 acquire/release + 归零延迟回收,
           清轮询定时器防泄漏)、send-pipeline(发送/恢复管线:链尾失配
           自愈 → 工具调用瞬时 400 → 断流退避三层重试与终态对账,
           依赖注入、可独立单测)、persistence、storage(可注入键值存储,
           core 全部 localStorage 落点的统一通道,setKeyValueStorage 整体
           替换)、retry-policy(流恢复策略,可注入)、host-config(嵌入方
           按 scope 注入的运行时策略:sessionDefaults/ungroupedSessions/
           disableDefaultPrompt/onBeforeSend 发送钩子/onApproval 审批钩子)、
           automation 操作员 system_prompt 与 <goder-task> 任务块解析、
           session-prompt 普通会话默认 custom 提示词——gh 系统提示词为
           「custom 段 + inner prompt(内置工具说明,按可用工具恒定拼装)」
           叠加结构,草稿落定时项目 defaults 与操作员提示词均未带
           system_prompt 则注入该默认值(disableDefaultPrompt 可关闭);
           defaults 另可带 default_skill 指定默认技能全文注入,经
           grf:session 透传、同为嵌入方开放通道;grf:session.host_context
           (宿主环境简报)是嵌入方(openos 等)注入运行环境事实的正规通道,
           gh 侧独立拼段、与 system_prompt 叠加,sessionDefaults/
           configure 下发后随新会话逐字段透传)/ settings(设置状态)/
           i18n.ts(gettext 风格文案通道:key 即中文默认文案,嵌入方经
           configure({locale,messages}) 覆盖;GoderPanel.t() 与 core 文案
           均过它,收口持续推进)
  registry/ UI 注册表:nav(左栏导航)/ side(右栏 tab)/ bottom(底栏
           tab)/ settings(设置分区,内置六分区为 panels/settings/
           sections/ 的分区组件,render 返回池化元素)四区条目 +
           chat(消息内容层:ItemRendererDef 按
           kind/工具名接管单条消息渲染、ToolMetaDef 工具展示知识、
           setMarkdownRenderer per-scope markdown 覆写)—— 内置与三方
           自定义同一条 add/remove/hide/show API;条目可带 scopes 字段
           限定只对哪些 scope 可见(同页多实例各装各的)
  panels/  按功能分组:chat(chat-panel——消息流+composer+头部,右栏/
           底栏 dock 已剥离到 shell;messages 渲染管线三层:自定义渲染器
           →内置 kind switch→未知 kind 通用通知卡、status-pop(含自动化任务
           执行入口,configure({statusPop:false}) 可整体隐藏)/composer
           (send 事件 cancelable + onBeforeSend 钩子消费)/工具卡/ask/
           审批/任务卡)、sessions(session-list,桌面态含「自动化」操作员
           类别)、files(file-list/file-view)、inspector(session-detail/
           review/browser)、console、terminal(仅桌面入口注册,含
           xterm)、settings(settings-nav/page 壳层 +
           sections/ 六分区组件)
  shell/   app-shell 布局(registry 驱动;workcard 容器承载卡片视觉,
           中央=自定义 center 或 chat(flat),cols = col-main + side-dock)+
           side-dock.ts(右栏 dock:tab 行+元素池,panelEl 公开取池内元素)/
           bottom-dock.ts(底栏 dock:按会话分组 tab 组)+ builtin-common /
           builtin-desktop(内置条目注册:模块加载即注册,幂等)
  ui/      GoderPanel 基类(panel.ts——scope 订阅+会话定向订阅+fire+t()
           i18n 帮助方法,同时转出 theme)+ theme.ts(--goder-* 令牌)
  host/    wails 宿主桥(纯 web 态 no-op 回退)
  entries/ desktop.ts(桌面入口,注册桌面条目)/ embed.ts(嵌入库入口:
           全部钩子类型导出 + GODER_UI_VERSION 版本常量;构建产出
           dist-embed/goder.js + types/ 的 .d.ts)
```

依赖方向:panels/shell → registry/core;core 不依赖 UI;桌面专属能力只经
`host/bridge.ts` 进出。Go 侧桌面壳(internal/desktop)与网关(cmd/goder-serve)
只做参数装配,进程/反代/身份逻辑一律在 pkg。

## 硬性约束(改代码前必读)

- **双形态不变量**:同一份前端代码同时跑在 wails 桌面、三方嵌入页与
  goder-serve 静态页。`@wailsio/runtime` 只能动态 import(嵌入产物不含它,
  `vite.embed.config.ts` 已 external);一切 wails 调用收敛在
  `frontend/src/host/bridge.ts`,纯 web 态必须 no-op 回退。
- 桌面态检测用 `inWails()`(协议/hostname + 真实调用探针),不能只看
  `window._wails`(浏览器懒加载 runtime 后也会置位)。
- **新增功能必须先做网页形态评估**:同一份代码跑双形态,新功能默认
  桌面/网页都要可用;实现前先评估网页形态(嵌入库 / goder-serve)
  是否有等价通道——密钥、文件系统等桌面专属资源,网页形态往往可经
  gh server `/v1/agent/*` 服务端代理承载。**确有等价通道的必须实现
  网页路径,不得用 `inWails()` 一刀切关闭**;只有确认网页端确实无
  通道(纯桌面原生能力,如终端/浏览器面板)才允许桌面守卫跳过,并在
  守卫处注释注明评估结论与依据。反例:供应商上下文窗口探测曾被
  `!inWails()` 整体跳过,而 gh server 代理通道(`models/detect`)
  实际可承载,导致网页端长期只显示按名估算值。
- **registry 不变量**:界面四个装配区(左导航/右栏/底栏/设置分区)的
  条目一律经 `registry/registry.ts` 注册;新内置面板 = builtin-common
  (通用)或 builtin-desktop(桌面专属,visible 守卫 `ctx.desktop`)加
  条目,不许在 chat-panel/app-shell 里硬编码新面板类型。设置分区同理:
  内置分区在 builtin-common 注册(render 返回 sections/ 分区组件的
  池化元素,sections/index.ts 的 builtinSettingsRender),settings-page
  只做壳层装配与保活,不硬编码分区清单。桌面专属模块
  (terminal/review/file-view)只能被
  entries/desktop.ts 或 builtin-desktop 引用,嵌入产物不得包含。
- 嵌入库保持零外部依赖、shadow DOM 样式自隔离;换肤只经 `--goder-*` CSS 变量。
- **dock 不变量**:右栏/底栏 dock(`shell/side-dock.ts`、`bottom-dock.ts`)
  是壳层通用布局容器,由 app-shell 的 workcard 结构装配;chat-panel 不再
  渲染任何 dock —— 新的面板内容一律经 registry.side/bottom 注册,不许往
  dock 组件里硬编码面板类型。shell 装配的 chat 传 `flat`(卡片视觉由
  workcard 承担);对池内元素的编程访问经 side-dock 的 `panelEl(defId)`
  公开方法,不许跨 shadow DOM 摸内部标签名。
- **消息渲染管线不变量**:messages.ts 的 renderItem 三层分发(自定义渲染
  器(registry.chat,工具名优先于 kind)→ 内置 kind switch → 未知 kind
  通用通知卡兜底);markdown 走 `chatMarkdown(scope, text)`(per-scope
  覆写优先),不得直接 import renderMarkdown 绕过覆写。工具展示名/明细
  先查 registry.chat 的 ToolMetaDef 再落内置词典(fmt.ts)。
- **core 持久化与策略注入不变量**:core 的一切 localStorage 读写必须经
  `core/store/storage.ts` 的 KeyValueStorage(嵌入方可整体替换),不许
  再新增裸 localStorage 调用;JSON 类读写统一走同文件的 kvGet/kvSet/
  kvDel 容错帮助函数;连接副本默认不落 token(`persistToken: true`
  显式开启,桌面入口已开)。嵌入方运行时策略(发送/审批钩子等)一律经
  `core/store/host-config.ts` 按 scope 注入;流恢复参数经 retry-policy.ts。
  automation 的 goder-auto 技能正文经 vite define(`__GODER_AUTO_SKILL_MD__`,
  两个 vite 配置同源读 internal/desktop/agentskills/goder-auto.md)注入,
  core 不跨树 ?raw 引 Go 源码 —— core 目录保持可整体拷出独立成包。
- gh server 无 CORS 头:浏览器端一律走同源 `/goder-api`(桌面反代或网关),
  不要直连;web 形态默认 baseUrl 为同源 `/goder-api`(scope.ts 的
  locationDefaultBase)。
- **多用户网关令牌边界**:用户级 gh 令牌由网关/桌面代理注入,不下发浏览器;
  api client 的 Authorization 仅在配置了 token 时携带。
- header 身份模式信任请求头:只可用于可信上级反代之后(内网),文档已
  注明;改动 identity/gateway 时保持该约束的说明同步。
- `pkg/ghserver/proxy.go`:WKWebView 自定义 scheme 请求不带
  Content-Length,转发前必须整体缓冲 body 并补齐长度(Go#16036),
  否则 POST body 丢失。
- **goder-console 接入不变量**:gh 的 plugins 配置「settings.json 无
  plugins 键 = 自动发现 ~/.grf/plugins」语义不可破坏 —— 给 gh 注册
  goder-console 一律走 plugins/console 包的 Install(wrapper/命令项),不要写
  URL 条目(那会把 gh 切到显式列表模式、杀死自动发现)。wrapper 内嵌
  端点与 GODER_CONSOLE_TOKEN 环境变量(令牌不进 argv:进程参数对本机
  ps 可见);显式列表命令项只带 [exe, console-shim, endpoint],shim
  回读 console-mcp.json 取令牌,argv 旧形态(shimToken)保留兼容升级
  窗口。端口令牌持久化在
  appcfg 目录 console-mcp.json;goder-console 在 builtinPlugins 里
  不可删。工具命名带 `goder_` 前缀,避免与 grf-browser 插件的
  `browser_*` 撞名(gh 对重名工具取先连者并告警);全部工具的中文
  展示名在前端 `shell/console-ui.ts` 与接线同源注册
  (registry.chat.addToolMeta,Go 侧工具注册文件 tools_browser.go/
  tools_terminal.go/tools_ui.go 增改工具时两边同步)。
  浏览器面板求值的平台机制(macOS callAsyncJavaScript 回调 /
  Windows fetch 回报)见 internal/browser/eval.go 头注释,改信封
  格式两边同步。
- 桌面 wails 服务(`internal/desktop/` 下 `appconfig.go`/`servermanager.go`/
  `desktop.go`/`modelconfig.go`/`terminal.go`)的 DTO 与
  `frontend/src/host/bridge.ts` 手工对齐,两边同改保持同步;wails
  `Call.ByName` 按完整包路径 FQN(`bridge.ts` 的 SVC 常量)匹配,挪包时
  两边同步 —— FQN 失配有机械护栏:`go test ./internal/desktop/` 的
  `bridge_fqn_test.go` 反射服务方法集与 bridge.ts 引用比对,挪包/改名
  先红;AppConfig/ServerManager 是薄壳,逻辑改动应落在
  internal/appcfg、pkg/ghserver。
- 前端 web 默认 baseUrl、桌面 bootstrap 顺序(先同源代理再补 token)与
  `/goder-api/token` 端点是冷启动链路的一部分,改动需回归桌面+web 两形态。
- **自动化操作员不变量**:操作员 = ProjectsIndex 里 `kind:'operator'` 的
  项目(桌面态经 `Desktop.EnsureHomeDir` 在 `~/<名>` 建工作区目录,
  「自动化」左栏类别仅桌面态显示);其会话首条消息由 scope 注入
  `core/store/automation.ts` 的 system_prompt(记忆用 gh 内置 memory
  工具,project 级落工作区 `.grf/memory.json`),任务沉淀协议
  `<goder-task>` 块同样在 automation.ts 解析、由 chat 任务卡保存进
  `index.automation`(migrateIndex 必须保留该字段,漏拷 web 态重载即
  清空);执行入口在 status-pop,点击即在该操作员下新建 run 变体会话。
  执行会话(run 变体)成功跑通后按 runnerSystemPrompt 的指引输出
  `<goder-skill>` 块沉淀技能(automation.ts 解析、chat/skill-card.ts 渲染
  保存卡),保存走 host/bridge 的 saveSkill 落盘 `~/.grf/skills/<名>/
  SKILL.md`,仅桌面态可写、web 态卡片禁用保存。
  内置技能 goder-auto(自动化任务创作指南,指导用户完成操作并沉淀为
  可点击执行的指令)的正文单一源文件在
  `internal/desktop/agentskills/goder-auto.md`:Go 侧 go:embed 由
  AgentConfig.ServiceStartup 幂等烙写 `~/.grf/skills/goder-auto`
  (内容不一致才写;用户已禁用则尊重;内置技能不可删/编辑),前端经
  两个 vite 配置的 define 常量 `__GODER_AUTO_SKILL_MD__`(构建时读同一
  文件)把全文注入操作员 system_prompt(创建自动化会话即自动加载)——
  改指南只改这一份;core 不再跨树 ?raw 引 Go 源码。

## 运行时环境

- 托管模式需 `gh` 可执行文件在 PATH(偏好设置可指定绝对路径);桌面默认
  `gh server -addr 127.0.0.1:7400 -data ~/Library/Application Support/goder/server-data`
- 桌面配置与项目索引存 `~/Library/Application Support/goder/`
  (`index-<scope>.json`);纯 web 态项目索引存 localStorage;网关多用户
  数据在 `GODER_DATA/users/<uid>/server-data`(端口池默认 17400-18400)
- goder-console MCP 仅绑 127.0.0.1(偏好端口 7450,被占随机回退并
  回写 appcfg 目录 console-mcp.json;随机令牌同存,跨启动稳定)
- 模型配置沿用 `~/.grf/settings.json`(GRF_HOME 可重定位)
- 版本:Go 1.26 / wails v3.0.0-beta.19 / lit 3 / vite 7 / TS 5.9 strict

## 约定与文档

- 仓库内注释与文档均用中文,保持一致。
- 文档组织(openos 同套约定):`README.md` 是面向人的门面(形态/快速
  开始/特性速览/配置与安全要点),深度内容在 `docs/` 专题文档 +
  `docs/README.md` 索引——desktop.md(桌面指南与已知限制)/ deploy.md
  (部署、环境变量全表与生产清单)/ security.md(安全模型)/
  embedding.md(三方集成)/ testing.md(E2E)/ integration-testing.md
  (scripted-api 数据面)。改对应区域时同步对应文档;安全面改动(令牌
  边界/Host 守卫/下载校验/管理面权限等)必须同步 security.md。
- **文档双语约定**:中文为默认版(`README.md`、`docs/*.md`),英文版
  同名加 `.en.md` 后缀(`README.en.md`、`docs/*.en.md`),两版顶部互链。
  **修改任一版本的实质内容(结构、参数、行为描述、安全边界)必须同步
  另一版本**——同改一次提交,不允许只改一边;纯文案润色与排版可单边。
  代码块内注释随所在文档语言;专有名词(gh/grf-harness/goder-console
  /wails 等)与 i18n 示例 key(中文文案 key 本身)不翻译。
- 改嵌入/对外 API 前先读 `docs/embedding.md`。SSO/身份职责边界表在
  embedding.md 第 5 节。
- 本目录是 git 仓库;未经用户明确要求不做提交/推送,重构大改动保持
  工作区可审阅(文件移动用 git mv 保留历史)。
