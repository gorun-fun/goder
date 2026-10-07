// scripted-api.ts — 可编程的 gh server 假后端(测试装具核心)。
//
// 以标准 fetch 签名 ((input, init) => Promise<Response>) 实现 gh server
// 的 ORS Responses API + /v1/agent/* 协议面,经 core/api/fetch.ts 的
// setApiFetch 装载后,前端全部 UI 流(冷启动/会话/发送/流式/审批/ask/
// 中断/恢复/设置分区)零网络可驱动 —— AI 自动化测试与接入方 E2E 的
// 数据控制面。协议路径与 wire 形状以 core/api/client.ts、agent-api.ts
// 为唯一事实源对齐;单测反向锁定,勿单侧漂移。
//
// 三层脚本能力(优先级从高到低):
//   1. failNext / scriptNext —— 一次性规则,按发送内容匹配;
//   2. scriptConversation —— 会话定向脚本队列;
//   3. scenario(name) —— 场景级默认行为(未脚本化的发送都走它,默认 echo)。
// 场景集合见 ScenarioName;test-harness.html 的场景按钮即消费这里。

import type {
  ContentPart,
  Conversation,
  ConversationDetail,
  HistMessage,
  IncompleteDetails,
  OutputItem,
  ResponseResource,
  SSEEvent,
  Usage,
} from './types';

// ---------- 公开类型 ----------

/** 已记录的请求(断言用;上限 500 条滚动)。 */
export interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
  at: number;
}

/** 发送匹配规则:全部条件同时满足才命中。 */
export interface SendMatcher {
  /** 发送文本包含该子串(input 为数组时取 user message 文本拼接) */
  inputIncludes?: string;
}

/** 一帧脚本:delay 毫秒后发出该 SSE 事件(event.response 等公共字段自动补齐)。 */
export interface ScriptFrame {
  delay?: number;
  event: Partial<SSEEvent> & { type: string };
}

/** 一次性错误注入(下一次匹配的发送返回非 2xx)。 */
export interface FailureSpec {
  status?: number;
  code?: string;
  message?: string;
}

/** 种子会话(会话列表/历史回放用例)。 */
export interface SeedConversation {
  id?: string;
  history?: HistMessage[];
  lastResponseId?: string;
  workspace?: string;
}

export type ScenarioName =
  | 'echo' // 默认:逐段流式回复 + 完成(零脚本即可测发送/流式/中断)
  | 'markdown' // 长文 markdown 回复(渲染管线验证)
  | 'slow-stream' // 慢流(500ms/帧,过程截图用)
  | 'tool-call' // bash 工具调用全生命周期 + 总结
  | 'approval-pause' // 工具审批暂停(应答后续跑走默认场景)
  | 'ask-pause' // ask_user_question 暂停
  | 'stream-break' // 流中途截断无终态(断流自愈/对账恢复用)
  | 'server-error' // 下一次发送 5xx,之后回落 echo
  | 'server-fail-frame' // 流内 response.failed 终态(错误卡)
  | 'task-block' // 回复含 <goder-task> 块(自动化任务卡)
  | 'skill-block' // 回复含 <goder-skill> 块(技能保存卡)
  | 'notice-todos'; // grf:notice todos/goal 流(状态浮窗/详情栏)

export interface ScriptedApiState {
  conversations: {
    id: string;
    lastResponseId?: string;
    running: boolean;
    paused: boolean;
    turns: number;
  }[];
}

// ---------- 内部模型 ----------

interface FakeConv {
  id: string;
  createdAt: string;
  workspace: string;
  archived: boolean;
  history: HistMessage[];
  lastResponseId?: string;
  running: boolean;
  paused: boolean;
  turns: number;
}

interface RunningRound {
  conv: FakeConv;
  respId: string;
  cancelRequested: boolean;
}

const DEFAULT_FRAME_GAP_MS = 60;

// ---------- 场景帧生成(纯函数,输入为用户文本) ----------

