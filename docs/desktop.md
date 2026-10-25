# 桌面 App 指南

**中文(默认)** · [English](desktop.en.md)

wails v3 桌面形态:可直接安装的本地应用,自动托管 `gh server` 子进程。

## 构建与安装

```sh
./build.sh          # 前端 + 桌面二进制 ./goder
./build.sh app      # 组装 dist/goder.app(macOS,adhoc 签名)
```

- 前置:`gh` 可执行文件在 PATH(偏好设置可指定绝对路径)。**缺失时自动
  下载**:Windows 弹原生对话框确认并带进度条,macOS/Linux 静默,均落用户
  配置目录 `bin/` 下(来源 download.gorun.fun/grf-harness,下载前按同目录
  `.sha256`/`SHA256SUMS` 校验完整性)。macOS .app 正常捆绑 gh,仅缺失时
  走下载兜底;Windows/Linux 发行包(zip)只含 goder 本体。
- 模型配置沿用 `~/.grf/settings.json`(`gh model` 配置的那份,`GRF_HOME`
  可重定位)。

## 运行形态

- **托管模式(默认)**:启动即拉起
  `gh server -addr 127.0.0.1:7400 -data ~/Library/Application Support/goder/server-data`,
  前端经 app 内同源代理 `/goder-api` 连接(**令牌由代理注入**,浏览器侧
  不持有);退出时回收子进程(强杀也有看门狗兜底,不留孤儿)。
- **远程模式**(设置 → 常规):连接任一已运行的 gh server(URL + token)。
- **自动更新**:打开即查、每小时复查;确认后下载 → 校验 → 自替换 →
  重启(gh 与插件随版本同步更新)。

## 界面导览

- **左栏**:项目级会话列表。**新建项目 = 本地目录**(系统目录选择器,
  项目名取目录名);「自动化」类别是操作员项目(任务沉淀与一键执行)。
  会话条目蓝点 = 有未查看的完成回合,运行中显示旋转小圆环。
- **中间**:聊天流。工具卡片(参数摘要、展开看全量输入/输出)、
  ask_user_question 直接在输入框内展开、工具审批卡片(批准/拒绝+反馈)。
- **右栏 tab**:详情(概览/用量/工具时间线)、**审查**(当前项目 git
  状态分组 + 行内 diff)、**终端**(独立 PTY 会话)、**浏览器**(地址栏 +
  内嵌 iframe,按 scope 记忆)、文件、事件台;tab 可增删、宽度可拖。
- **底栏终端**:进入**当前项目目录**的登录 shell(xterm.js + Go PTY),
  高度可拖拽,收起时会话保活;支持多 tab,三方亦可注册自己的底栏 tab。
- **设置页**:左栏底部齿轮,左导航 + 右工作双面板(常规/外观/模型设置/
  智能体/更新),改动即时生效并自动保存。
- **智能体控制(goder-console)**:gh 里的智能体可「看得见地」操作右栏
  浏览器与终端面板(用户全程可围观与接管)——仅绑 127.0.0.1 + 随机令牌。

## 数据位置

| 内容 | 位置 |
|---|---|
| 项目索引与会话归属 | `~/Library/Application Support/goder/index-<scope>.json` |
| 托管 gh 数据 | `~/Library/Application Support/goder/server-data` |
| goder-console 端口/令牌 | `~/Library/Application Support/goder/console-mcp.json`(0600) |
| 模型/插件/技能配置 | `~/.grf/`(`GRF_HOME` 可重定位) |
| 会话历史与 workspace | gh server 管理(随其数据目录) |

## Linux 安装

GNOME 文件管理器双击裸可执行文件不执行(按内容类型找「打开方式」),
正规入口是应用菜单/桌面图标。Linux zip 附 `install.sh`(含 .desktop 模板
与图标):解压后 `./install.sh` 一次,即装进 `~/.local/bin` 与应用概览
(搜索「Goder」启动);终端运行照旧。

## 已知限制

- 内嵌终端与 git 审查依赖 PTY/本地进程,仅桌面态可用(嵌入形态对应
  入口自动隐藏;事件台与浏览器 tab 在嵌入态可用)。
- 审批卡片(tool_approval)依赖 gh 会话级审批模式;默认策略
  (auto_approve)下不会出现,ask 表单卡不受影响。
- 历史(非本进程)回合的思考过程(reasoning)不在线格式里,恢复历史时
  不回放;工具卡与正文正常回放。
- web 形态的项目索引存 localStorage(按源隔离);桌面态存文件。
