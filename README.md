# grf-harness-ui

[grf-harness](https://git.gorun.fun/share/grf-harness)(gh)的 ZCode(Zode)风格图形界面。一个前端,两种形态:

| 形态 | 说明 | 入口 |
|------|------|------|
| **桌面 App**(wails v3) | 可直接安装的本地应用:左边项目级会话列表、中间聊天、右栏 tab 化(详情/审查/终端/浏览器)、底栏内嵌终端(进入当前项目目录);自动托管 `gh server` 子进程 | `./build.sh app` → `dist/grf-harness-ui.app` |
| **三方 Web 集成** | 会话列表 / 聊天 / 详情 / 审查 / 浏览器 / 事件台等均为独立 web components,可嵌入任意第三方页面,像裸 grf-harness 配置工具面一样按需开启 UI 的哪些部分 | `frontend/dist-embed/grf-ui.js`(ESM,零外部依赖) |

与 gh 的对接完全走 `gh server`(ORS 兼容 Responses API):SSE 流式、
ask_user_question / 工具审批的**暂停-应答链式续交**、多会话、跨重启恢复。
纯 web 形态另附 `grf-web-serve`(静态托管 + 带 CORS 的 `/grf-api` 反代),
桌面形态由 wails app 内置同源反代(规避 gh server 无 CORS 头的问题)。

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
./build.sh          # 前端 + 桌面二进制 ./grf-harness-ui
./build.sh app      # 组装 dist/grf-harness-ui.app(macOS)
./build.sh embed    # 仅构建三方嵌入库
./build.sh web      # 纯 web 形态(静态 + 代理,联调用)
```

前置:`gh` 可执行文件在 PATH(桌面托管模式用它拉起 `gh server`;
也可在设置的"常规"分区里指定绝对路径),模型配置沿用 `~/.grf/settings.json`
(`gh model` 配置的那份)。

### 桌面 App

- 首启默认**托管模式**:app 启动即自行拉起 `gh server -addr 127.0.0.1:7400
  -data ~/Library/Application Support/grf-harness-ui/server-data`(前端经
  app 内同源代理 `/grf-api` 与 `/grf-api/token` 冷启动连接,零 CORS/时序
  依赖);退出时回收子进程
- **新建项目 = 本地目录**:点击左栏"新建项目"弹出系统目录选择器,项目名
  取目录名,路径入项目档案(悬停可见);项目行提供"在文件管理器中打开"
  (Finder / 资源管理器)。纯 web 态无原生选择器,仍为内联输入项目名
- **右栏 tab 系统**:默认居中显示可打开的面板类型(详情 / 审查 / 终端 /
  浏览器),点击打开为顶部 tab,tab 栏末尾"+"可继续添加;各 tab 有默认
  宽度,左缘可拖拽调整。其中:
  - **审查**:读取当前项目目录的 git 状态(分支/领先落后/已暂存/未暂存/
    未跟踪分组),点文件行内展开 diff(10s 自动轮询)
  - **终端**:右栏内嵌交互终端(与底栏各自独立的 PTY 会话)
  - **浏览器**:地址栏 + 内嵌 iframe,上次访问按 scope 记忆
- **底栏内嵌终端**:头部终端按钮弹出,进入**当前项目目录**的登录 shell
  (xterm.js + Go PTY),高度可拖拽,收起时会话保活。底栏只占聊天列宽度
  (右栏优先级更高,同时打开时直通卡片底部),支持**多终端 tab**:每个
  tab 悬停显示自己的 × 关闭;标题行最右侧"+"新建终端、"×"收起整个底栏
  (收起再展开恢复原 tab 状态)
- **会话未读标记**:会话条目前蓝点 = 有未查看的完成回合(或等待输入),
  选中会话即消除并持久化;运行中显示旋转小圆环,空闲不显示
- **远程模式**(设置 → 常规里切换):连接任一已运行的 gh server(URL + token)
- **设置页**:左栏底部齿轮进入,遵守"左导航 + 右工作"双面板结构 —— 左栏
  变为设置分区导航(常规 / 外观 / 模型设置),设置内容在工作面板大卡内
  编辑,改动即时生效并自动保存(常规:服务模式 / gh 路径 / 监听地址;
  外观:主题深浅 / 强调色 / 界面字号;模型设置:默认模型。外观镜像
  localStorage,重启即恢复)
- 数据:项目索引与会话归属存
  `~/Library/Application Support/grf-harness-ui/index-<scope>.json`;
  会话历史与 workspace 归 gh server 管

### 纯浏览器打开(调试)

```sh
./build.sh web              # http://127.0.0.1:7700
# 设置 → 常规:gh server 地址(如 http://127.0.0.1:7700/grf-api)+ token
```

也可以直接 `gh server` 后用任意静态服务器 + 自己的反代;
`grf-web-serve` 就是这样一个参考实现(见 `cmd/grf-web-serve/main.go`)。

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

构建产物 `frontend/dist-embed/grf-ui.js`(ESM,shadow DOM 样式自隔离,
gzip ≈ 36KB)。两种用法:

**声明式**(面板元素带 `server` / `token` 属性):

```html
<script type="module" src="/grf-ui.js"></script>

<!-- 整套布局,按需开面板:panels 取 sessions,chat,sidebar,console -->
<grf-app-shell scope="crm" panels="chat,sidebar"
               server="https://gh.example.com" token="…"></grf-app-shell>

<!-- 或自由组合独立面板 -->
<grf-session-list scope="crm" no-connection></grf-session-list>
<grf-chat scope="crm"></grf-chat>
<grf-console scope="crm"></grf-console>
```

**JS 配置**(优先于属性):

```js
import { configure } from '/grf-ui.js';
configure('crm', { baseUrl: 'https://gh.example.com', token: '…', model: 'deepseek/deepseek-chat' });
```

要点:

- **scope**:同 scope 的面板共享数据域(会话选择、事件流、控制台);
  不同 scope 互不干扰,可一页多实例
- **主题**:`--grf-*` CSS 变量在页面 `:root` 覆写即可换肤;
  面板自适应容器尺寸
- **CORS**:gh server 不带 CORS 头。同源部署(网关反代 `/grf-api`,
  参照 `cmd/grf-web-serve`)或自行加 CORS;桌面态无需关心(app 内置同源代理)
- 本仓库自带演示页 `frontend/embed-demo.html`(`./build.sh web` 后访问
  `/embed-demo.html?server=…&token=…`)

完整接入说明见 [docs/embedding.md](docs/embedding.md)。

## 结构

```
main.go / appconfig.go / servermanager.go / proxy.go
                      wails v3 桌面壳:服务(配置持久化、gh server 托管)、
                      /grf-api 同源反代、资源嵌入
terminal.go           TerminalManager:内嵌终端 PTY 会话(输出经 wails 事件推送)
desktop.go            Desktop:目录选择/Reveal/git 状态与 diff(审查面板用)
cmd/grf-web-serve/   纯 web 形态:静态 + CORS 反代(联调/参考实现)
frontend/
  src/api/           ORS 客户端(fetch + SSE 解析 + 断流看门狗)
  src/state/         scope 编排:项目索引、会话运行时(含未读基线)、
                     事件归一、自愈对账
  src/panels/        grf-session-list / grf-chat(消息流/工具卡/ask 表单/
                     审批卡/composer/右栏 tab)/ grf-sidebar / grf-review /
                     grf-browser / grf-terminal(仅桌面注册)/ grf-console
  src/shell/         grf-app-shell(ZCode 风格三栏可展开布局)
  src/embed/         嵌入库入口;src/main.ts 桌面入口
docs/                embedding.md(三方集成)
gui-test-screenshots/ 端到端验证截图
```

## 测试

- `cd frontend && npx tsc --noEmit`:类型检查
- 端到端(真实 gh server + 真实模型):`gh server` 起在 7401,
  `./build.sh web` 起在 7700,浏览器驱动——本项目开发过程中已做全链路
  验证(见 `gui-test-screenshots/`):连接配置、项目/会话管理、
  真实对话 + 工具卡、ask 暂停-应答-续跑、断页重载后暂停卡片恢复、
  嵌入页、桌面 App 托管拉起 gh server。

## 已知限制

- 审批卡片(tool_approval)依赖 gh 会话级审批模式;默认策略
  (auto_approve)下不会出现,ask 表单卡不受影响
- 历史(非本进程)回合的思考过程(reasoning)不在线格式里,恢复历史时
  不回放;工具卡与正文正常回放
- web 形态的项目索引存 localStorage(按源隔离);桌面态存文件
- 内嵌终端依赖 PTY,仅桌面态可用(Windows 暂不支持);嵌入形态自动
  隐藏终端入口。git 审查同理仅桌面态;事件台(grf-console)已从应用
  布局移除,仅作为独立嵌入面板保留
