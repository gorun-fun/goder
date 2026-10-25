# 接入方 AI 自动化测试指导

**中文(默认)** · [English](integration-testing.en.md)

> 本文档面向**把 goder 作为基座集成**的三方(嵌入 `goder.js` 的页面方、
> 部署 `goder-serve` 的网关方)与执行自动化测试的 AI 智能体:如何用
> 浏览器自动化测 goder 的**全部功能与扩展点**,而不依赖真实 gh server
> 与真实模型。
>
> 与 `docs/testing.md` 的分工:testing.md 是 goder 发布版自测指导
> (test-serve 形态,需真实 gh);本文是**接入方测自己的集成**——数据
> 由测试装具(scripted-api)注入,零网络零模型,CI 与 AI 均可跑。

## 1. 测试装具总览

三层能力,全部已从嵌入库导出(`import … from 'goder.js'`):

| 能力 | 入口 | 作用 |
|---|---|---|
| 传输层注入 | `setApiFetch(fn?)` | core 的全部 API 请求(ORS 客户端 + `/v1/agent/*`)经它发出;注入替身后 UI 全流程零网络 |
| 可编程假后端 | `createScriptedApi()` | 标准 fetch 签名的 gh server 替身:种子会话、SSE 脚本、场景、错误注入、请求记录 |
| 官方测试宿主页 | `dist-embed/test-harness.html` | 零配置打开即测的完整示例页;接入方自建测试页的官方模板 |

最小可用组合(三行):

```js
import { setKeyValueStorage, MemoryStorage, setApiFetch, createScriptedApi, configure } from 'goder.js';
setKeyValueStorage(new MemoryStorage());                    // 本地持久化隔离(刷新即净)
setApiFetch(createScriptedApi().asFetch());                 // 假后端接管全部 API
configure('test', { baseUrl: '/goder-api', model: 'fake/chat' });
```

之后正常挂面板(`<goder-app-shell scope="test">`):冷启动、会话、发送、
流式、审批、ask、中断、设置六分区全部走 fake,默认回声场景零脚本可用。

## 2. 快速开始:test-harness.html

`dist-embed/test-harness.html` 与 `goder.js` 同目录分发,任意静态
服务器打开即可(与嵌入产物同源)。

**URL 参数**:

| 参数 | 说明 |
|---|---|
| `?api=fake` | 默认。假后端 + MemoryStorage,零依赖零网络 |
| `?api=real` | 真实连接(同源 `/goder-api` 网关;`?server=` 指定 baseUrl) |
| `?scenario=<名>` | 初始场景(fake 模式),如 `?scenario=approval-pause` |

页面自带两层工具栏:

- **场景行**(fake 模式):回声 / 长markdown / 慢流 / 工具调用 / 审批暂停 / 提问暂停 / 断流 / 5xx / 失败帧 / 任务块 / 技能块 / notice,一键切换 + 重置;
- **扩展点行**:导航条目 / 右栏条目 / 设置分区 / 工具展示名 / 消息渲染器 / 发送钩子 / 审批自动应答 / 文案覆盖 / 换肤 / 裁剪事件台,每个开关即一个可断言的扩展点行为;
- **事件轨迹**:工具栏右侧实时显示最近 8 条 `grf:*` 事件(DOM 可读,AI 不用挂监听也能从页面读到事件历史)。

**`window.goderKit`**(测试面,不承诺语义稳定):

```js
goderKit.mode                                   // 'fake' | 'real'
goderKit.scenario('tool-call')                  // 切场景(等价点按钮)
goderKit.snapshot()                             // 稳定 JSON:registry 四区条目/连接态/
                                              // 会话列表/当前会话消息摘要/事件轨迹
goderKit.requests()                             // RecordedRequest[](断言出站请求)
goderKit.scriptNext({ inputIncludes: '关键词' }, frames)   // 精细脚本
goderKit.failNext({ inputIncludes: '关键词' }, { status: 503, message: '…' })
goderKit.ext.toggle('nav', true)                // 程序化触发扩展点开关
goderKit.reset()                                // 重载(回到干净状态)
```

`goderKit.snapshot()` 返回形如:

```json
{
  "mode": "fake", "scenario": "echo",
  "registry": { "nav": ["sessions","settings"], "side": ["detail","browser","console"],
                 "bottom": ["terminal"], "settings": ["appearance","models","harness","plugins","mcp","skills"] },
  "conn": { "state": "ok", "error": null },
  "sessions": ["fc_seed_history", "fc_seed_empty"],
  "activeSession": "fc_seed_history",
  "messages": [ { "kind": "user", "text": "…" }, { "kind": "assistant", "text": "…" } ],
  "events": ["goder:round-completed {\"sessionId\":\"…\",\"ok\":true}"]
}
```

## 3. scripted-api 能力参考

### 场景(scenario)