function splitChunks(text: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / n));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function assistantItem(id: string, text: string): OutputItem {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

/** 文本轮次的完整帧序列:added → 逐段 delta → item done → completed。 */
function textRoundFrames(text: string, gap = DEFAULT_FRAME_GAP_MS): ScriptFrame[] {
  const itemId = 'msg_assistant_1';
  const frames: ScriptFrame[] = [
    { delay: gap, event: { type: 'response.output_item.added', output_index: 0, item: { ...assistantItem(itemId, ''), status: 'in_progress' } } },
  ];
  for (const chunk of splitChunks(text, 6)) {
    frames.push({ delay: gap, event: { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: chunk } });
  }
  frames.push({ delay: gap, event: { type: 'response.output_item.done', output_index: 0, item: assistantItem(itemId, text) } });
  return frames;
}

const MARKDOWN_REPLY = [
  '## 标题与列表',
  '',
  '- **粗体** 与 *斜体* 与 `行内代码`',
  '- 第二项,长文本自动换行验证:' + '持续输出一段较长的中文文本用来验证消息卡在流式渲染过程中的换行与布局稳定性。'.repeat(2),
  '',
  '```go',
  'func main() {',
  '\tfmt.Println("hello, scripted api")',
  '}',
  '```',
  '',
  '| 列一 | 列二 |',
  '|---|---|',
  '| a | b |',
].join('\n');

const TASK_REPLY = [
  '好的,我已理解任务。以下是沉淀结果:',
  '',
  '<goder-task>',
  'name: 示例自动化任务',
  'description: 由 scripted-api 场景产出的演示任务,验证任务卡渲染与保存链路。',
  'prompt: 打开设置页,依次切换主题为亮色与暗色,各停留一秒后恢复跟随系统。',
  '</goder-task>',
].join('\n');

const SKILL_REPLY = [
  '任务已成功执行完毕,沉淀技能如下:',
  '',
  '<goder-skill>',
  'name: demo-scripted-skill',
  'description: scripted-api 产出的演示技能,验证技能保存卡渲染。',
  '---',
  '# 演示技能正文',
  '这是 SKILL.md 的示例内容。',
  '</goder-skill>',
].join('\n');

/** 场景生成的回合形状。 */
interface ScenarioGen {
  frames: ScriptFrame[];
  endStatus: ResponseResource['status'];
  /** true = 流上不发终态帧直接截断(终态已预写,等对账) */
  breakStream?: boolean;
  /** incomplete 终态的 grf_requests(审批/ask 暂停) */
  endIncomplete?: IncompleteDetails;
}

/** 按场景生成帧序列。 */
function scenarioFrames(name: ScenarioName, userText: string): ScenarioGen {
  switch (name) {
    case 'echo': {
      const reply = `收到:「${userText || '(空消息)'}」\n\n这是 scripted-api 的默认回声回复,用于零脚本验证发送与流式渲染。`;
      return { frames: textRoundFrames(reply), endStatus: 'completed' };
    }
    case 'markdown':
      return { frames: textRoundFrames(MARKDOWN_REPLY, 90), endStatus: 'completed' };
    case 'slow-stream': {
      const reply = '慢流场景:每 500ms 输出一帧,共六帧,用于过程态截图与「停止」按钮的即时反馈验证。';
      const itemId = 'msg_assistant_1';
      const frames: ScriptFrame[] = [
        { delay: 500, event: { type: 'response.output_item.added', output_index: 0, item: { ...assistantItem(itemId, ''), status: 'in_progress' } } },
      ];
      for (const chunk of splitChunks(reply, 5)) {
        frames.push({ delay: 500, event: { type: 'response.output_text.delta', item_id: itemId, delta: chunk } });
      }
      return { frames, endStatus: 'completed' };
    }
    case 'tool-call': {
      const callId = 'call_tool_1';
      const toolItem = (status: string, output?: string): OutputItem => ({
        type: 'grf:tool_call',
        id: `it_${callId}`,
        status,
        call_id: callId,
        name: 'bash',
        arguments: JSON.stringify({ command: 'echo OK' }),
        input: 'echo OK',
        ...(output !== undefined ? { output_text: output } : {}),
      });
      const frames: ScriptFrame[] = [
        { delay: 40, event: { type: 'grf:tool_call.args_delta', item_id: `it_${callId}`, kind: 'bash', delta: '{"command":"echo OK"}' } },
        { delay: 80, event: { type: 'grf:tool_call.in_progress', item: toolItem('running') } },
        { delay: 200, event: { type: 'grf:tool_call.completed', item: toolItem('completed', 'OK') } },
      ];
      frames.push(...textRoundFrames('工具执行完成,输出 `OK`。'));
      return { frames, endStatus: 'completed' };
    }
    case 'approval-pause':
    case 'ask-pause': {
      const isApproval = name === 'approval-pause';
      const callId = isApproval ? 'call_bash_1' : 'call_ask_1';
      const req = isApproval
        ? { call_id: callId, name: 'bash', kind: 'function' as const, arguments: JSON.stringify({ command: 'rm -rf /tmp/fake' }) }
        : {
            call_id: callId,
            name: 'ask_user_question',
            kind: 'question' as const,
            arguments: JSON.stringify({ id: 'q1', question: '示例提问:选择一个选项?', header: '示例', options: [{ label: '选项 A' }, { label: '选项 B' }], multi_select: false }),
          };
      const details: IncompleteDetails = { reason: 'grf:input_required', grf_requests: [req] };
      const frames: ScriptFrame[] = [];
      if (isApproval) {
        frames.push({ delay: 40, event: { type: 'grf:tool_call.args_delta', item_id: `it_${callId}`, kind: 'bash', delta: req.arguments } });
      }
      // 先物化交互卡,再以 incomplete 终态挂起会话(应答回传后走默认场景续跑)
      frames.push({ delay: 80, event: { type: 'grf:input_required', grf_input: details } });
      return { frames, endStatus: 'incomplete', endIncomplete: details };
    }
    case 'stream-break': {
      // 三帧后静默截断(无终态帧):前端对账恢复靠 retrieveResponse 命中预写终态
      const reply = '断流场景:这段回复会在中途被截断,恢复链路应经对账拿回完整终态。';
      const itemId = 'msg_assistant_1';
      const frames: ScriptFrame[] = [
        { delay: 40, event: { type: 'response.output_item.added', output_index: 0, item: { ...assistantItem(itemId, ''), status: 'in_progress' } } },
        { delay: 60, event: { type: 'response.output_text.delta', item_id: itemId, delta: reply.slice(0, 8) } },
        { delay: 60, event: { type: 'response.output_text.delta', item_id: itemId, delta: reply.slice(8, 16) } },
      ];
      return { frames, endStatus: 'completed', breakStream: true };
    }
    case 'server-fail-frame': {
      // 流内 response.failed 终态帧(错误卡渲染);server-error 的非 2xx 在发送分支处理
      return { frames: [], endStatus: 'failed' };
    }
    case 'server-error':
      // 非 2xx 由 handleSend 提前拦截(本次 5xx 后回落 echo),此处仅为类型穷尽
      return { frames: [], endStatus: 'failed' };
    case 'task-block':
      return { frames: textRoundFrames(TASK_REPLY, 80), endStatus: 'completed' };
    case 'skill-block':
      return { frames: textRoundFrames(SKILL_REPLY, 80), endStatus: 'completed' };
    case 'notice-todos': {
      const todos = JSON.stringify([
        { content: '解析任务要求', status: 'completed' },
        { content: '执行主流程', status: 'in_progress' },
        { content: '沉淀结果', status: 'pending' },
      ]);
      const frames: ScriptFrame[] = [
        { delay: 40, event: { type: 'grf:notice', kind: 'todos', detail: todos } },
        { delay: 60, event: { type: 'grf:notice', kind: 'goal', detail: 'create_goal 演示目标' } },
        { delay: 60, event: { type: 'grf:notice', kind: 'phase', detail: '执行阶段一' } },
      ];
      frames.push(...textRoundFrames('目标与任务清单已通过 notice 事件下发。'));
      return { frames, endStatus: 'completed' };
    }
  }
}

// ---------- ScriptedApi ----------

export class ScriptedApi {
  private convs = new Map<string, FakeConv>();
  /** respId → 所属会话(链定位:previous_response_id → conversation) */
  private respOwner = new Map<string, string>();
  /** respId → 终态资源(retrieveResponse/断流对账用) */
  private respFinal = new Map<string, ResponseResource>();
  private runningRounds = new Map<string, RunningRound>();
  private nextScripts: { matcher: SendMatcher; frames: ScriptFrame[] }[] = [];
  private convScripts = new Map<string, ScriptFrame[][]>();
  private failRules: { matcher: SendMatcher; spec: FailureSpec; used: boolean }[] = [];
  private scenarioName: ScenarioName = 'echo';
  private records: RecordedRequest[] = [];
  private agentStore: Record<string, unknown> = {};

  constructor(opts?: { conversations?: SeedConversation[] }) {
    for (const seed of opts?.conversations ?? []) this.seedConversation(seed);
  }

  // ---------- 控制面(测试侧调用) ----------

  /** 切换默认场景(未脚本化的发送走它)。 */
  scenario(name: ScenarioName): this {
    this.scenarioName = name;
    return this;
  }

  /** 添加种子会话,返回生成的会话 id。 */
  seedConversation(seed: SeedConversation): string {
    const id = seed.id ?? `fc_${randId()}`;
    this.convs.set(id, {
      id,
      createdAt: new Date().toISOString(),
      workspace: seed.workspace ?? '/tmp/fake-workspace',
      archived: false,
      history: seed.history ?? [],
      lastResponseId: seed.lastResponseId,
      running: false,
      paused: false,
      turns: 0,
    });
    if (seed.lastResponseId) this.respOwner.set(seed.lastResponseId, id);
    return id;
  }

  /** 一次性脚本:下一次匹配的发送按 frames 播放(播完移除)。 */
  scriptNext(matcher: SendMatcher, frames: ScriptFrame[]): this {
    this.nextScripts.push({ matcher, frames });
    return this;
  }

  /** 会话定向脚本队列:该会话接下来每次发送依次消费一组 frames。 */
  scriptConversation(convId: string, frames: ScriptFrame[]): this {
    const q = this.convScripts.get(convId) ?? [];
    q.push(frames);
    this.convScripts.set(convId, q);
    return this;
  }

  /** 一次性错误注入:下一次匹配的发送返回非 2xx JSON error。 */
  failNext(matcher: SendMatcher, spec: FailureSpec = { status: 500 }): this {
    this.failRules.push({ matcher, spec, used: false });
    return this;
  }

  /** 已记录的请求(滚动 500 条)。 */
  requests(): readonly RecordedRequest[] {
    return this.records;
  }

  /** 内部状态快照(断言/调试用;不承诺字段稳定)。 */
  state(): ScriptedApiState {
    return {
      conversations: [...this.convs.values()].map((c) => ({
        id: c.id,
        lastResponseId: c.lastResponseId,
        running: c.running,
        paused: c.paused,
        turns: c.turns,
      })),
    };
  }

  /** 标准签名装载:setApiFetch(api.asFetch())。 */
  asFetch(): typeof fetch {
    return (input, init) => this.handle(input, init);
  }

  // ---------- fetch 分发 ----------

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === 'object' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase();
    const path = extractV1Path(url);
    let body: unknown;
    const rawBody = init?.body ?? (typeof input === 'object' && !(input instanceof URL) ? input.body : undefined);
    if (typeof rawBody === 'string' && rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    this.records.push({ method, path, body, at: Date.now() });
    if (this.records.length > 500) this.records.shift();

    // 请求级中断(看门狗/取消路径):尊重调用方 signal
    if (init?.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

    // ---- POST /v1/responses:SSE 流 ----
    if (method === 'POST' && path === '/responses') {
      return this.handleSend(body as Record<string, unknown> | undefined, init);
    }

    // ---- 会话 ----
    if (method === 'GET' && path === '/health') return jsonResponse({});
    if (method === 'GET' && path === '/conversations') {
      const data: Conversation[] = [...this.convs.values()]
        .filter((c) => !c.archived)
        .map((c) => ({
          id: c.id,
          object: 'conversation',
          created_at: c.createdAt,
          workspace: c.workspace,
          ...(c.lastResponseId ? { last_response_id: c.lastResponseId } : {}),
        }));
      return jsonResponse({ data });
    }
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/conversations\/([^/]+)$/))) {
      const conv = this.convs.get(m[1]);
      if (method === 'GET') {
        if (!conv) return errorResponse(404, 'not_found', '会话不存在');
        const detail: ConversationDetail = {
          id: conv.id,
          created_at: conv.createdAt,
          workspace: conv.workspace,
          last_response_id: conv.lastResponseId ?? '',
          paused: conv.paused,
          running: conv.running,
          stats: { llm: { Rounds: conv.turns, LLMTime: 0, FirstTokenAvg: 0, GenerationTime: 0, PromptTokens: 100, CompletionTokens: 50, CachedTokens: 0, UsageSeen: true, CachePct: 0, LastPromptTokens: 80, LastCompletionTokens: 40 }, tools: { calls: 0, time_ms: 0 } },
        };
        return jsonResponse(detail);
      }
      if (method === 'DELETE') {
        if (conv) conv.archived = true;
        return new Response(null, { status: 204 });
      }
    }
    if ((m = path.match(/^\/conversations\/([^/]+)\/policy$/)) && method === 'PUT') {
      const policy = (body as { policy?: string } | undefined)?.policy ?? 'write-workspace';
      return jsonResponse({ policy });
    }
    if ((m = path.match(/^\/conversations\/([^/]+)\/items$/)) && method === 'GET') {
      const conv = this.convs.get(m[1]);
      if (!conv) return errorResponse(404, 'not_found', '会话不存在');
      return jsonResponse({ data: conv.history });
    }

    // ---- 回合 ----
    if ((m = path.match(/^\/responses\/([^/]+)\/cancel$/)) && method === 'POST') {
      return this.handleCancel(m[1]);
    }
    if (path === '/responses/compact' && method === 'POST') {
      return jsonResponse({
        id: `resp_${randId()}`,
        object: 'response.compaction',
        output: [assistantItem('msg_compact', '[压缩] 之前的对话已压缩为摘要。')],
        created_at: Math.floor(Date.now() / 1000),
        usage: null,
      });
    }
    if ((m = path.match(/^\/responses\/([^/]+)$/)) && method === 'GET') {
      const final = this.respFinal.get(m[1]);
      if (!final) return errorResponse(404, 'not_found', '回合不存在');
      return jsonResponse(final);
    }

    // ---- /v1/agent/*(设置分区数据源) ----
    if (path.startsWith('/agent/')) return this.handleAgent(method, path.slice('/agent/'.length), body);

    return errorResponse(404, 'not_found', `scripted-api 未实现:${method} ${path}`);
  }

  // ---------- 发送 → SSE 流 ----------

  private handleSend(body: Record<string, unknown> | undefined, init?: RequestInit): Response {
    const userText = extractUserText(body?.input);
    const failure = this.takeFailure(userText);
    if (failure) return errorResponse(failure.status ?? 500, failure.code ?? 'internal_error', failure.message ?? 'scripted-api 注入的服务端错误');

    // 定位/新建会话:previous_response_id 链回溯;草稿(无 previous)新建
    const previous = typeof body?.previous_response_id === 'string' ? (body!.previous_response_id as string) : undefined;
    let conv: FakeConv | undefined = previous ? this.convs.get(this.respOwner.get(previous) ?? '') : undefined;
    const isNew = !conv;
    if (!conv) {
      const id = `fc_${randId()}`;
      conv = {
        id,
        createdAt: new Date().toISOString(),
        workspace: '/tmp/fake-workspace',
        archived: false,
        history: [],
        running: false,
        paused: false,
        turns: 0,
      };
      this.convs.set(id, conv);
    }

    // grf:history 前缀覆写(编辑重发)
    if (Array.isArray(body?.['grf:history'])) conv.history = body!['grf:history'] as HistMessage[];
    // 用户侧输入入史(user message / 审批应答 / 工具结果各记其形)
    appendInputToHistory(conv, body?.input);

    // 脚本选择:一次性 → 会话队列 → 场景默认
    let frames: ScriptFrame[] | undefined;
    const nextIdx = this.nextScripts.findIndex((s) => matchSend(s.matcher, userText));
    if (nextIdx >= 0) frames = this.nextScripts.splice(nextIdx, 1)[0].frames;
    if (!frames) {
      const q = this.convScripts.get(conv.id);
      if (q?.length) frames = q.shift();
    }
    if (!frames && this.scenarioName === 'server-error') {
      // 场景级失败:本次非 2xx,之后自动回落 echo
      this.scenarioName = 'echo';
      return errorResponse(502, 'api_error', 'scripted-api server-error 场景:上游暂不可用');
    }
    // 恢复请求(审批应答/提问应答/工具结果补交,无新 user 消息):暂停类
    // 场景回落 echo —— 真实语义是「应答后续跑完成」,再次暂停会死循环。
    let scenarioName = this.scenarioName;
    if (
      (scenarioName === 'approval-pause' || scenarioName === 'ask-pause') &&
      Array.isArray(body?.input) &&
      (body!.input as { type?: string }[]).every((it) => it?.type !== 'message')
    ) {
      scenarioName = 'echo';
    }
    const gen: ScenarioGen = frames
      ? { frames, endStatus: 'completed' }
      : scenarioFrames(scenarioName, userText);
    const endIncomplete = gen.endIncomplete;

    const respId = `resp_${randId()}`;
    const model = typeof body?.model === 'string' ? (body!.model as string) : 'fake-model';
    conv.running = true;
    conv.paused = false;
    this.respOwner.set(respId, conv.id);
    const round: RunningRound = { conv, respId, cancelRequested: false };
    this.runningRounds.set(respId, round);

    // 终态资源预写(断流对账/取消返回共用);审批暂停给 incomplete_details
    const finalResource = (): ResponseResource => {
      const text = collectAssistantText(gen.frames);
      const output: OutputItem[] = [];
      collectToolItems(gen.frames, output);
      if (text) output.push(assistantItem('msg_assistant_1', text));
      const usage = usageFor(userText, text);
      return {
        id: respId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        completed_at: gen.endStatus === 'completed' ? Math.floor(Date.now() / 1000) : null,
        status: gen.endStatus,
        ...(gen.endStatus === 'failed' ? { error: { type: 'api_error', code: 500, message: 'scripted-api 注入的回合失败', param: null } } : {}),
        ...(endIncomplete ? { incomplete_details: endIncomplete } : {}),
        model,
        ...(previous ? { previous_response_id: previous } : {}),
        output,
        usage,
        'grf:session_id': conv!.id,
      };
    };

    // 会话落定:终态写入历史、翻转运行标志(流播完/取消时调用)
    const settle = (status: ResponseResource['status'], resource: ResponseResource): void => {
      conv!.running = false;
      conv!.paused = status === 'incomplete';
      conv!.turns += 1;
      if (status !== 'cancelled') conv!.lastResponseId = respId;
      this.respFinal.set(respId, resource);
      if (status === 'completed') {
        const text = collectAssistantText(gen.frames);
        if (text) conv!.history.push({ role: 'assistant', content: text });
        for (const item of resource.output) {
          if ((item.type === 'grf:tool_call' || item.type === 'function_call') && item.call_id) {
            conv!.history.push({
              role: 'assistant',
              content: '',
              tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name ?? 'bash', arguments: item.arguments ?? '{}' } }],
            });
            conv!.history.push({ role: 'tool', tool_call_id: item.call_id, name: item.name ?? 'bash', content: item.output_text ?? '' });
          }
        }
      } else if (status === 'cancelled') {
        const text = collectAssistantText(gen.frames);
        if (text) conv!.history.push({ role: 'assistant', content: text });
      }
      this.runningRounds.delete(respId);
    };

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const enc = new TextEncoder();
        const send = (frame: ScriptFrame | { event: SSEEvent }): void => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(frame.event)}\n\n`));
        };
        const aborted = () => init?.signal?.aborted === true;
        try {
          for (const f of gen.frames) {
            if (aborted() || round.cancelRequested) break;
            if (f.delay) await sleepAbortable(f.delay, init?.signal);
            if (aborted() || round.cancelRequested) break;
            send({ ...f, event: fillFrame(f.event, respId, model, conv!.id) });
          }
          if (round.cancelRequested && !aborted()) {
            // cancel 端点已受理:写 cancelled 终态帧(前端中断对账的依据)
            const cancelled = terminalEvent(respId, model, conv!.id, 'cancelled', collectAssistantText(gen.frames));
            send({ event: cancelled });
            settle('cancelled', { ...finalResource(), status: 'cancelled', completed_at: null });
          } else if (gen.breakStream && !aborted()) {
            // 断流场景:不写终态帧直接关流;终态已预写,等 retrieveResponse 对账
            settle('completed', finalResource());
          } else if (!aborted()) {
            const last = gen.frames.at(-1)?.event;
            const lastTerminal = last && /^response\.(completed|failed|cancelled|incomplete)$/.test(last.type) ? last : undefined;
            if (lastTerminal?.response?.status) {
              // 脚本自带终态帧:以脚本为准,不重复补发
              const status = lastTerminal.response.status;
              settle(status, { ...finalResource(), ...lastTerminal.response });
            } else {
              const ev = terminalEvent(respId, model, conv!.id, gen.endStatus, collectAssistantText(gen.frames), endIncomplete, gen.frames);
              send({ event: ev });
              settle(gen.endStatus, { ...finalResource() });
            }
          } else {
            // 本地 abort(前端停止双路之一):连接已断写不进帧,但服务端语义是
            // 「回合已跑完」—— 按当前进度落定,cancel 端点对账/retrieveResponse
            // 均能命中终态,会话 running 归假,前端 syncRunningState 才能收口。
            if (round.cancelRequested) settle('cancelled', { ...finalResource(), status: 'cancelled', completed_at: null });
            else settle('completed', finalResource());
          }
        } catch {
          /* 流取消 */
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        /* ReadableStream 被取消:reader 端已断,start 循环靠 abort/cancel 标志收口 */
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
    });
  }

  private handleCancel(respId: string): Response {
    const round = this.runningRounds.get(respId);
    if (round) {
      round.cancelRequested = true;
      const resource: ResponseResource = {
        id: respId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'cancelled',
        model: 'fake-model',
        output: [],
        usage: null,
        'grf:session_id': round.conv.id,
      };
      return jsonResponse(resource);
    }
    const final = this.respFinal.get(respId);
    if (final) return jsonResponse(final);
    return errorResponse(404, 'not_found', '回合不存在');
  }

  // ---------- /v1/agent/* ----------

  private handleAgent(method: string, rest: string, body: unknown): Response {
    const store = this.agentStore;
    const seedModels = (): Record<string, unknown> => ({
      path: '/tmp/fake-grf-home/settings.json',
      providers: [
        { name: 'fake', type: '', baseUrl: 'https://fake.invalid/v1', apiKey: '', hasKey: true, models: ['fake/chat', 'fake/pro'] },
      ],
      default: 'fake/chat',
      writable: true,
      maxSteps: 50,
      mouse: null,
      policy: 'write-workspace',
    });
    const seedPlugins = (): Record<string, unknown> => ({
      path: '/tmp/fake-grf-home/settings.json',
      dir: '~/.grf/plugins',
      explicit: false,
      plugins: [],
      discovered: ['sample-plugin'],
      writable: true,
    });
    const seedSkills = (): Record<string, unknown> => ({
      path: '/tmp/fake-grf-home/../skills',
      skills: [
        { name: 'goder-auto', description: '自动化任务创作指南(内置)', path: '/skills/goder-auto/SKILL.md', disabled: false },
        { name: 'demo-skill', description: '演示技能', path: '/skills/demo-skill/SKILL.md', disabled: false },
      ],
      writable: true,
    });

    if (rest === 'models' && method === 'GET') return jsonResponse(store.models ?? seedModels());
    if (rest === 'models' && method === 'PUT') {
      store.models = body;
      return jsonResponse({});
    }
    if (rest === 'models/detect' && method === 'POST') {
      return jsonResponse({ modelsRich: [{ id: 'fake/detected-chat', ctxLen: 128000 }, { id: 'fake/detected-pro', ctxLen: 256000 }] });
    }
    if (rest === 'plugins' && method === 'GET') return jsonResponse(store.plugins ?? seedPlugins());
    if (rest === 'plugins' && method === 'PUT') {
      store.plugins = body;
      return jsonResponse({});
    }
    if (rest === 'skills' && method === 'GET') return jsonResponse(store.skills ?? seedSkills());
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\/skills\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]);
      if (method === 'GET') return jsonResponse({ content: `# ${name}\n\n演示技能正文(scripted-api 生成)。` });
      if (method === 'PUT' || method === 'DELETE') return jsonResponse({});
    }
    if ((m = rest.match(/^\/skills\/([^/]+)\/enabled$/)) && method === 'POST') return jsonResponse({});
    return errorResponse(404, 'not_found', `scripted-api 未实现 agent 端点:${method} ${rest}`);
  }

  private takeFailure(userText: string): FailureSpec | undefined {
    const idx = this.failRules.findIndex((r) => !r.used && matchSend(r.matcher, userText));
    if (idx < 0) return undefined;
    const [rule] = this.failRules.splice(idx, 1);
    return rule.spec;
  }
}

