# 三方 Web 集成指南

把 grf-harness 的会话列表 / 聊天 / 详情栏 / 事件台嵌入你自己的 web 应用。
与"裸 grf-harness 可配置开启哪些工具"对齐:界面的四个装配区域
(左栏导航、右栏 tab、底栏 tab、设置分区)全部经 **registry 注册表**装配 ——
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
  model: 'deepseek/deepseek-chat', // 可选:默认模型;必须 provider/model
                         // 全名(裸名会被按供应商表补全,补不出视同未选、
                         // 走服务端默认 —— gh 只认全名,裸名静默忽略)
  auth: {                // 可选:多用户网关的未登录(401)处置
    loginUrl: '/grf-api/auth/login', // 跳转登录入口
    // 或 onUnauthorized: (scope) => { … }  // 宿主自定义(设置后不再自动跳转)
  },
  policySelector: false, // 可选:false 隐藏 composer 策略选择器(嵌入方
                         // 经项目 defaults 全权管理会话策略时)
  settings: {            // 可选:设置页裁剪
    agentGroup: false,   // false = 隐藏「智能体」分组(Harness/插件/MCP/
                         // 技能——浏览器形态只读引导,平台不开放管理时)
  },
  user: {                // 可选:注入左栏底部身份 chip(自带用户体系的
    name: '张三',        // 嵌入方用;未注入时显示系统用户名/「本地用户」)
    detail: 'zhangsan',  // 可选:悬浮提示补充(如 uid)
    panel: (ctx) => {    // 可选:给出后 chip 可点击,在 chip 上方弹出
      const el = document.createElement('div');
      el.textContent = '宿主自绘的用户信息面板(如资料/退出登录)';
      return el;
    },
    chevron: false,      // 可选:false 去掉 chip 尾部小箭头(默认 true)
    hit: 'content',      // 可选:'content' 时可点/悬停区域收缩为图标+
  },                     // 名字块(默认 'full' 整行)
  sideTop: {             // 可选:向左栏顶行(折叠侧栏按钮所在行)注入
    leading: () => {     // 宿主自定义元素(leading=行首,trailing=行尾;
      const el = document.createElement('button'); // 元素渲染在 shell 的
      el.textContent = '⌂'; // shadow DOM 内,样式须内联,跨重渲保活)
      return el;
    },
  },
  sessionDefaults: {     // 可选:项目无 defaults/未分组会话的 grf:session
                         // 兜底(system_prompt/default_skill/policy 等;
                         // 草稿落定时展开在项目 defaults 之前,逐字段被其
                         // 覆盖——有 defaults 的项目不受影响;不持久化,
                         // 宿主每次加载自行下发)
    system_prompt: '…',  // custom 段(身份+工作方式;gh 内置工具说明恒定追加)
    default_skill: 'grf-start', // 默认技能全文注入(目录存在该技能时)
  },
  ungroupedSessions: false, // 可选:false 禁止未分组会话——无激活会话直接
                         // 发送时兜底改绑最近使用的项目,左栏「未分组
                         // 会话」分组不再渲染
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

四个区域,各是一个条目集合(`add/remove/hide/show/items/visible`):

- `registry.nav` —— 左栏导航视图(内置:`sessions` 会话、`settings` 设置)
- `registry.side` —— 右栏 tab(内置:`detail` `browser` `console` `review`
  `terminal` `file`,后三者仅桌面形态可见)
- `registry.bottom` —— 底栏 tab(内置:`terminal`,仅桌面)
- `registry.settings` —— 设置分区(内置:`appearance` 外观、`models` 模型、
  `harness` `plugins` `mcp` `skills` 智能体组)

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

### 自定义设置分区(registry.settings)

设置页(左栏分区导航 + 中央分区页面)与三区同构:内置分区也是注册条目,
第三方可新增自己的设置分区并自绘分区页面,也可裁剪或覆写内置分区。