未脚本化的发送都走当前场景(`api.scenario(name)`;默认 `echo`):

| 场景 | 行为 | 覆盖的测试面 |
|---|---|---|
| `echo` | 逐段流式回显用户文本 → completed | 发送/流式渲染/中断/多轮链 |
| `markdown` | 长文 markdown(标题/列表/代码块/表格) | 渲染管线、代码块横向滚动 |
| `slow-stream` | 500ms/帧 × 6 | 过程态截图、停止按钮即时反馈 |
| `tool-call` | bash 工具 args 流式 → in_progress → completed → 总结 | 工具卡全生命周期 |
| `approval-pause` | 工具审批暂停(incomplete 挂起) | 审批卡允许/拒绝、审批钩子;应答回传自动续跑 |
| `ask-pause` | ask_user_question 暂停 | 底部输入框内的提问表单(单选/多选) |
| `stream-break` | 3 帧后静默截断(无终态) | 断流自愈、对账恢复(retrieveResponse) |
| `server-error` | 下一次发送 502,之后回落 echo | 错误卡、发送失败提示 |
| `server-fail-frame` | 流内 response.failed 终态 | 回合失败错误卡 |
| `task-block` | 回复含 `<goder-task>` 块 | 自动化任务卡渲染与保存 |
| `skill-block` | 回复含 `<goder-skill>` 块 | 技能保存卡渲染(web 态禁用保存) |
| `notice-todos` | grf:notice todos/goal/phase 流 | 状态浮窗、详情栏 todos |

### 精细脚本(帧级 DSL)

```js
const api = createScriptedApi();
setApiFetch(api.asFetch());

api.scriptNext(
  { inputIncludes: '报错' },                       // 匹配下一次发送
  [
    { delay: 50, event: { type: 'response.output_item.added',
                          item: { type: 'message', id: 'msg_1', role: 'assistant',
                                  status: 'in_progress', content: [] } } },
    { delay: 80, event: { type: 'response.output_text.delta', item_id: 'msg_1', delta: '第一段' } },
    { delay: 80, event: { type: 'response.output_text.delta', item_id: 'msg_1', delta: '第二段' } },
  ],                                               // 末帧非终态时自动补 response.completed
);
// 会话定向队列(该会话接下来每次发送依次消费一组):
api.scriptConversation(convId, frames);
// 错误注入(一次性):
api.failNext({ inputIncludes: '敏感' }, { status: 429, message: '限流' });
```

- 帧只写业务字段,`response.id/model/grf:session_id` 等公共字段自动补齐
  (与真实事件流一致,前端 curRespId 寻址可用);
- 脚本最后一帧若已是终态事件(`response.completed/failed/cancelled/
  incomplete` 且带 `response.status`)则原样生效,不重复补发;
- `requests()` 返回 `{method, path, body, at}[]`(滚动 500 条)——出站
  断言(如发送钩子改写后的文本、grf:session 透传)从这里读;
- `state()` 返回会话档案摘要(断言/调试用,不承诺字段稳定);
- 协议面对齐由 `frontend/tests/scripted-api.test.ts` 反向锁定:真实
  `GoderClient` 对 fake 全链路跑,client.ts 路径或形状漂移会先红。

### 种子会话

```js
createScriptedApi({ conversations: [
  { id: 'fc_demo', lastResponseId: 'resp_demo', history: [
      { role: 'user', content: '历史问题' },
      { role: 'assistant', content: '历史回答' },
  ]},
]})
```

会话列表/历史回放(`conversationItems` → `HistMessage[]` wire 形状)
直接可测;前端 `refreshConversations` 会把服务器会话补进索引「未分组」。

### 设置分区数据(`/v1/agent/*`)

fake 提供合理默认(供应商 `fake` 双模型、插件自动发现、两个技能),
`models/detect` 返回富结果(ctxLen);PUT 落内存可回读——设置页模型/
插件/技能分区的增删改、探测按钮均可测。

## 4. 观测面:事件与断言

### window 级事件(冒泡 CustomEvent,稳定 API)

| 事件 | detail | 用途 |
|---|---|---|
| `goder:session-selected` | `{ sessionId }` | 会话切换 |
| `goder:session-archived` | `{ sessionId }` | 会话归档 |
| `goder:round-completed` | `{ sessionId, ok }` | **回合终态标准等待点**(成功/失败/中断一律派发;`ok`=正常完成) |
| `goder:conn-state` | `{ scope, state }` | 连接态变化(`checking/ok/error/unknown`)——冷启动/断连/恢复断言 |

AI 自动化的推荐等待模式:

```js
await page.evaluate(() => new Promise((res) =>
  window.addEventListener('goder:round-completed', res, { once: true })));
```

### 断言约定

- **双轨断言**:行为断言(DOM/事件/`goderKit.snapshot()`)+ 视觉断言
  (截图,判定标准沿用 `docs/testing.md` §2.1 五条)——只做 DOM 断言
  的用例不完整;
