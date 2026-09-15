# 三方 Web 集成指南

把 grf-harness 的会话列表 / 聊天 / 详情栏 / 事件台嵌入你自己的 web 应用。
与"裸 grf-harness 可配置开启哪些工具"对齐:界面的三个装配区域
(左栏导航、右栏 tab、底栏 tab)全部经 **registry 注册表**装配 ——
内置条目与你的自定义条目走同一条 API,可自由增删裁剪。

## 1. 引入

```html
<script type="module" src="/path/to/grf-ui.js"></script>
```

`grf-ui.js` 是自包含 ESM(shadow DOM 样式隔离,不污染宿主样式,也不受
宿主样式影响 —— 除 `--grf-*` 变量外)。import 即注册全部通用面板与
内置条目。

## 2. 连接配置

```js
import { configure } from '/path/to/grf-ui.js';
configure('myscope', {
  baseUrl: '/grf-api',   // gh server 根地址(不带 /v1);推荐同源网关
  token: '…',            // 可选:直连 gh server 时的 Bearer 令牌;
                         // 多用户网关模式由服务端注入,留空
  model: 'deepseek/deepseek-chat', // 可选:默认模型(provider/model)
  auth: {                // 可选:多用户网关的未登录(401)处置
    loginUrl: '/grf-api/auth/login', // 跳转登录入口
    // 或 onUnauthorized: (scope) => { … }  // 宿主自定义(设置后不再自动跳转)
  },
});
```

优先级:JS `configure` > 元素属性 > localStorage 记忆值。声明式属性:

```html
<grf-chat scope="myscope" server="/grf-api"></grf-chat>
```

用户也可在 `<grf-session-list>` 底部的连接区里手动配置(存 localStorage)。

**鉴权模型(重要)**:同源网关模式下,浏览器只需要网关的登录会话
(cookie 自动携带);每个用户的 gh 令牌由网关在转发时注入,**不下发浏览器**。
`token` 仅在直连外部 gh server 时使用。

## 3. 面板清单

| 元素 | 说明 | 常用属性 |
|------|------|----------|
| `<grf-session-list>` | 项目级会话列表:项目分组/新建/重命名/归档;条目蓝点 = 有未查看的完成回合 | `no-connection` 隐藏底部连接配置 |
| `<grf-chat>` | 聊天:消息流 + 工具卡 + ask 表单 + 审批卡 + 输入框;右栏为 tab 化(条目见 registry.side) | `no-header` `no-composer` |
| `<grf-session-detail>` | 右栏"详情"面板本体:概览/用量/工具时间线/Todo/元信息 | — |
| `<grf-review>` | git 审查:分支/领先落后/文件分组 + 行内 diff(依赖桌面能力,纯 web 态显示占位) | `.cwd` |
| `<grf-browser>` | 内嵌浏览器:地址栏 + iframe,上次访问地址按 scope 记忆 | — |
| `<grf-console>` | 事件流日志(全部 SSE 事件 + 系统消息) | `filter="all\|events\|problems"` |
| `<grf-app-shell>` | 上述整套布局(左导航 + 黑色圆角工作卡,可折叠/拖拽分区) | `panels="sessions,chat,sidebar,console"` `layout="sidebar=false"` `nav="sessions"` |

所有面板公有属性:`scope`(数据域,默认 `default`)、`server`、`token`。

## 4. registry:界面定制(核心扩展点)

三个区域,各是一个条目集合(`add/remove/hide/show/items/visible`):

- `registry.nav` —— 左栏导航视图(内置:`sessions` 会话、`settings` 设置)
- `registry.side` —— 右栏 tab(内置:`detail` `browser` `console` `review`
  `terminal` `file`,后三者仅桌面形态可见)
- `registry.bottom` —— 底栏 tab(内置:`terminal`,仅桌面)

### 裁剪内置条目

```js
registry.side.hide('console');   // 隐藏事件台
registry.nav.hide('settings');   // 隐藏设置入口(嵌入态宿主自管配置时)
registry.side.show('console');   // 恢复
```

### 新增自定义条目

