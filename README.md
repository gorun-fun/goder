# Goder

**中文(默认)** · [English](README.en.md)

[grf-harness](https://git.gorun.fun/share/grf-harness)(gh)的 ZCode 风格图形界面:
一个前端,三种形态——本地桌面 App、可嵌入任意网页的 web components 库、
多用户 web 网关。AI 会话、工具调用、项目终端、git 审查、内嵌浏览器在
同一张工作台里;与 gh 的对接完全走 `gh server`(ORS 兼容 Responses API)。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) ![Go](https://img.shields.io/badge/Go-1.26-00ADD8) ![Lit](https://img.shields.io/badge/Lit-3-324fff) ![wails](https://img.shields.io/badge/wails-v3%20beta-00b8c8)

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
│ wenjun@mac goder-proj-test % …        (内嵌终端,可拖高度) │
└──────────────────────────────────────────────────────────┘
● 会话 B 前的蓝点 = 有未查看的完成回合(点击会话即消除);
  运行中的会话显示旋转小圆环,空闲不显示。
```

## 目录

- [三种形态](#三种形态)
- [快速开始](#快速开始)
- [核心特性](#核心特性)
- [配置参考](#配置参考)
- [安全](#安全)
- [项目结构](#项目结构)
- [参与开发](#参与开发)

深入指南见 [`docs/`](docs/README.md):[桌面 App](docs/desktop.md) · [部署](docs/deploy.md) · [安全说明](docs/security.md) · [三方 Web 集成](docs/embedding.md) · [自动化测试](docs/testing.md) · [集成测试数据面](docs/integration-testing.md)

## 三种形态

| 形态 | 说明 | 入口 |
|------|------|------|
| **桌面 App**(wails v3) | 可直接安装的本地应用:项目级会话列表 + 聊天 + 右栏 tab(详情/审查/终端/浏览器/文件/事件台)+ 底栏项目终端;自动托管 `gh server` 子进程 | `./build.sh app` → `dist/goder.app` |
| **三方 Web 集成** | 会话/聊天/详情等均为独立 web components,嵌入任意页面;左栏导航、右栏/底栏 tab、消息渲染层全部经 registry 注册表定制;发送与审批钩子可接管出站与决策;i18n 文案覆盖 | `frontend/dist-embed/goder.js`(ESM,零外部依赖) |
| **多用户 Web 网关** | `cmd/goder-serve`:静态托管 + `/goder-api` 多用户路由——**一个登录用户一个独立 gh server 进程**(独立端口与数据目录,令牌由网关注入,不下发浏览器) | `./build.sh web` |

## 快速开始

```sh
./build.sh          # 前端 + 桌面二进制 ./goder
./build.sh app      # 组装 dist/goder.app(macOS)
./build.sh embed    # 仅构建三方嵌入库
./build.sh web      # 纯 web 形态(http://127.0.0.1:7700,联调/部署)
```

**桌面**:首启即用——默认托管模式自动拉起 gh server(缺失时自动下载),
新建项目选本地目录即可对话。完整导览(右栏 tab、底栏终端、远程模式、
自动更新、Linux 安装)见 [docs/desktop.md](docs/desktop.md)。

**Web**:默认单用户自管模式零配置即用;多用户与身份模式(single/header/sso)
经环境变量切换,见 [docs/deploy.md](docs/deploy.md)。

## 核心特性

### 对话与会话

- SSE 流式渲染(正文/思考增量),运行中可停止;断流自愈(看门狗 +
  终态对账,按服务器快照恢复回合状态)
- 工具调用卡片:状态图标、参数摘要、展开看全量输入/输出、子代理标签
- `ask_user_question` 直接在底部输入框内展开(点选项即确认,多选题
  勾选后提交);工具审批卡片(批准/拒绝+反馈),应答后链式续跑
- 项目级会话列表(服务器为真 + 本地项目索引分组);跨重启恢复,暂停中
  的会话恢复出待答卡片;会话未读蓝点与运行中圆环

### 桌面工作台(桌面态专属)

- **底栏内嵌终端**:进入当前项目目录的登录 shell(xterm.js + Go PTY),
  收起保活;右栏另有独立终端 tab
- **git 审查**:当前项目状态分组(分支/领先落后/已暂存/未暂存/未跟踪),
  行内展开 diff,自动轮询
- **内嵌浏览器**:地址栏 + iframe,按 scope 记忆;智能体可经 goder-console
  在同一面板里导航/点击/读 console 与网络/截图——AI 调试页面用户全程可围观
- 本地服务只监听回环并带本机 Host 白名单;gh 令牌由同源代理注入,
  浏览器侧不持有

### 三方集成

- registry 注册表:左栏导航/右栏 tab/底栏 tab/设置分区四个装配区 +
  消息内容层(自定义渲染器、工具展示元数据、markdown 覆写),内置与
  三方条目同一条 `add/remove/hide/show` API
- 运行时策略按 scope 注入:`onBeforeSend`/`onApproval` 钩子、默认提示词、
  技能注入、宿主环境简报
- shadow DOM 样式自隔离,`--goder-*` CSS 变量换肤;`GODER_UI_VERSION`
  版本常量 + 完整 .d.ts 类型产物
- 快速体验:`./build.sh web` 后访问 `/embed-demo.html`

### 多用户网关

- 一用户一进程:独立端口池、数据目录与 GRF_HOME;懒启动、空闲回收、
  崩溃重启冷却、数量上限
- 三种身份模式:单用户 / 信任上级网关用户头(被集成推荐)/ 内置 Casdoor SSO
- 宿主管理面(`/admin/*`):供应商声明、模型解析、插件安装、会话索引、
  用户目录生命周期——声明式 API,嵌入方不再直写私有文件

## 配置参考

关键环境变量(全部可选,均有合理默认;完整清单见
[docs/deploy.md](docs/deploy.md)):

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADDR` | `127.0.0.1:7700` | 网关监听地址 |
| `GODER_IDENTITY` | `single` | `single` / `header` / `sso` |
| `GODER_DATA` | `./goder-web-data` | 数据根(用户目录布局) |
| `GODER_MAX_USERS` / `GODER_IDLE_TTL` | `50` / `30m` | 用户进程上限 / 空闲回收 |
| `GODER_CORS_ORIGINS` | 空 | 公网部署的跨域白名单(优先于默认通配) |
| `GODER_ADMIN_TOKEN` | 空(关闭) | 管理 API 令牌;**等同代码执行权限**,内网传递 |
| `GODER_GH_ENV_<KEY>` | — | 透传环境给 gh 子进程(如回合事件 webhook) |

## 安全

三种形态共用的安全模型(完整说明见 [docs/security.md](docs/security.md)),要点:

- **令牌边界**:gh 令牌由网关/桌面反代注入,不下发浏览器
- **header 模式只部署在可信反代之后**;sso 模式 TLS 卸载部署设
  `COOKIE_SECURE=1`,`AUTH_DEV_EMAIL` 生产留空
- 公网收紧 CORS(`GODER_CORS_ORIGINS` 白名单);`GODER_ADMIN_TOKEN`
  等同代码执行权限
- 桌面本地服务仅回环 + 敏感路径本机 Host 白名单(防 DNS rebinding)
- 下载完整性:gh/自更新/插件/技能落盘前按同目录 `.sha256`/`SHA256SUMS`
  校验,存在即强制
- markdown 先转义再受限渲染,链接仅放行 `http(s)`

## 项目结构

```
pkg/            Go 公开层(三方 Go module 可 import 的基座面)
  ghserver/       gh server 进程管理 + 反代核心(令牌注入/SSE/body 补长)
  identity/       身份解析:single / header / sso(Casdoor)
  gateway/        多用户 web 网关:/goder-api 按用户路由 + /admin/* + webhook
internal/        Go 桌面专属层(desktop wails 服务薄壳 / appcfg / grfsettings
                 / browser 原生 webview)
plugins/console/ goder-console:智能体驱动面板的 MCP 服务(仅绑回环)
cmd/goder-serve/ 多用户网关 CLI
frontend/src/    core(无 UI 核心层)/ registry(UI 注册表)/ panels /
                 shell(布局)/ ui / host(wails 桥)/ entries(桌面与嵌入入口)
docs/            专题文档(桌面/部署/安全/集成/测试)
```

依赖方向:panels/shell → registry/core;core 不依赖 UI;桌面专属能力只经
`host/bridge.ts` 进出。深度架构与代码约定见 [AGENTS.md](AGENTS.md)。

## 参与开发

```sh
cd frontend && npx tsc --noEmit    # 前端类型检查
cd frontend && npm test            # vitest 单元测试(registry/markdown/发送管线…)
go build ./... && go vet ./...     # Go 侧
go test ./...                      # pkg 基座面 + FQN 对齐守护
gofmt -l pkg cmd internal plugins  # 须无输出
```

- 端到端:`goder test-serve` 无头形态把完整桌面 UI 暴露给浏览器,指导见
  [docs/testing.md](docs/testing.md)(随二进制分发)
- 仓库内注释与文档使用中文
- 发版:推送 tag 触发 CI;版本号跟随 gh 最新发布 tag,详见 [AGENTS.md](AGENTS.md)

## 开源许可

本项目基于 [MIT License](LICENSE) 开源。
