# AGENTS.md

grf-harness-ui:grf-harness(gh)的 ZCode 风格图形界面。一个 Lit 前端,两种形态:
wails v3 桌面 App(内置托管 `gh server` 子进程)与可嵌入三方页面的 web components
库(`frontend/dist-embed/grf-ui.js`,ESM、零外部依赖、shadow DOM 自隔离)。

## 常用命令

- `./build.sh` — 前端 + 桌面二进制 `./grf-harness-ui`
- `./build.sh app` — 组装 macOS `dist/grf-harness-ui.app`(adhoc 签名)
- `./build.sh embed` — 仅构建嵌入库 `frontend/dist-embed/grf-ui.js`
- `./build.sh web` — 纯 web 形态(grf-web-serve,静态 + `/grf-api` 反代,
  http://127.0.0.1:7700;`GRF_UPSTREAM` / `ADDR` 环境变量可覆写)
- `./start.sh start|stop|restart` — 桌面 App 生命周期(后台运行,PID/日志在 `.run/`)
- 类型检查:`cd frontend && npx tsc --noEmit`(无自动化测试;E2E 为真实
  gh server + 真实模型的手动浏览器验证,截图存 `gui-test-screenshots/`)

## 结构与分层

```
main.go / appconfig.go / servermanager.go / proxy.go / desktop.go
    wails v3 桌面壳:AppConfig(配置+项目索引持久化)、ServerManager(托管
    gh server)、/grf-api 同源反代、Desktop(原生目录选择/Reveal)
cmd/grf-web-serve/   纯 web 形态参考实现(静态 + CORS 反代)
frontend/src/
    api/    ORS 客户端(fetch + SSE 解析 + 断流看门狗)
    state/  scope 编排:项目索引、会话运行时、事件归一、自愈对账
    panels/ grf-* 面板:chat(消息流/工具卡/ask 表单/审批卡)/ session-list /
            sidebar / console
    shell/  grf-app-shell 三栏可展开布局
    embed/  嵌入库入口;main.ts 为桌面入口
    host/   wails 宿主桥(纯 web 态 no-op 回退)
    ui/     GrfPanel 基类与 --grf-* 主题令牌
```

依赖方向:panels/shell → state → api;桌面专属能力只经 `host/bridge.ts` 进出。

## 硬性约束(改代码前必读)

- **双形态不变量**:同一份前端代码同时跑在 wails 桌面与三方嵌入页。
  `@wailsio/runtime` 只能动态 import(嵌入产物不含它,
  `vite.embed.config.ts` 已 external);一切 wails 调用收敛在
  `frontend/src/host/bridge.ts`,纯 web 态必须 no-op 回退。
- 桌面态检测用 `inWails()`(协议/hostname + 真实调用探针),不能只看
  `window._wails`(浏览器懒加载 runtime 后也会置位)。
- 嵌入库保持零外部依赖、shadow DOM 样式自隔离;换肤只经 `--grf-*` CSS 变量。
- gh server 无 CORS 头:浏览器端一律走同源 `/grf-api` 反代(桌面内置或
  grf-web-serve),不要直连。
- `proxy.go`:WKWebView 自定义 scheme 请求不带 Content-Length,转发前必须
  整体缓冲 body 并补齐长度(Go#16036),否则 POST body 丢失。
- ServerManager 是全局单例:main 冷启动自拉起、wails 服务注册与
  `/grf-api/token` 端点共享同一份托管状态。
- 桌面 wails 服务(`appconfig.go` / `servermanager.go` / `desktop.go`)的
  DTO 与 `frontend/src/host/bridge.ts` 手工对齐,两边同改保持同步。

## 运行时环境

- 托管模式需 `gh` 可执行文件在 PATH(偏好设置可指定绝对路径);默认拉起
  `gh server -addr 127.0.0.1:7400 -data ~/Library/Application Support/grf-harness-ui/server-data`
- 配置与项目索引存 `~/Library/Application Support/grf-harness-ui/`
  (`index-<scope>.json`);纯 web 态项目索引存 localStorage
- 模型配置沿用 `~/.grf/settings.json`
- 版本:Go 1.26 / wails v3.0.0-beta.19 / lit 3 / vite 7 / TS 5.9 strict

## 约定与文档

- 仓库内注释与文档均用中文,保持一致。
- 改嵌入/对外 API 前先读 `docs/embedding.md`;功能对照与已知限制见 `README.md`。
- 本目录不是 git 仓库(有 .gitignore 但未 init),无提交/分支操作。