```js
registry.settings.add({
  id: 'brand',
  label: '平台设置',
  group: '平台',        // 左栏分组标题;缺省归入「扩展」。
                        // 内置分组名「基础设置」「智能体」可复用(并入其中)
  order: 15,            // 排序权重(内置:外观 10 / 模型 20 / Harness 30 /
                        // 插件 40 / MCP 50 / 技能 60);缺省追加在内置之后
  wide: true,           // 可选:分区页面用宽画布(880px,默认 620px)
  icon: '<svg …>…</svg>', // 可选;缺省用通用设置图标
  render: (ctx) => html`<div>…自绘分区页面…</div>`,
});
```

- `render` 返回模板随渲染重建;返回 **HTMLElement 跨分区切换保活**(适合
  有状态控件),页面在 shadow DOM 内、宿主样式进不去 —— 内容用内联样式,
  颜色可复用会继承穿透的 `--grf-*` 变量
- `ctx` 为 `PanelContext`(设置视图无会话上下文:`sessionId` 为空、
  `shell` 为 undefined;`desktop` 可用来做形态降级)
- **覆写内置分区**:同 id 重复 `add` 即整体替换(如 `id: 'appearance'`
  带自定义 `render` = 换掉内置「外观」页)
- **裁剪**:`registry.settings.hide('models')` 隐藏内置或自定义分区
  (当前分区被隐藏时自动退回第一个可见分区),`show` 恢复
- `visible(ctx)` 按上下文动态显隐

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

### 身份区注入(左栏底部用户 chip)

`<grf-session-list>` / `<grf-settings-nav>` 底部的身份区统一由
`<grf-user-chip>` 渲染。自带用户体系(SSO 等)的嵌入方经
`configure(scope, { user })` 注入展示名;给出 `panel` 后 chip 可点击,
在 chip 上方弹出宿主自绘的用户信息面板(资料 / 退出登录等放这里),
点击面板外部或 Esc 关闭。面板元素在 chip 的 shadow DOM 内渲染,宿主
样式进不去 —— 面板内容用内联样式,颜色可复用会继承穿透的 `--grf-*`
变量;返回的 HTMLElement 跨开关保活。`user.panel` 的入参与右栏 tab 同
为 `PanelContext`(无会话上下文,`sessionId` 为空)。`user.chevron:false`
去掉 chip 尾部小箭头(默认 true);`user.hit:'content'` 把可点/悬停区域
收缩为图标+名字块(默认 `'full'` 整行)。弹层宽度内容驱动:不窄于 chip
行,宿主面板可用自身 `min-width` 撑宽(上限 420px / 90vw)。

### 左栏顶行注入(sideTop)

`configure(scope, { sideTop: { leading, trailing } })` 向左栏顶行
(`.side-top`,折叠侧栏按钮所在行)注入宿主自定义元素:`leading` 渲染
在折叠按钮之前(行首),`trailing` 渲染在行尾。元素在 shell 的 shadow
DOM 内渲染(宿主样式进不去,样式须内联),跨重渲保活,配置变更时丢弃
重建;未配置时该行保持原样。典型用途:嵌入平台在左上角放返回自家
站点的入口按钮。

### 设置页裁剪与定制

设置页的「智能体」分组(Harness/插件/MCP/技能)与「模型」供应商管理,
网页形态经 gh server 的 `/v1/agent/*` 配置 API 读写(需较新版本 gh;
API Key/MCP Token 掩码——不下发明文,空值=保留)。多用户网关默认按
用户注入 `GRF_HOME`(`<data>/users/<uid>/grf-home`),配置随登录用户
完全隔离;`GRF_USER_HOME=0` 关闭,`GRF_SETTINGS_SEED` 可指定用户首启
播种的初始 settings.json(一次性快照,之后独立)。gh server 过旧或未
启用隔离时这些分区回落为引导文案;平台不开放管理入口时仍可经
`configure(scope, { settings: { agentGroup: false } })` 整组隐藏。
新增自定义分区、覆写/隐藏内置分区见上文「自定义设置分区
(registry.settings)」。

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