```js
import { registry, html } from '/grf-ui.js';

// 左栏导航:一个视图 + 可选的中央工作区覆写(缺省 = 聊天)
registry.nav.add({
  id: 'help',
  label: '帮助',
  order: 50,                        // 排序权重,内置会话=10/设置=90
  view: (ctx) => html`<my-help-panel user=${ctx.store}></my-help-panel>`,
  // center: (ctx, state) => html`…`,  // 可选:激活该导航时中央显示的内容
});

// 右栏 tab:render 返回模板或 HTMLElement(HTMLElement 跨 tab 开关保活)
registry.side.add({
  id: 'metrics',
  label: '指标',
  icon: '<svg …>…</svg>',           // 内联 svg 字符串
  width: 360,                       // 默认宽度(用户可拖拽覆盖)
  render: (ctx) => html`
    <div>当前会话:${ctx.sessionId ?? '(未选择)'}</div>
    <div>连接:${ctx.store.connState}</div>`,
});
// 多实例 tab(每个 key 一个独立 tab,如内置的文件 tab):
registry.side.add({
  id: 'doc', multi: true,
  titleFor: (key) => key,
  render: (ctx, key) => html`<my-doc doc=${key}></my-doc>`,
});

// 底栏 tab:每开一个 tab 新建一个实例元素(有状态内容)
registry.bottom.add({
  id: 'logs',
  label: '日志',
  icon: '<svg …>…</svg>',
  create: (ctx) => document.createElement('my-log-view'),
});
```

**PanelContext**(渲染函数入参):`scope`(数据域名)、`store`(该 scope 的
共享数据域:会话/事件流/连接状态,见类型 `GrfScope`)、`sessionId`(当前
会话)、`desktop`(是否 wails 桌面态)、`shell`(app-shell 内装配时的布局
状态:左栏展开/桌面红绿灯/切换回调;独立嵌入为 undefined)。

**切换导航**:`<grf-app-shell>` 提供 `navTo(id)` 方法与 `activeNav` 属性,
也接受冒泡事件 `grf-nav-activate`(detail = 导航 id)。导航视图可经
`grf-nav-state`(detail = `{ nav?, state }`)向 shell 上抛状态(内置设置
分区即此机制)。

### 注册表生效范围

registry 是全局单例:同页所有 scope 实例共享条目定义;数据按 scope 隔离。
条目的 `visible(ctx)` 可按上下文动态显隐(内置条目用它做桌面能力降级)。

## 5. 服务端接入:grf-web-serve 网关

浏览器不能直连 gh server(无 CORS 头)。两种接法:

1. **同源网关(推荐)**:部署 `cmd/grf-web-serve`(或把同样的逻辑放进你
   的后端/网关):静态托管前端产物 + `/grf-api` 反代。
2. 给 gh server 加 CORS(不推荐,SSE 也要带头,且令牌暴露给浏览器)。

`grf-web-serve` 的核心能力是**多用户隔离:一个用户一个 gh server 进程**
(独立端口池 17400-18400、独立数据目录 `<GRF_DATA>/users/<uid>/server-data`),
用户令牌由网关注入。身份模式经 `GRF_IDENTITY` 选择:

### single(默认,本地联调)

所有人共用一个进程(uid=`local`);配 `GRF_UPSTREAM` 时改为直连外部
gh server(不托管进程,浏览器携带 token —— 兼容最简部署)。

```sh
GRF_DATA=./grf-web-data ADDR=127.0.0.1:7700 go run ./cmd/grf-web-serve
```

### header —— 被三方应用集成(如 game-web)

你的应用完成自己的登录(SSO),由**你的后端**把 `/grf-api` 反代到本网关,
并注入可信用户头。本网关按头解析用户、路由到该用户专属的 gh 进程。

```
浏览器 ──cookie──▶ 三方应用后端(game-web)
                      │ 反代 /grf-api + 注入 X-GRF-UID: <用户id>
                      ▼
                 grf-web-serve(GRF_IDENTITY=header)
                      │ uid → 独立 gh server(端口池 + 独立数据目录)
                      ▼
                 gh server ×N
```

```sh
GRF_IDENTITY=header GRF_UID_HEADER=X-GRF-UID ADDR=127.0.0.1:7702 \
  GRF_DATA=/srv/grf-web GRF_IDLE_TTL=30m go run ./cmd/grf-web-serve
```