- Lit + shadow DOM:元素查找穿透 shadow root
  (`el.shadowRoot.querySelector`),registry 驱动的面板在
  `goder-app-shell` 内;
- 状态断言优先 `goderKit.snapshot()`(test-harness)或宿主页自建的同等
  读取,不穿透内部字段;
- 出站请求断言走 `api.requests()`。

## 5. 扩展点测试矩阵

每个扩展点:触发方式 → 预期 → 断言点。在 test-harness 上可直接执行
(工具栏开关或 `goderKit.ext.toggle`);在接入方页面测自己的定制时,按
同样方法对自己的条目/钩子执行。

| 扩展点 | 触发 | 预期 | 断言 |
|---|---|---|---|
| registry.nav 条目 | 开「导航条目」 | 左栏出现「帮助中心」,点击切到宿主视图 | snapshot().registry.nav 含 `host-help`;截图确认高亮迁移 |
| registry.side 条目 | 开「右栏条目」 | 右栏出现「宿主指标」tab,内容显示当前会话 id/连接态 | registry.side 含 `host-metrics`;切换会话后内容跟随(保活) |
| registry.bottom 条目 | (注册后底栏可见) | 底栏出现宿主 tab | registry.bottom |
| registry.settings 分区 | 开「设置分区」 | 设置页出现「平台设置」分组/分区 | registry.settings 含 `host-brand`;截图 |
| registry.chat 工具展示名 | 开「工具展示名」+ 场景 `tool-call` | bash 工具卡显示「终端命令(宿主改名)」 | 工具卡 DOM 文案 |
| registry.chat 渲染器 | 开「消息渲染器」+ 场景 `notice-todos` | notice 消息变为宿主接管样式 | 消息 DOM 含 `[宿主接管]` |
| onBeforeSend 钩子 | 开「发送钩子」后发消息 | 出站文本带 `[host-hook 已注入]` 尾巴,回声包含它 | `requests()` 最后一条 body.input;回声消息文本 |
| onApproval 钩子 | 开「审批自动应答」+ 场景 `approval-pause` | 审批卡不出现(或一闪即过),回合自动续跑完成 | 等待 `goder:round-completed {ok:true}`;无审批卡 DOM |
| i18n 覆盖 | 开「文案覆盖」 | 「新会话」显示为 "New chat" | 按钮可访问名/文本 |
| 换肤(--goder-*) | 开「换肤」 | 强调色全局变化(按钮/高亮/指示条) | 前后截图对比 |
| registry 裁剪 | 开「裁剪事件台」 | 右栏 console tab 消失 | registry.side 仍含条目但 visible 不含;截图 |
| user chip / sideTop / markdown 覆写 / scope 多实例 | 见 `docs/embedding.md` 对应小节;在自建测试页按同法注入后断言 | — | — |

## 6. 在接入方自己的页面上测

test-harness 是模板。自建测试页三步:

1. 复制 test-harness.html 的 `<script>` 装配段(装 fake、MemoryStorage、
   configure),scope 名换成自己的;
2. 把自己的 registry 定制/configure 钩子加在装配之后(与生产页同一份
   代码最好——生产页支持 `?test=1` 参数切换装具,避免两份漂移);
3. 暴露自己的 `window.xxxKit`(快照/脚本/请求)供 AI 断言。

**桌面专属能力的 web 降级断言**(嵌入形态无终端/原生浏览器/文件预览):
断言入口隐藏且无报错(而非功能存在)——与 `docs/testing.md` §4 的
既有约定一致。

## 7. 网关接入方(Go):FakeUpstream

部署 `goder-serve` 的接入方在 Go 测试里用 `pkg/ghserver.FakeUpstream`
替代真实 gh 进程:`FixedUpstream` 指向它即可零二进制测网关全链路
(路由/鉴权/令牌注入/多用户隔离/类型化错误)。详见
`pkg/ghserver/fake.go` 头注释与 `fake_test.go` 用例。

`Proc/Manager` 全链路(真实 exec、端口池、空闲回收)不做 HTTP 级
替身——那是进程管理面的职责,用真实 gh 二进制测(`go test ./pkg/ghserver/`
即含)。

## 8. 已知边界

- scripted-api 模拟的是**协议面**,不是 gh 的业务语义(记忆工具、
  内置插件、真实审批策略);涉及 gh 服务端行为本身的测试仍走真实
  gh(test-serve / 人工 E2E,见 `docs/testing.md`);
- fake 的 SSE 无背压/无真实并发竞争;慢流场景的最小时序由帧 delay
  保证,测试不要依赖真实墙钟精确值,用事件顺序断言;
- `window.goderKit` 与 `api.state()` 是测试面,不承诺语义稳定;正式
  断言面是事件、`snapshot()` 的既有字段与 `requests()`。
