// chat-model.ts — 聊天流统一数据模型:live SSE 事件与恢复的历史都归一为
// ChatItem 列表,面板只面对这一种形状。
import type {
  AskQuestion,
  HistMessage,
  HistPart,
  IncompleteRequest,
  LLMStats,
  OutputItem,
  SSEEvent,
  TodoItem,
  Usage,
} from '../api/types';
import { friendlyError } from '../../util/fmt';

export type ToolStatus = 'running' | 'done' | 'error' | 'denied';

interface Base {
  id: string;
}

export interface UserItem extends Base {
  kind: 'user';
  text: string;
  images?: string[]; // data URL
}

export interface AssistantItem extends Base {
  kind: 'assistant';
  text: string;
  streaming: boolean;
}

export interface ReasoningItem extends Base {
  kind: 'reasoning';
  text: string;
  streaming: boolean;
  /** 思考起止时刻(live 流式才有;用于完成后显示"思考 · 时长") */
  startedAt?: number;
  endedAt?: number;
}

export interface ToolItem extends Base {
  kind: 'tool';
  callId: string;
  name: string;
  args: string;
  status: ToolStatus;
  output: string;
  err: string;
  agentId: string;
  label: string;
  startedAt: number;
  endedAt?: number;
}

export interface NoticeItem extends Base {
  kind: 'notice';
  noticeKind: string; // todos | goal | plan | phase | notice | result | done
  detail: string;
}

export interface AskItem extends Base {
  kind: 'ask';
  callId: string;
  questions: AskQuestion[];
  state: 'pending' | 'answered' | 'dismissed';
  answers?: Record<string, unknown>;
}

export interface ApprovalItem extends Base {
  kind: 'approval';
  callId: string;
  name: string;
  args: string;
  state: 'pending' | 'approved' | 'rejected';
  feedback?: string;
}

export interface ErrorItem extends Base {
  kind: 'error';
  text: string;
}

export interface StatusItem extends Base {
  kind: 'status';
  text: string;
}

export type ChatItem =
  | UserItem
  | AssistantItem
  | ReasoningItem
  | ToolItem
  | NoticeItem
  | AskItem
  | ApprovalItem
  | ErrorItem
  | StatusItem;

export interface SessionRuntime {
  items: ChatItem[];
  running: boolean;
  pendingRequests: IncompleteRequest[];
  lastResponseId?: string;
  model?: string;
  usage?: Usage | null;
  /** 会话累计统计(getConversation 的 stats;速度/缓存命中率等,圆环 tooltip 用) */
  stats?: { llm: LLMStats; tools: { calls: number; time_ms: number } };
  /** 当前生效的访问策略(getConversation 回报;草稿/旧 server 无值) */
  policy?: string;
  todos: TodoItem[] | null;
  loaded: boolean;
  error?: string;
  /** 当前回合的 response id(给 item id 加限定,防跨回合 it_1 碰撞) */
  curRespId?: string;
  /** 所属会话 id(工具耗时本地持久化用;线格式历史不带时间戳) */
  sid?: string;
}

export function newRuntime(): SessionRuntime {
  return { items: [], running: false, pendingRequests: [], todos: null, loaded: false };
}

// ---------- 工具耗时本地持久化 ----------
// 会话历史(线格式 llm.Message)不含时间戳,重开 App 后耗时无法从服务端
// 恢复。工具结束时就把 startedAt/endedAt 按 sid+callId 记进 localStorage,
// 历史恢复时回填到工具卡。
const TOOL_DUR_KEY = 'grf-ui:tool-durs';
/** 条目上限(超出丢最旧,防无限膨胀) */
const TOOL_DUR_MAX = 4000;

function readToolDurs(): Record<string, [number, number]> {
  try {
    const raw = localStorage.getItem(TOOL_DUR_KEY);
    return raw ? (JSON.parse(raw) as Record<string, [number, number]>) : {};
  } catch {
    return {};
  }
}