/** 便捷工厂(链式配置)。 */
export function createScriptedApi(opts?: { conversations?: SeedConversation[] }): ScriptedApi {
  return new ScriptedApi(opts);
}

// ---------- 帮助函数 ----------

function randId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** 从任意 URL 形态提取 /v1 起的路径(对 baseUrl 前缀形态免疫)。 */
function extractV1Path(url: string): string {
  const u = new URL(url, 'http://scripted.invalid');
  const m = u.pathname.match(/\/v1(\/.*)$/);
  return m ? m[1] : u.pathname;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: code } }), { status, headers: { 'Content-Type': 'application/json' } });
}

function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function matchSend(matcher: SendMatcher, userText: string): boolean {
  if (matcher.inputIncludes !== undefined && !userText.includes(matcher.inputIncludes)) return false;
  return true;
}

/** input(字符串或 InputItem[])→ 用户文本(匹配与显示用)。 */
function extractUserText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const it of input as { type?: string; role?: string; content?: ContentPart[] }[]) {
    if (it?.type === 'message' && it.role === 'user') {
      for (const p of it.content ?? []) parts.push(p.text ?? '');
    }
  }
  return parts.join('\n');
}

/** 把发送 input 追加进会话历史(user 消息 / 审批应答 / 工具结果)。 */
function appendInputToHistory(conv: FakeConv, input: unknown): void {
  if (typeof input === 'string' && input.trim()) {
    conv.history.push({ role: 'user', content: input });
    return;
  }
  if (!Array.isArray(input)) return;
  for (const it of input as Record<string, unknown>[]) {
    if (it?.type === 'message' && (it as { role?: string }).role === 'user') {
      const text = ((it as { content?: ContentPart[] }).content ?? []).map((p) => p.text ?? '').join('');
      if (text) conv.history.push({ role: 'user', content: text });
    } else if (it?.type === 'grf:input_result') {
      const r = it as { call_id: string; approved?: boolean; answers?: Record<string, unknown>; feedback?: string; dismiss?: boolean };
      const summary = r.dismiss
        ? '[dismissed]'
        : r.approved === true
          ? '[approved]'
          : r.approved === false
            ? '[denied]'
            : JSON.stringify(r.answers ?? {});
      conv.history.push({ role: 'tool', tool_call_id: r.call_id, name: 'input_result', content: summary });
    } else if (it?.type === 'function_call_output') {
      const r = it as { call_id: string; output: string };
      conv.history.push({ role: 'tool', tool_call_id: r.call_id, name: 'tool', content: r.output });
    }
  }
}

