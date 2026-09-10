# 三方 Web 集成指南

把 grf-harness 的会话列表 / 聊天 / 详情栏 / 事件台嵌入你自己的 web 应用。
与"裸 grf-harness 可配置开启哪些工具"对齐,这里的 UI 面同样是可配置的:
四个面板自由裁剪组合。

## 1. 引入

```html
<script type="module" src="/path/to/grf-ui.js"></script>
```

`grf-ui.js` 是自包含 ESM(gzip ≈ 36KB,shadow DOM 样式隔离,不污染宿主
样式,也不受宿主样式影响——除 `--grf-*` 变量外)。

## 2. 连接配置

三种方式,优先级:JS `configure` > 元素属性 > localStorage 记忆值。

```js
import { configure } from '/path/to/grf-ui.js';
configure('myscope', {
  baseUrl: 'https://gh.example.com', // gh server 根地址(不带 /v1)
  token: '…',                        // Bearer 令牌
  model: 'deepseek/deepseek-chat',   // 可选:默认模型(provider/model)
});
```

```html
<grf-chat scope="myscope" server="https://gh.example.com" token="…"></grf-chat>
```

用户也可在 `<grf-session-list>` 底部的连接区里手动配置(存 localStorage)。

## 3. 面板清单

| 元素 | 说明 | 常用属性 |
|------|------|----------|
| `<grf-session-list>` | 项目级会话列表:项目分组/新建/重命名/归档;条目蓝点 = 有未查看的完成回合 | `no-connection` 隐藏底部连接配置 |
| `<grf-chat>` | 聊天:消息流 + 工具卡 + ask 表单 + 审批卡 + 输入框;右栏为 tab 化(详情/审查/终端/浏览器) | `no-header` `no-composer` |
| `<grf-sidebar>` | 右栏"详情"面板本体:概览/用量/工具时间线/Todo/元信息 | — |
| `<grf-review>` | git 审查:分支/领先落后/文件分组 + 行内 diff(`cwd` 属性指定仓库路径;依赖桌面能力,纯 web 态显示占位) | `.cwd` |
| `<grf-browser>` | 内嵌浏览器:地址栏 + iframe,上次访问地址按 scope 记忆 | — |
| `<grf-console>` | 事件流日志(全部 SSE 事件 + 系统消息)。独立嵌入面板;应用内底栏已改为内嵌终端,事件台不再出现在 app 布局中 | `filter="all\|events\|problems"` |
| `<grf-app-shell>` | 上述整套布局(标题栏 + 可折叠/拖拽分区) | `panels="sessions,chat,sidebar,console"` `layout="sidebar=false"` |

所有面板公有属性:`scope`(数据域,默认 `default`)、`server`、`token`。

注:
- web 态"新建项目"为内联输入名称(无原生目录选择器;桌面态为系统
  目录选择器并记录项目路径)。
- **终端与 git 审查为桌面专属能力**(PTY / 本地 git 经 wails 服务),
  嵌入库不含终端面板,嵌入态右栏 tab 与底栏会自动隐藏对应入口;
  浏览器 tab 与详情 tab 在嵌入态正常可用。
- `panels` 中的 `console` 键沿用为底栏开关;嵌入态无终端面板时底栏
  自动隐藏。

## 4. scope:一页多实例

同 scope 的面板共享:当前会话、运行状态、事件流、控制台日志。
不同 scope 各自独立(各自的连接配置、项目索引、会话)。

```html
<grf-session-list scope="ops"></grf-session-list>
<grf-chat scope="ops"></grf-chat>

<grf-chat scope="dev" server="http://127.0.0.1:7401" token="…"></grf-chat>
```

## 5. 面板裁剪(按需开启 UI 的哪些部分)

```html
<!-- 只要聊天 -->
<grf-chat scope="a"></grf-chat>

<!-- 聊天 + 事件台(常见运维台形态) -->
<grf-app-shell scope="b" panels="chat,console" layout="console=true"></grf-app-shell>

<!-- 完整桌面形态 -->
<grf-app-shell scope="c"></grf-app-shell>
```

`panels` 逗号列表决定装配哪些部分;`layout` 形如
`sidebar=false,console=true,leftWidth=300` 控制初始展开。

## 6. 事件(宿主监听)

面板向页面派发冒泡 CustomEvent:

| 事件 | detail |
|------|--------|
| `grf:session-selected` | `{ sessionId }` |
| `grf:session-archived` | `{ sessionId }` |

```js
window.addEventListener('grf:session-selected', e => {
  console.log('选中会话', e.detail.sessionId);
});
```

## 7. 网络:CORS

gh server 不发送 CORS 头,浏览器跨源直连会被拦。两种接法:

1. **同源反代(推荐)**:网关把 `/grf-api/*` 转发到 gh server(去前缀)。
   参考实现 `cmd/grf-web-serve/main.go`(静态托管 + 反代 + 宽松 CORS,
   本地联调可直接用:`GRF_UPSTREAM=http://127.0.0.1:7400 ADDR=127.0.0.1:7700 go run ./cmd/grf-web-serve`)。
   配好后 `baseUrl` 填 `https://你的域/grf-api`。
2. **给 gh server 加 CORS**:自行扩展(注意 SSE 响应也要带
   `Access-Control-Allow-Origin`)。

SSE 经反代需即时下发(`FlushInterval: -1`),参考实现已处理。

## 8. 主题

面板读取 `--grf-*` CSS 变量,在页面 `:root` 覆写:

```css
:root {
  --grf-bg: #101014;         /* 背景 */
  --grf-accent: #e05d27;     /* 主色 */
  --grf-font-size: 14px;     /* 字号 */
  /* 完整清单见 frontend/src/ui/base.ts 的 theme 块 */
}
```

## 9. 行为细节

- **发送**:Enter 发送、Shift+Enter 换行;支持粘贴/选择图片(data URL
  多模态);回合运行中输入区切换为"停止"
- **暂停应答**:模型 `ask_user_question` 或工具审批会暂停回合,提问在
  **底部输入框内**展开(输入框变高、列出问题与选项),单选点击选项即提交、
  多选勾选后提交(文本题用输入框内文本框);工具审批为聊天区卡片。应答后
  自动续跑(链式 `grf:input_result`);重新打开暂停中的会话会恢复待答界面
- **编辑重发**:用户消息悬停出现复制/编辑,编辑后"重新发送"会**从该消息处
  截断历史**再发(需 gh server 支持 `grf:history` 前缀覆写扩展)
- **断流自愈**:SSE 中断时客户端按服务器终态对账恢复(看门狗兜底),
  不需要宿主处理
- **持久化**:项目索引与会话分组存 localStorage(键
  `grf-ui:<scope>:index`);连接配置存 `grf-ui:<scope>:conn`。宿主可
  自行清理这些键做"重置"