export function saveToolDur(sid: string | undefined, callId: string, startedAt: number, endedAt: number): void {
  if (!sid || !callId || !startedAt || !endedAt) return;
  try {
    const all = readToolDurs();
    all[`${sid}\u0000${callId}`] = [startedAt, endedAt];
    const keys = Object.keys(all);
    if (keys.length > TOOL_DUR_MAX) {
      for (const k of keys.slice(0, keys.length - TOOL_DUR_MAX)) delete all[k];
    }
    localStorage.setItem(TOOL_DUR_KEY, JSON.stringify(all));
  } catch {
    /* localStorage 不可用(隐私模式等):放弃持久化,仅当次有效 */
  }
}

// applySavedDurs 历史恢复后回填本地记录的工具耗时(不可变替换,触发渲染)。
export function applySavedDurs(sid: string, items: ChatItem[]): void {
  const all = readToolDurs();
  const prefix = `${sid}\u0000`;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== 'tool' || !it.callId) continue;
    const dur = all[prefix + it.callId];
    if (dur) items[i] = { ...it, startedAt: dur[0], endedAt: dur[1] };
  }
}

let seq = 0;
export function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

function textOfContent(content: string | HistPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

function imagesOfContent(content: string | HistPart[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url ?? '');
}

// historyToItems 把 GET /v1/conversations/{id}/items 的 llm.Message 线格式
// 转为 ChatItem 列表(历史恢复用)。tool 消息回填到前一条工具卡片的输出。
export function historyToItems(hist: HistMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  const byCallId = new Map<string, ToolItem>();
  for (const msg of hist) {
    switch (msg.role) {
      case 'system':
        break;
      case 'user': {
        const text = textOfContent(msg.content);
        const images = imagesOfContent(msg.content);
        if (text || images.length) {
          items.push({ kind: 'user', id: genId('u'), text, images: images.length ? images : undefined });
        }
        break;
      }
      case 'assistant': {
        const text = textOfContent(msg.content);
        if (text.trim()) items.push({ kind: 'assistant', id: genId('a'), text, streaming: false });
        for (const tc of msg.tool_calls ?? []) {
          const tool: ToolItem = {
            kind: 'tool',
            id: genId('t'),
            callId: tc.id,
            name: tc.function.name,
            args: tc.function.arguments,
            status: 'done',
            output: '',
            err: '',
            agentId: '',
            label: '',
            startedAt: 0,
          };
          byCallId.set(tc.id, tool);
          items.push(tool);
        }
        break;
      }
      case 'tool': {
        const target = msg.tool_call_id ? byCallId.get(msg.tool_call_id) : undefined;
        const out = textOfContent(msg.content);
        if (target) {
          target.output = out;
          if (/^\[error\]/i.test(out.trim())) target.status = 'error';
        } else if (out.trim()) {
          items.push({ kind: 'status', id: genId('s'), text: `${msg.name ?? 'tool'}: ${out}` });
        }
        break;
      }
    }
  }
  return items;
}

// applyEvent 把一条 SSE 事件应用到运行时(就地变更,由调用方触发 notify)。
// 返回 true 表示产生了可见变化。
export function applyEvent(rt: SessionRuntime, ev: SSEEvent): boolean {
  let changed = false;
  const items = rt.items;

  if (ev.response?.id) rt.curRespId = ev.response.id;
  if (ev.response?.['grf:session_id'] && ev.response.model) {
    rt.model = ev.response.model;
  }
  // 文本类 item 以 `${respId}/${itemId}` 寻址,跨回合的 it_1 不互串。
  const qid = (id: string | undefined): string | undefined =>
    id ? `${rt.curRespId ?? 'pre'}\u0000${id}` : undefined;

  switch (ev.type) {
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const item = ev.item;
      if (!item) break;
      changed = upsertOutputItem(rt, item, ev.type === 'response.output_item.done') || changed;
      break;
    }
    case 'response.output_text.delta': {
      const t = findTextTarget(items, qid(ev.item_id));
      if (t && ev.delta) {
        t.text += ev.delta;
        t.streaming = true;
        changed = true;
      }
      break;
    }
    case 'response.reasoning_summary_text.delta': {
      const t = findTextTarget(items, qid(ev.item_id), true);
      if (t && ev.delta) {
        t.text += ev.delta;
        t.streaming = true;
        changed = true;
      }
      break;
    }
    case 'grf:tool_call.args_delta': {
      // 模型生成工具参数的流式增量(参数一流出就到,工具尚未执行):以
      // bridge item id 寻址工具卡,没有则建卡——edit/write 的 +nn/-nn
      // 得以随模型输出实时跳动。args 是残缺 JSON,统计端容错解析。
      if (!ev.item_id) break;
      const qid = `${rt.curRespId ?? 'pre'}\u0000${ev.item_id}`;
      const delta = ev.delta ?? '';
      const idx = items.findIndex((i) => i.kind === 'tool' && i.id === qid);
      if (idx >= 0) {
        const t = items[idx] as ToolItem;
        // 不可变替换:工具卡按引用比较属性,原地改不会重渲染。
        // 头片(name 先到、无参数)建卡后,后续事件补齐工具名。
        items[idx] = {
          ...t,
          args: t.args + delta,
          ...(ev.kind && !t.name ? { name: ev.kind } : {}),
        };
      } else {
        items.push({
          kind: 'tool',
          id: qid,
          callId: '',
          name: ev.kind ?? '',
          args: delta,
          status: 'running',
          output: '',
          err: '',
          agentId: '',
          label: '',
          startedAt: Date.now(),
        });
      }
      changed = true;
      break;
    }
    case 'grf:tool_call.in_progress':
    case 'grf:tool_call.completed':
    case 'grf:tool_call.failed':
    case 'grf:tool_call.denied': {
      const item = ev.item;
      const status: ToolStatus | undefined =
        ev.type === 'grf:tool_call.completed'
          ? 'done'
          : ev.type === 'grf:tool_call.failed'
            ? 'error'
            : ev.type === 'grf:tool_call.denied'
              ? 'denied'
              : undefined;
      if (item?.call_id) {
        changed = upsertToolItem(rt, item, status) || changed;
      }
      break;
    }
    case 'grf:notice': {
      const kind = ev.kind ?? 'notice';
      if (kind === 'todos') {
        try {
          rt.todos = JSON.parse(ev.detail ?? '[]') as TodoItem[];
        } catch {
          /* 保持原状 */
        }
        changed = true;
        break;
      }
      // tool/result 通知是"工具名 + 原始参数/结果"的调试行:工具调用已有
      // 专门的一行展示,不再重复;空明细的流程标记(done)也无信息量。
      const detail = (ev.detail ?? '').trim();
      if (kind === 'tool' || kind === 'result' || !detail) break;
      items.push({ kind: 'notice', id: genId('n'), noticeKind: kind, detail });
      changed = true;
      break;
    }
    case 'grf:input_required': {
      // 与 response.incomplete 携带同一份 grf_requests,先到先物化。
      if (ev.grf_input?.reason === 'grf:input_required' && ev.grf_input.grf_requests?.length) {
        rt.pendingRequests = ev.grf_input.grf_requests;
        for (const req of rt.pendingRequests) {
          changed = materializeRequest(rt, req) || changed;
        }
      }
      break;
    }
    case 'response.completed':
    case 'response.failed':
    case 'response.cancelled': {
      const r = ev.response;
      if (!r) break;
      if (r.usage) rt.usage = r.usage;
      if (r.status === 'failed' && r.error) {
        items.push({ kind: 'error', id: genId('e'), text: friendlyError(r.error.message) });
      }
      if (r.status === 'cancelled') {
        items.push({ kind: 'status', id: genId('s'), text: '已中断' });
      }
      changed = true;
      break;
    }
    case 'response.incomplete': {
      const r = ev.response;
      if (!r) break;
      if (r.usage) rt.usage = r.usage;
      if (r.incomplete_details?.reason === 'grf:input_required') {
        rt.pendingRequests = r.incomplete_details.grf_requests ?? [];
        for (const req of rt.pendingRequests) {
          changed = materializeRequest(rt, req) || changed;
        }
      } else {
        items.push({
          kind: 'status',
          id: genId('s'),
          text: `回合未完成:${r.incomplete_details?.reason ?? '未知原因'}`,
        });
      }
      changed = true;
      break;
    }
    default:
      break;
  }

  // 结束流式标记。
  if (
    (ev.type === 'response.completed' ||
      ev.type === 'response.failed' ||
      ev.type === 'response.cancelled' ||
      ev.type === 'response.incomplete') &&
    ev.response
  ) {
    for (const i of items) {
      if ((i.kind === 'assistant' || i.kind === 'reasoning') && i.streaming) {
        i.streaming = false;
        if (i.kind === 'reasoning' && i.startedAt && !i.endedAt) i.endedAt = Date.now();
        changed = true;
      }
    }
    // 失败/中断的回合:没收尾的运行中工具卡收口(参数流式建了卡但工具
    // 未及执行,或执行中途被打断),避免永远转圈。暂停(incomplete)不收:
    // 交互中的卡片等应答续跑。
    if (ev.type === 'response.failed' || ev.type === 'response.cancelled') {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'tool' && it.status === 'running') {
          items[i] = { ...it, status: 'error', err: it.err || '回合已中断', endedAt: Date.now() };
          changed = true;
        }
      }
    }
    rt.lastResponseId = ev.response.id;
  }
  return changed;
}