/** 补齐帧的公共字段(response/id/序列号),脚本只写业务字段。 */
function fillFrame(ev: Partial<SSEEvent> & { type: string }, respId: string, model: string, convId: string): SSEEvent {
  const filled: SSEEvent = {
    sequence_number: 0,
    ...ev,
    response: {
      id: respId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress',
      model,
      output: [],
      ...(ev.response ?? {}),
      'grf:session_id': convId,
    },
  } as SSEEvent;
  return filled;
}

/** 终态事件(response.completed/failed/cancelled/incomplete)。 */
function terminalEvent(
  respId: string,
  model: string,
  convId: string,
  status: ResponseResource['status'],
  text: string,
  incomplete?: IncompleteDetails,
  frames?: ScriptFrame[],
): SSEEvent {
  const output: OutputItem[] = [];
  if (frames) collectToolItems(frames, output);
  if (text) output.push(assistantItem('msg_assistant_1', text));
  const usage = usageFor('', text);
  return {
    type: `response.${status === 'incomplete' ? 'incomplete' : status}`,
    sequence_number: 9999,
    response: {
      id: respId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      completed_at: status === 'completed' ? Math.floor(Date.now() / 1000) : null,
      status,
      ...(status === 'failed' ? { error: { type: 'api_error', code: 500, message: 'scripted-api 注入的回合失败', param: null } } : {}),
      ...(incomplete ? { incomplete_details: incomplete } : {}),
      model,
      output,
      usage,
      'grf:session_id': convId,
    },
  };
}

