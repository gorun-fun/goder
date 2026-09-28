# Goder

[grf-harness](https://git.gorun.fun/share/grf-harness)(gh)的 ZCode(Zode)风格图形界面。一个前端,多种形态:

| 形态 | 说明 | 入口 |
|------|------|------|
| **桌面 App**(wails v3) | 可直接安装的本地应用:左边项目级会话列表、中间聊天、右栏 tab 化(详情/审查/终端/浏览器/文件)、底栏内嵌终端(进入当前项目目录);自动托管 `gh server` 子进程 | `./build.sh app` → `dist/goder.app` |
| **三方 Web 集成** | 会话列表 / 聊天 / 详情 / 审查 / 浏览器 / 事件台等均为独立 web components,可嵌入任意第三方页面;左栏导航、右栏 tab、底栏 tab 全部经 registry 注册表装配(条目可按 scope 归属),内置条目与三方自定义条目走同一条 API;消息内容层开放定制(registry.chat:自定义消息渲染器、工具展示元数据、markdown 渲染覆写);发送钩子(onBeforeSend)与工具审批钩子(onApproval)可接管出站消息与审批决策;i18n 文案覆盖;`GRF_UI_VERSION` 版本常量 + 完整 .d.ts 类型产物 | `frontend/dist-embed/grf-ui.js` + `types/`(ESM,零外部依赖) |
| **多用户 Web 网关** | `cmd/grf-web-serve`:静态托管 + `/grf-api` 多用户路由 —— **一个登录用户一个独立 gh server 进程**(独立端口与数据目录,令牌由网关注入,不下发浏览器) | `./build.sh web` |

与 gh 的对接完全走 `gh server`(ORS 兼容 Responses API):SSE 流式、
ask_user_question / 工具审批的**暂停-应答链式续交**、多会话、跨重启恢复。
浏览器一律经同源 `/grf-api` 访问(桌面 app 内置反代或 grf-web-serve 网关,
规避 gh server 无 CORS 头的问题)。

```
┌─────────────┬──────────────────────────────┬────────────┐
│ 项目         │  会话名     [空闲] 终端 右栏  │ 详情 审查 +│
│ ├ 演示项目   │  ┌────────────────────────┐  │  概览/用量  │
│ │  · 会话 A  │  │ 你:用 bash …            │  │  工具时间线 │
│ │  ● 会话 B  │  │ ▸ bash ✓ ls -la         │  │  (终端/浏览 │
│ ├ 未分组     │  │ 助手:输出是 …            │  │   器为 tab)│
│ └─ + 新建    │  └────────────────────────┘  │            │
│ ●已连接 ⚙   │  [ 输入框            发送 ]   │            │
├─────────────┴──────────────────────────────┴────────────┤
│ wenjun@mac grf-proj-test % …        (内嵌终端,可拖高度) │
└──────────────────────────────────────────────────────────┘
● 会话 B 前的蓝点 = 有未查看的完成回合(点击会话即消除);
  运行中的会话显示旋转小圆环,空闲不显示。
```

## 快速开始

```sh
./build.sh          # 前端 + 桌面二进制 ./goder
./build.sh app      # 组装 dist/goder.app(macOS)
./build.sh embed    # 仅构建三方嵌入库
./build.sh web      # 纯 web 形态(静态 + 多用户网关,联调用)
```

前置:`gh` 可执行文件在 PATH(桌面托管模式与网关自管模式用它拉起
`gh server`;也可配置指定绝对路径),模型配置沿用 `~/.grf/settings.json`
(`gh model` 配置的那份)。

### 桌面 App

- 首启默认**托管模式**:app 启动即自行拉起 `gh server -addr 127.0.0.1:7400
  -data ~/Library/Application Support/goder/server-data`(前端经
  app 内同源代理 `/grf-api` 连接;**令牌由代理注入**,浏览器侧不持有);
  退出时回收子进程
- **新建项目 = 本地目录**:点击左栏"新建项目"弹出系统目录选择器,项目名
  取目录名,路径入项目档案(悬停可见);项目行提供"在文件管理器中打开"
  (Finder / 资源管理器)。纯 web 态无原生选择器,仍为内联输入项目名
- **右栏 tab 系统**:默认居中显示可打开的面板类型(详情 / 审查 / 终端 /
  浏览器 / 文件 / 事件台),点击打开为顶部 tab,tab 栏末尾"+"可继续添加;
  各 tab 有默认宽度,左缘可拖拽调整。其中:
  - **审查**:读取当前项目目录的 git 状态(分支/领先落后/已暂存/未暂存/
    未跟踪分组),点文件行内展开 diff(10s 自动轮询)
  - **终端**:右栏内嵌交互终端(与底栏各自独立的 PTY 会话)
  - **浏览器**:地址栏 + 内嵌 iframe,上次访问按 scope 记忆
  - **事件台**:全部 SSE 事件流日志(嵌入形态代替终端的观测面板)
- **底栏内嵌终端**:头部终端按钮弹出,进入**当前项目目录**的登录 shell
  (xterm.js + Go PTY),高度可拖拽,收起时会话保活。底栏同样支持多 tab,
  且条目来自 registry —— 三方可注册自己的底栏 tab(如日志面板)
- **会话未读标记**:会话条目前蓝点 = 有未查看的完成回合(或等待输入),
  选中会话即消除并持久化;运行中显示旋转小圆环,空闲不显示
- **远程模式**(设置 → 常规里切换):连接任一已运行的 gh server(URL + token)
- **设置页**:左栏底部齿轮进入,遵守"左导航 + 右工作"双面板结构 —— 左栏
  变为设置分区导航(常规 / 外观 / 模型设置),设置内容在工作面板大卡内
  编辑,改动即时生效并自动保存
- 数据:项目索引与会话归属存
  `~/Library/Application Support/goder/index-<scope>.json`;
  会话历史与 workspace 归 gh server 管

### 纯 web 形态(调试 / 部署)

`./build.sh web` 启动 `grf-web-serve`(默认 http://127.0.0.1:7700):
静态托管前端 + `/grf-api` 网关。**默认单用户自管模式**:首次 API 请求懒拉起
一个 gh server(数据目录 `./grf-web-data/users/local/`),浏览器零配置直连
`/grf-api` 即用。

多用户与身份模式经环境变量切换(完整清单见 `cmd/grf-web-serve/main.go`
头部注释与 docs/embedding.md):

```sh
# 单用户 + 直连外部 gh server(不托管进程,浏览器带 token;兼容旧行为)
GRF_IDENTITY=single GRF_UPSTREAM=http://127.0.0.1:7400 ./build.sh web

# 信任上级网关的用户头(被三方应用集成时推荐;一用户一 gh 进程)
GRF_IDENTITY=header GRF_UID_HEADER=X-GRF-UID ADDR=:7700 go run ./cmd/grf-web-serve

# 内置 Casdoor SSO(独立部署的完整方案;/grf-api/auth/* 提供登录流程)
GRF_IDENTITY=sso SSO_ENDPOINT=https://sso.example.com \
  SSO_CLIENT_ID=… SSO_CLIENT_SECRET=… \
  SSO_REDIRECT_URL=https://app.example.com/grf-api/auth/callback \
  go run ./cmd/grf-web-serve
```

多用户托管参数:`GRF_DATA`(数据根)、`GRF_PORT_MIN/MAX`(用户进程端口池,
默认 17400-18400)、`GRF_MAX_USERS`(默认 50)、`GRF_IDLE_TTL`(空闲回收,
默认 30m)、`GRF_BIN`(gh 路径)、`GRF_STATIC_DIR`(静态目录)。

## 功能对照(gh server 能力 → UI 呈现)

| gh server | UI |
|-----------|-----|
| `POST /v1/responses`(SSE) | 流式正文/思考增量渲染,运行中状态、停止按钮 |
| `grf:tool_call.*` 事件 | 工具卡片(状态图标、参数摘要、展开看全量输入/输出、子代理标签) |
| `grf:notice`(todos/goal/plan/phase) | 聊天内通知行 + 右栏 Todo 面板 |
| 暂停协议 `grf:input_required` | ask_user_question 直接在**底部输入框**内展开:输入框变高并列出问题与选项,点选项即确认提交(多选题勾选后提交);工具审批卡片(批准/拒绝+反馈);应答后链式续跑 |
| `GET /v1/conversations*` | 左栏项目级会话列表(服务器为真 + 本地项目索引分组),标题自动取首条消息 |
| 跨重启恢复 | 重选会话自动加载历史;暂停中的会话恢复出待答卡片 |
| 流中断自愈 | 看门狗 + 终态对账(`GET /v1/responses/{id}`),断流后按服务器快照恢复回合状态 |
| `compact` / `cancel` / `DELETE 归档` | 头部与右栏的压缩 / 停止 / 归档操作 |
| 本地 PTY(桌面专属) | 底栏/右栏内嵌终端(xterm.js + creack/pty),工作目录 = 当前项目 |
| 本地 git(桌面专属) | 右栏审查 tab:状态分组 + 行内 diff(经 Desktop 服务执行 git) |

## 三方 Web 集成

构建产物 `frontend/dist-embed/grf-ui.js`(ESM,shadow DOM 样式自隔离)。

**声明式**(面板元素带属性;web 形态默认连同源 `/grf-api` 网关):

```html
<script type="module" src="/grf-ui.js"></script>

<!-- 整套布局,按需开区域:panels 取 sessions,chat,sidebar,console -->
<grf-app-shell scope="crm" panels="chat,sidebar"></grf-app-shell>

<!-- 或自由组合独立面板 -->
<grf-session-list scope="crm" no-connection></grf-session-list>
<grf-chat scope="crm"></grf-chat>
```

**JS 配置 + UI 定制**(连接配置与 registry 注册表,优先于属性):

```js
import { configure, registry, html } from '/grf-ui.js';

configure('crm', { baseUrl: '/grf-api' });      // 同源网关,无需 token
configure('crm', { auth: { loginUrl: '/grf-api/auth/login' } }); // SSO 网关(可选)

registry.side.hide('console');                  // 裁剪内置右栏条目
registry.nav.add({ id: 'help', label: '帮助', view: () => html`…` });   // 自定义左栏导航
registry.side.add({ id: 'metrics', label: '指标', icon, render: (ctx) => html`…` }); // 自定义右栏 tab
registry.bottom.add({ id: 'logs', label: '日志', icon, create: (ctx) => el });       // 自定义底栏 tab
registry.chat.addRenderer({ id: 'mytool', toolName: 'mcp__mine__q', render: … });     // 接管自家工具的消息卡片
configure('app', {                                                                   // 发送/审批钩子 + i18n + markdown 覆写
  onBeforeSend: (p) => banned(p.text) ? null : p,   // null 取消(输入保留)
  onApproval: (req) => (req.toolName === 'bash' ? null : { approved: true }),
  locale: 'en', messages: { '新会话': 'New chat' },
});
```

要点:

- **scope**:同 scope 的面板共享数据域(会话选择、事件流、控制台);
  不同 scope 互不干扰,可一页多实例
- **registry**:左栏导航(nav)/右栏 tab(side)/底栏 tab(bottom)三个区域,
  内置条目(会话/设置/详情/审查/终端/浏览器/文件/事件台)与三方条目同一
  API(`add/remove/hide/show`),注册即生效;自定义条目的渲染函数拿到
  PanelContext(scope 数据域、当前会话、桌面态标记)
- **主题**:`--grf-*` CSS 变量在页面 `:root` 覆写即可换肤;
  面板自适应容器尺寸
- **鉴权**:多用户网关下令牌由服务端注入,浏览器不持有;未登录(401)时
  可经 `configure(scope, { auth })` 配置跳转登录或回调宿主
- 本仓库自带演示页 `frontend/embed-demo.html`(`./build.sh web` 后访问
  `/embed-demo.html`,含 registry 定制示例;`?panels=free` 切换自由组合形态)

完整接入说明(身份模式选择、SSO 职责边界、安全注意事项)见
[docs/embedding.md](docs/embedding.md)。

## 结构

```
pkg/                     Go 公开层(三方 Go module 可 import 的基座面)
  ghserver/              gh server 进程管理:Proc(单进程生命周期)+ Manager
                         (uid → 进程注册表:端口池、懒启动、空闲回收、崩溃
                         重启冷却)+ 反代核心(按上游缓存复用/注入令牌/SSE
                         flush/body 补长/请求体上限)+ 类型化错误
  identity/              用户身份解析:single / header(被集成)/ sso(Casdoor,
                         会话可文件持久化)
  gateway/               多用户 web 网关:静态托管 + /grf-api 按用户路由 +
                         auth + CORS(通配/白名单)+ /healthz/ready +
                         /admin/* 管理 API + webhook + 请求日志
internal/                Go 桌面专属层
  appcfg/                桌面配置与项目索引的文件持久化(原子写)
  desktop/ browser/      wails 服务薄壳、右栏内嵌浏览器原生实现
main.go / *.go           wails v3 桌面入口(服务注册/窗口/embed 资源)
cmd/grf-web-serve/       多用户网关 CLI(环境变量驱动三种身份模式)
frontend/src/
  core/                  无 UI 的核心层:api(ORS 客户端+SSE+超时)、model
                         (会话运行时)、store(scope 编排/持久化/响应式基座/
                         可注入键值存储/恢复策略/嵌入方运行时策略钩子)、
                         settings(设置状态)、i18n(文案定制通道)
  registry/              UI 注册表:nav/side/bottom/settings 四区条目 +
                         chat 消息内容层(渲染器/工具元数据/markdown 覆写);
                         内置设置分区为 sections/ 目录的分区组件(render
                         返回池化元素,与三方自定义分区同一通道)
  panels/                按功能分组:chat(消息流/composer/状态浮窗)、
                         sessions、files、inspector(详情/审查/浏览器)、
                         console、terminal(仅桌面)、settings(nav/page
                         壳层 + sections/ 六分区组件)、updater
                         (桌面自动更新 UI:左栏「更新」入口 + 更新对话框)
  shell/                 app-shell 布局 + side/bottom dock(通用布局容器,
                         从 chat 面板剥离)+ 内置条目注册
  ui/                    GrfPanel 基类与 --grf-* 主题令牌
  host/                  wails 宿主桥(纯 web 态 no-op 回退)
  entries/               desktop.ts(桌面)/ embed.ts(嵌入库)入口
docs/                    embedding.md(三方集成)· testing.md(E2E)
``````

## 测试

- `cd frontend && npm test`:vitest 单元测试,按模块拆分在 tests/ 下
  (registry 协议/markdown 安全/SSE 归约器/协议块解析/i18n/存储/
  恢复策略/发送管线三层自愈/工具词典与流式容错提取/scope 生命周期);
  Go 侧另有 pkg 基座面单测(ghserver 进程管理/反代/identity/gateway)
  与 bridge FQN 对齐守护(internal/desktop,反射服务方法 vs bridge.ts 引用)
- `cd frontend && npx tsc --noEmit`:类型检查
- `go build ./... && go vet ./...`:Go 侧
- 端到端(真实 gh server + 真实模型):`gh server` 起在 7401 或直接用
  `./build.sh web` 网关(自管模式自动拉起),浏览器驱动 —— 本次重构已做
  全链路验证:网关懒拉起与令牌注入、
  header 多用户隔离、同源连接、真实对话 + 回复渲染、registry 自定义
  导航/右栏条目、设置分区切换。

## 已知限制

- 审批卡片(tool_approval)依赖 gh 会话级审批模式;默认策略
  (auto_approve)下不会出现,ask 表单卡不受影响
- 历史(非本进程)回合的思考过程(reasoning)不在线格式里,恢复历史时
  不回放;工具卡与正文正常回放
- web 形态的项目索引存 localStorage(按源隔离);桌面态存文件
- 内嵌终端依赖 PTY,仅桌面态可用(macOS/Linux 用 pty,Windows 用
  ConPTY);git 审查同理仅桌面态。嵌入形态对应入口自动隐藏;事件台与
  浏览器 tab 在嵌入态可用
- gh(grf-harness)缺失时三平台同一时点自动下载(主窗体创建前的环境
  检查门):Windows 弹原生对话框确认并带进度条,macOS/Linux 静默下载,
  均落用户配置目录 `bin/` 下(来源 download.gorun.fun/grf-harness)。
  macOS .app 正常捆绑 gh(缺失才走下载兜底);Windows/Linux 发行包
  (zip)只含 goder 本体
- Linux 桌面启动:GNOME 文件管理器双击裸可执行文件不执行(按内容类型
  找「打开方式」,`application/x-executable` 无默认应用 → 弹「无法打开
  文件」),正规入口是应用菜单/桌面图标。Linux zip 附 `install.sh`
  (含 .desktop 模板与图标):解压后 `./install.sh` 一次,即装进
  `~/.local/bin` 与应用概览(搜索「Goder」启动);终端运行照旧
- sso 身份模式的本地会话表默认在内存中;设 `GRF_SESSIONS_FILE` 可启用
  文件持久化(重启免重登,单实例定位;分布式部署需自换
  `identity.SessionStore` 实现)