// materializeRequest 把暂停的交互请求物化为可操作卡片(ask/approval)。
export function materializeRequest(rt: SessionRuntime, req: IncompleteRequest): boolean {
  const existing = rt.items.find(
    (i): i is AskItem | ApprovalItem =>
      (i.kind === 'ask' || i.kind === 'approval') && i.callId === req.call_id,
  );
  if (existing) {
    // 已有卡片:恢复 pending 状态(server 重启后恢复暂停回合的场景)。
    // 不可变替换,否则卡片元素按引用比较属性、看不到状态回退。
    const idx = rt.items.indexOf(existing);
    rt.items[idx] = { ...existing, state: 'pending' };
    return true;
  }
  if (req.kind === 'question' && req.name === 'ask_user_question') {
    let questions: AskQuestion[] = [];
    try {
      const parsed = JSON.parse(req.arguments) as { questions?: AskQuestion[] };
      questions = parsed.questions ?? [];
    } catch {
      questions = [{ id: 'q1', question: req.arguments }];
    }
    rt.items.push({ kind: 'ask', id: genId('ask'), callId: req.call_id, questions, state: 'pending' });
    return true;
  }
  if (req.kind === 'tool_approval') {
    rt.items.push({
      kind: 'approval',
      id: genId('ap'),
      callId: req.call_id,
      name: req.name,
      args: req.arguments,
      state: 'pending',
    });
    return true;
  }
  return false;
}