/** 从脚本帧收集 assistant 最终文本(delta 拼接)。 */
function collectAssistantText(frames: ScriptFrame[]): string {
  let text = '';
  for (const f of frames) {
    if (f.event.type === 'response.output_text.delta' && f.event.delta) text += f.event.delta;
    if (f.event.type === 'response.output_item.done' && f.event.item?.type === 'message') {
      const full = (f.event.item.content ?? []).map((p) => p.text ?? '').join('');
      if (full) text = full;
    }
  }
  return text;
}

/** 从脚本帧收集工具 item(终态资源 output 用)。 */
function collectToolItems(frames: ScriptFrame[], out: OutputItem[]): void {
  for (const f of frames) {
    const item = f.event.item;
    if (item && (f.event.type === 'grf:tool_call.completed' || f.event.type === 'grf:tool_call.in_progress')) {
      if (item.call_id && f.event.type === 'grf:tool_call.completed') out.push(item);
    }
  }
}

function usageFor(input: string, output: string): Usage {
  return {
    input_tokens: 40 + Math.ceil(input.length / 4),
    output_tokens: Math.max(1, Math.ceil(output.length / 4)),
    total_tokens: 40 + Math.ceil(input.length / 4) + Math.max(1, Math.ceil(output.length / 4)),
  };
}