自检端点:`GET /grf-api/whoami` 返回当前解析到的用户与后端进程地址;
`GET /grf-api/healthz` 网关探活。

**安全约束**:header 模式信任请求头,必须保证网关端口只接受来自你后端的
流量(内网/localhost/防火墙),不可直接暴露公网。

### sso —— 独立部署的完整方案

网关自己做 Casdoor OAuth2 授权码登录(参考 game-web 的流程,独立实现、
无数据库依赖):`/grf-api/auth/login | callback | logout | me`,本地签发
不透明随机会话(HttpOnly cookie,默认内存表,`identity.SessionStore`
接口预留持久化)。开发后门 `AUTH_DEV_EMAIL` 仅供本地联调。

```sh
GRF_IDENTITY=sso \
  SSO_ENDPOINT=https://sso.example.com \
  SSO_CLIENT_ID=… SSO_CLIENT_SECRET=… \
  SSO_REDIRECT_URL=https://app.example.com/grf-api/auth/callback \
  COOKIE_SECURE=1 ADDR=:7700 go run ./cmd/grf-web-serve
```

前端配置未登录跳转:`configure('scope', { baseUrl: '/grf-api',
auth: { loginUrl: '/grf-api/auth/login' } })`。

### 职责边界(本项目 vs 三方)

| 职责 | 归属 |
|------|------|
| 用户体系、SSO 登录页、角色/权限 | **三方**(game-web:Casdoor + 自己的会话) |
| 把已登录用户映射到稳定 uid 并注入可信头 | **三方后端** |
| uid → 独立 gh 进程的隔离、令牌注入、生命周期(懒启动/空闲回收/上限) | **本项目网关** |
| 前端面板嵌入、registry 定制、scope 数据隔离 | **本项目嵌入库** |
| 独立部署时的完整登录流程(Casdoor sso 模式) | 本项目提供,可选 |

## 6. scope:一页多实例

同 scope 的面板共享:当前会话、运行状态、事件流、控制台日志。
不同 scope 各自独立(各自的连接配置、项目索引、会话)。

```html
<grf-session-list scope="ops"></grf-session-list>
<grf-chat scope="ops"></grf-chat>
```

## 7. 事件(宿主监听)

面板向页面派发冒泡 CustomEvent:

| 事件 | detail |
|------|--------|
| `grf:session-selected` | `{ sessionId }` |
| `grf:session-archived` | `{ sessionId }` |

```js
window.addEventListener('grf:session-selected', (e) => {
  console.log('选中会话', e.detail.sessionId);
});
```

## 8. 主题

面板读取 `--grf-*` CSS 变量,在页面 `:root` 覆写:

```css
:root {
  --grf-bg: #101014;         /* 背景 */
  --grf-accent: #e05d27;     /* 主色 */
  --grf-font-size: 14px;     /* 字号 */
  /* 完整清单见 frontend/src/ui/theme.ts 的 theme 块 */
}
```

## 9. 行为细节

- **发送**:Enter 发送、Shift+Enter 换行;支持粘贴/选择图片(data URL
  多模态);回合运行中输入区切换为"停止"
- **暂停应答**:模型 `ask_user_question` 或工具审批会暂停回合,提问在
  **底部输入框内**展开,单选点击选项即提交、多选勾选后提交;工具审批为
  聊天区卡片。应答后自动续跑(链式 `grf:input_result`);重新打开暂停中
  的会话会恢复待答界面
- **编辑重发**:用户消息悬停出现复制/编辑,编辑后"重新发送"会**从该消息
  处截断历史**再发(需 gh server 支持 `grf:history` 前缀覆写扩展)
- **断流自愈**:SSE 中断时客户端按服务器终态对账恢复(看门狗兜底),
  不需要宿主处理
- **持久化**:项目索引与会话分组存 localStorage(键
  `grf-ui:<scope>:index`);连接配置存 `grf-ui:<scope>:conn`。宿主可
  自行清理这些键做"重置"
- 本仓库演示页 `frontend/embed-demo.html` 含 registry 裁剪/新增完整示例