// markRequestAnswered 应答后把卡片钉为已处理。
export function markRequestAnswered(
  rt: SessionRuntime,
  callId: string,
  result: { answers?: Record<string, unknown>; approved?: boolean; feedback?: string; dismiss?: boolean },
): void {
  const item = rt.items.find(
    (i): i is AskItem | ApprovalItem =>
      (i.kind === 'ask' || i.kind === 'approval') && i.callId === callId,
  );
  if (item) {
    const idx = rt.items.indexOf(item);
    if (item.kind === 'ask') {
      // 不可变替换:卡片元素按引用比较 item,原地改状态不会重渲染。
      rt.items[idx] = {
        ...item,
        state: result.dismiss ? 'dismissed' : 'answered',
        answers: result.answers,
      };
      // ask_user_question 的"执行"就是等用户回答:应答即该工具调用结束。
      // 续跑是新的 SSE 回合,服务端 bridge 的 open 表已重置,会对不上
      // call_id 而丢弃 completed 事件,不在这里收口工具卡会一直转圈。
      const tool = rt.items.find(
        (i): i is ToolItem => i.kind === 'tool' && i.callId === callId,
      );
      if (tool && tool.status === 'running') {
        patchToolItem(rt, callId, { status: 'done', endedAt: Date.now() });
      }
    } else {
      rt.items[idx] = {
        ...item,
        state: result.approved ? 'approved' : 'rejected',
        feedback: result.feedback,
      };
    }
  }
  rt.pendingRequests = rt.pendingRequests.filter((r) => r.call_id !== callId);
}

// applyResponseSnapshot 用终态快照对账(断流自愈 / 恢复暂停回合):回放输出
// item、用量与 incomplete 详情,清掉流式标记。
export function applyResponseSnapshot(rt: SessionRuntime, snap: import('../api/types').ResponseResource): boolean {
  let changed = false;
  rt.curRespId = snap.id;
  if (snap.model) rt.model = snap.model;
  for (const item of snap.output ?? []) {
    changed = upsertOutputItem(rt, item, true) || changed;
  }
  if (snap.usage) {
    rt.usage = snap.usage;
    changed = true;
  }
  for (const i of rt.items) {
    if ((i.kind === 'assistant' || i.kind === 'reasoning') && i.streaming) {
      i.streaming = false;
      if (i.kind === 'reasoning' && i.startedAt && !i.endedAt) i.endedAt = Date.now();
      changed = true;
    }
    if (i.kind === 'tool' && i.status === 'running') {
      changed =
        patchToolItem(rt, i.callId, {
          status: itemStatusFromSnapshot(snap, i.callId) ?? 'done',
          endedAt: i.endedAt ?? Date.now(),
        }) || changed;
    }
  }
  if (snap.status === 'incomplete' && snap.incomplete_details?.reason === 'grf:input_required') {
    rt.pendingRequests = snap.incomplete_details.grf_requests ?? [];
    for (const req of rt.pendingRequests) {
      changed = materializeRequest(rt, req) || changed;
    }
  }
  rt.lastResponseId = snap.id;
  return changed;
}

function itemStatusFromSnapshot(snap: import('../api/types').ResponseResource, callId: string): ToolStatus | undefined {
  const it = (snap.output ?? []).find((o) => o.call_id === callId);
  if (!it) return undefined;
  if (it.err) return 'error';
  return 'done';
}

function findTextTarget(
  items: ChatItem[],
  itemId: string | undefined,
  reasoning = false,
): AssistantItem | ReasoningItem | undefined {
  if (!itemId) return undefined;
  const found = items.find((i) => i.id === itemId && (reasoning ? i.kind === 'reasoning' : i.kind === 'assistant'));
  return found as AssistantItem | ReasoningItem | undefined;
}

function upsertOutputItem(rt: SessionRuntime, item: OutputItem, done: boolean): boolean {
  const q = (id: string) => `${rt.curRespId ?? 'pre'}\u0000${id}`;
  switch (item.type) {
    case 'message': {
      if (item.role !== 'assistant') return false;
      const qid = q(item.id);
      const existing = rt.items.find((i) => i.id === qid && i.kind === 'assistant') as
        | AssistantItem
        | undefined;
      const text = (item.content ?? [])
        .filter((p) => p.type === 'output_text' || p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
      if (existing) {
        if (text) existing.text = text;
        existing.streaming = !done;
        return true;
      }
      if (!text && !done) {
        rt.items.push({ kind: 'assistant', id: qid, text: '', streaming: true });
        return true;
      }
      if (text) {
        rt.items.push({ kind: 'assistant', id: qid, text, streaming: !done });
        return true;
      }
      return false;
    }
    case 'reasoning': {
      const text = (item.summary ?? []).map((p) => p.text ?? '').join('');
      const qid = q(item.id);
      const existing = rt.items.find((i) => i.id === qid && i.kind === 'reasoning') as
        | ReasoningItem
        | undefined;
      if (existing) {
        if (text) existing.text = text;
        existing.streaming = !done;
        if (done && existing.startedAt && !existing.endedAt) existing.endedAt = Date.now();
        return true;
      }
      if (text || !done) {
        rt.items.push({ kind: 'reasoning', id: qid, text, streaming: !done, startedAt: Date.now(), ...(done ? { endedAt: Date.now() } : {}) });
        return true;
      }
      return false;
    }
    case 'grf:tool_call': {
      if (item.call_id) return upsertToolItem(rt, item);
      return false;
    }
    default:
      return false;
  }
}

function upsertToolItem(rt: SessionRuntime, item: OutputItem, status?: ToolStatus): boolean {
  const items = rt.items;
  // 寻址优先 bridge item id(参数流式建的卡在 call_id 到位前只有它),
  // 回退 call_id(历史恢复等无 item id 关联的来源)。
  const qid = item.id ? `${rt.curRespId ?? 'pre'}\u0000${item.id}` : '';
  let idx = qid
    ? items.findIndex((i) => i.kind === 'tool' && i.id === qid)
    : -1;
  if (idx < 0 && item.call_id) {
    idx = items.findIndex((i) => i.kind === 'tool' && i.callId === item.call_id);
  }
  let target: ToolItem;
  if (idx < 0) {
    target = {
      kind: 'tool',
      id: qid || genId('t'),
      callId: item.call_id ?? '',
      name: item.name ?? '',
      args: item.input ?? item.arguments ?? '',
      status: 'running',
      output: '',
      err: '',
      agentId: item.agent_id ?? '',
      label: item.label ?? '',
      startedAt: Date.now(),
    };
    items.push(target);
  } else {
    // 不可变替换:工具卡按对象引用比较属性,原地改状态不会触发重渲染
    // (表现就是执行完的圈一直转)。
    target = { ...(items[idx] as ToolItem) };
    if (item.call_id) target.callId = item.call_id;
    if (item.name) target.name = item.name;
    if (item.input || item.arguments) target.args = item.input ?? item.arguments ?? target.args;
    if (item.agent_id) target.agentId = item.agent_id;
    if (item.label) target.label = item.label;
  }
  const out = item.output_text ?? '';
  if (out) target.output = out;
  if (item.err || status === 'error') {
    target.err = item.err || '工具执行失败';
    target.status = 'error';
    target.endedAt = Date.now();
  } else if (status === 'denied') {
    target.status = 'denied';
    target.endedAt = Date.now();
  } else if (status === 'done' || (out && !status)) {
    target.status = 'done';
    target.endedAt = Date.now();
  }
  if (target.endedAt && target.startedAt && target.callId) {
    saveToolDur(rt.sid, target.callId, target.startedAt, target.endedAt);
  }
  if (idx >= 0) items[idx] = target;
  // todo_write 的参数即任务列表(gh server 不发 grf:notice todos,任务
  // 状态只随工具调用更新):每次调用都同步,保证右栏详情/状态浮窗实时。
  if (target.name === 'todo_write') applyTodoArgs(rt, target.args);
  return true;
}

// applyTodoArgs 解析 todo_write 参数({"todos":[...]})写入 rt.todos。
function applyTodoArgs(rt: SessionRuntime, args: string | undefined): void {
  if (!args) return;
  try {
    const parsed = JSON.parse(args) as { todos?: unknown };
    if (Array.isArray(parsed.todos)) rt.todos = parsed.todos as TodoItem[];
  } catch {
    /* 参数残缺(流式中截断):保持原状 */
  }
}

// todosFromItems 从消息条目里找最后一次 todo_write 调用,回填任务列表
// (历史恢复用;grf:notice todos 不存在,只能从工具参数还原)。
export function todosFromItems(items: ChatItem[]): TodoItem[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'tool' || it.name !== 'todo_write') continue;
    try {
      const parsed = JSON.parse(it.args || '{}') as { todos?: unknown };
      if (Array.isArray(parsed.todos)) return parsed.todos as TodoItem[];
    } catch {
      /* 跳过残缺参数 */
    }
  }
  return null;
}

// patchToolItem 以不可变替换方式改指定 callId 的工具项及其相邻状态。
function patchToolItem(rt: SessionRuntime, callId: string, patch: Partial<ToolItem>): boolean {
  const idx = rt.items.findIndex((i) => i.kind === 'tool' && i.callId === callId);
  if (idx < 0) return false;
  const next = { ...(rt.items[idx] as ToolItem), ...patch };
  rt.items[idx] = next;
  if (patch.endedAt && next.startedAt) saveToolDur(rt.sid, callId, next.startedAt, next.endedAt!);
  return true;
}
