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
import { friendlyError } from '../api/errors';
import { kvGet, kvSet } from '../store/storage';

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
  /** 截图类工具结果里的图片(data URL;SSE 不带,历史/回合后补取回填) */
  images?: string[];
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
  /** 会话实际运行模型(服务端回报的裸名,不含 provider 前缀;仅展示用,
   * 下发一律走 scope.model 的 "provider/model" 全名) */
  model?: string;
  usage?: Usage | null;
  /** 前端本地 usage 累计:gh 的会话统计是内存态,gh server 重启即归零,
   * 这里按 response 定格累加(持久化由 scope 负责)作跨重启兜底 */
  localUsage?: LocalUsage;
  /** 会话累计统计(getConversation 的 stats;速度/缓存命中率等,圆环 tooltip 用) */
  stats?: { llm: LLMStats; tools: { calls: number; time_ms: number } };
  /** 当前生效的访问策略(getConversation 回报;草稿/旧 server 无值) */
  policy?: string;
  todos: TodoItem[] | null;
  /** 会话当前目标(create_goal/update_goal 推导;null = 无目标) */
  goal?: { objective: string; phase: string } | null;
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

// ---------- usage 前端累计(跨 gh server 重启) ----------
// gh 的会话级 LLM 统计(总输入/总输出)是内存态,gh server 随 App 重启
// 归零,统计框会退化成「—」。这里按 response 定格累加并按 sid 持久化到
// localStorage,重开后兜底显示(展示时与 gh 累计取大,防重开跳小)。
const USAGE_KEY = 'goder:usage-totals';
/** 会话条目上限(超出丢最旧,防无限膨胀) */
const USAGE_MAX = 500;

export interface LocalUsage {
  /** 已完结模型调用(按 response 定格)的累计 */
  basePrompt: number;
  baseCompletion: number;
  /** 当前未定格 response 的最新 usage(同一次调用的流事件反复带递增
   * usage,按 respId 区分:换 respId 即新一次模型调用,旧的并入 base) */
  curResp?: string;
  curPrompt: number;
  curCompletion: number;
}

function readUsageMap(): Record<string, LocalUsage> {
  return kvGet<Record<string, LocalUsage>>(USAGE_KEY) ?? {};
}

function writeUsageMap(map: Record<string, LocalUsage>): void {
  const keys = Object.keys(map);
  if (keys.length > USAGE_MAX) {
    for (const k of keys.slice(0, keys.length - USAGE_MAX)) delete map[k];
  }
  kvSet(USAGE_KEY, map);
}

/** 历史恢复时回填该会话的前端 usage 累计(scope.ensureRuntime 调用)。 */
export function restoreLocalUsage(rt: SessionRuntime, sid: string): void {
  if (!rt.localUsage) rt.localUsage = readUsageMap()[sid];
}

/** 把一次 response 的 usage 并入本地累计并持久化(按 respId 幂等定格)。 */
function accumUsage(rt: SessionRuntime, respId: string, u: Usage): void {
  const lu = rt.localUsage ?? (rt.localUsage = { basePrompt: 0, baseCompletion: 0, curPrompt: 0, curCompletion: 0 });
  if (lu.curResp !== respId) {
    lu.basePrompt += lu.curPrompt;
    lu.baseCompletion += lu.curCompletion;
    lu.curResp = respId;
  }
  lu.curPrompt = u.input_tokens;
  lu.curCompletion = u.output_tokens;
  const sid = rt.sid;
  if (sid && !sid.startsWith('draft:')) {
    const map = readUsageMap();
    map[sid] = lu;
    writeUsageMap(map);
  }
}

/** 本地累计的当前总数(总输入/总输出;无累计时为 0)。 */
export function usageTotals(rt: SessionRuntime): { prompt: number; completion: number } {
  const lu = rt.localUsage;
  if (!lu) return { prompt: 0, completion: 0 };
  return { prompt: lu.basePrompt + lu.curPrompt, completion: lu.baseCompletion + lu.curCompletion };
}

/** 会话归档时清掉它的前端 usage 累计。 */
export function forgetUsage(sid: string): void {
  const map = readUsageMap();
  if (map[sid]) {
    delete map[sid];
    writeUsageMap(map);
  }
}

// ---------- 工具耗时本地持久化 ----------
// 会话历史(线格式 llm.Message)不含时间戳,重开 App 后耗时无法从服务端
// 恢复。工具结束时就把 startedAt/endedAt 按 sid+callId 记进 localStorage,
// 历史恢复时回填到工具卡。
const TOOL_DUR_KEY = 'goder:tool-durs';
/** 条目上限(超出丢最旧,防无限膨胀) */
const TOOL_DUR_MAX = 4000;

function readToolDurs(): Record<string, [number, number]> {
  return kvGet<Record<string, [number, number]>>(TOOL_DUR_KEY) ?? {};
}

export function saveToolDur(sid: string | undefined, callId: string, startedAt: number, endedAt: number): void {
  if (!sid || !callId || !startedAt || !endedAt) return;
  const all = readToolDurs();
  all[`${sid}\u0000${callId}`] = [startedAt, endedAt];
  const keys = Object.keys(all);
  if (keys.length > TOOL_DUR_MAX) {
    for (const k of keys.slice(0, keys.length - TOOL_DUR_MAX)) delete all[k];
  }
  kvSet(TOOL_DUR_KEY, all);
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

export function textOfContent(content: string | HistPart[] | undefined): string {
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

// 截图类工具(computer_screenshot / browser_take_screenshot 等):结果带
// image_url part,但 SSE 的 tool_call 事件不下发图片,需回合后补取历史回填。
export function isScreenshotTool(name: string): boolean {
  return /screenshot/i.test(name);
}

// 电脑点击类工具(left_click/right_click/double_click/mouse_down 等):
// 行内提供「查看」链接,配合上一张截图圈出点击位置。
export function isClickTool(name: string): boolean {
  return /click|mouse_down|mouse_up/i.test(name);
}

// 从(可能流式残缺的)参数 JSON 里容错提取点击坐标。两种形态:
// computer-use MCP 的 target {"type":"coordinate","x":…,"y":…} 与 gh
// computer_click 的顶层 {"x":…,"y":…}(全局屏幕坐标)。
export function clickCoordOf(args: string): { x: number; y: number } | undefined {
  const m =
    args.match(/"type"\s*:\s*"coordinate"\s*,\s*"x"\s*:\s*(-?\d+)\s*,\s*"y"\s*:\s*(-?\d+)/) ??
    args.match(/"x"\s*:\s*(-?\d+)\s*,\s*"y"\s*:\s*(-?\d+)\s*,\s*"type"\s*:\s*"coordinate"/) ??
    args.match(/"x"\s*:\s*(-?\d+)\s*,\s*"y"\s*:\s*(-?\d+)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
}

// 解析截图工具结果里的坐标 meta("图像 WxH 像素;覆盖 display#N(全局坐标
// x=A..B, y=C..D);scale=S"):把全局点击坐标换算回图上像素用。
export function parseShotMeta(text: string): { ox: number; oy: number; scale: number } | undefined {
  const m = text.match(/全局坐标 x=(-?\d+)\.\.\d+, y=(-?\d+)\.\.\d+/);
  if (!m) return undefined;
  const s = text.match(/scale=(\d+)/);
  return { ox: Number(m[1]), oy: Number(m[2]), scale: s ? Number(s[1]) : 1 };
}

// 从工具输出文本兜底提取 data URL 图片:部分形态下历史不带 image_url part,
// 但输出文本(markdown 或裸 base64)里就有图片数据。
export function imagesOfOutput(text: string): string[] {
  const re = /data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+/g;
  return text.match(re) ?? [];
}

// gh server 的电脑截图工具把图片落盘为本地文件,会话历史里只有
// "截图已保存: /tmp/xx.png(32 KB)"之类的文字。从这里解析出文件路径,
// 转为桌面本地文件服务 URL 供 <img> 直读(纯 web 网关形态无此服务,降级
// 为裂图,可接受)。
export function shotUrlsOfFile(text: string): string[] {
  const re = /(\/[^\s（()'"`，。]+?\.(?:png|jpe?g|webp|gif))/gi;
  return (text.match(re) ?? []).map((p) => `/goder-api/local-file?path=${encodeURIComponent(p)}`);
}
// gh 带图工具结果的伪 user 消息("[tool result: <名>] …" + image_url part;
// 捕获组 = 工具名)。识别这类消息用:不进用户气泡,只回填工具卡。
export const TOOL_RESULT_RE = /^\[tool result: ([^\]]+)\]/;

// gh 会话压缩(手动 /compact 或超阈值自动压缩)把历史收敛为一条
// "[conversation summary] …" 的 user 消息(agent/compact.go 的
// compactSummaryMarker)。这是模型向锚点,用户并没有发过这条——恢复
// 历史时渲染为摘要通知卡,不进用户气泡。
const COMPACT_SUMMARY_RE = /^\[conversation summary\]\s*/;

// gh 取消中断的流式回复在内容尾部追加的模型向标记(turn.go 的
// keepDeliveredPrefix):提示模型续答不复述。对用户是英文噪音,恢复
// 历史展示时剥掉(仅显示层,不影响会话历史本身)。
const INTERRUPTED_MARK_RE = /\n*\[interrupted:[^\]]*\]\s*$/;

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
        // 截图类工具的结果被 gh server 记成 "[tool result: <名>]…" 的 user
        // 消息(带 image_url part):回填到最近的同名工具卡,不进用户气泡
        // ——只有用户亲手发的消息才允许出现在右侧。
        const tr = text.match(TOOL_RESULT_RE);
        if (tr) {
          for (let k = items.length - 1; k >= 0; k--) {
            const t = items[k];
            // gh 新版历史带图结果是两条消息:tool 文本消息先回填了正文,
            // 这里只补图;旧版历史伪消息是唯一结果载体,连同正文一起回填。
            // 按"最近一张缺图同名卡"配对,同名多次截图不错位。
            if (t.kind !== 'tool' || t.name !== tr[1] || t.images) continue;
            if (!t.output) t.output = text;
            if (images.length) t.images = images;
            break;
          }
          break;
        }
        if (text || images.length) {
          // 压缩摘要锚点:通知卡承载,不进用户气泡。
          const cs = text.match(COMPACT_SUMMARY_RE);
          if (cs) {
            const summary = text.slice(cs[0].length);
            if (summary) items.push({ kind: 'notice', id: genId('n'), noticeKind: 'compact', detail: summary });
            break;
          }
          items.push({ kind: 'user', id: genId('u'), text, images: images.length ? images : undefined });
        }
        break;
      }
      case 'assistant': {
        const text = textOfContent(msg.content).replace(INTERRUPTED_MARK_RE, '');
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
        // 截图类工具结果带 image_url part:提取为工具卡可展示的图片;
        // 没有 part 时从输出文本兜底(data URL 或"截图已保存"的文件路径)。
        const images = imagesOfContent(msg.content);
        if (target) {
          target.output = out;
          const imgs = images.length
            ? images
            : isScreenshotTool(target.name)
              ? [...imagesOfOutput(out), ...shotUrlsOfFile(out)]
              : [];
          if (imgs.length) target.images = imgs;
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
  // rt.model 记服务端回报的实际模型(裸名,不含 provider 前缀):仅展示与
  // 上下文估算用,下发链路一律走 scope.model(全名)。每个响应事件都带
  // model 字段,跟随更新 —— 否则会话中途切换模型后展示仍停在旧模型。
  if (ev.response?.model) {
    rt.model = ev.response.model;
  }
  // 用量随每个带 usage 的事件刷新(回合内多次模型调用也会推进,不等终态);
  // 同时并入前端累计(跨 gh server 重启的兜底统计)。
  if (ev.response?.usage) {
    rt.usage = ev.response.usage;
    if (rt.curRespId) accumUsage(rt, rt.curRespId, ev.response.usage);
    changed = true;
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
      // 目标状态机:create_goal/update_goal 的 notice 同步进 rt.goal
      // (状态浮窗「目标」区块用)。
      if (kind === 'goal') {
        changed = applyGoalNotice(rt, (ev.detail ?? '').trim()) || changed;
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
    // 对账快照也并入前端累计(重开 App 后的恢复链路;同 respId 幂等定格)
    accumUsage(rt, snap.id, snap.usage);
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
  // 截图类工具:SSE 输出文本里若带 data URL 或"截图已保存"的本地文件
  // 路径,立即提取上屏,不必等回合后补取历史。
  if (out && !target.images && isScreenshotTool(target.name)) {
    const imgs = [...imagesOfOutput(out), ...shotUrlsOfFile(out)];
    if (imgs.length) target.images = imgs;
  }
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

// applyGoalNotice 把 goal notice 增量应用到运行时目标状态。
function applyGoalNotice(rt: SessionRuntime, detail: string): boolean {
  if (detail.startsWith('created: ')) {
    rt.goal = { objective: detail.slice('created: '.length), phase: 'working' };
    return true;
  }
  if (!rt.goal) return false;
  if (detail === 'complete') {
    rt.goal = { ...rt.goal, phase: 'complete' };
    return true;
  }
  if (detail === 'paused') {
    rt.goal = { ...rt.goal, phase: 'paused' };
    return true;
  }
  if (detail.startsWith('resumed')) {
    rt.goal = { ...rt.goal, phase: 'working' };
    return true;
  }
  return false; // edited(rN) 等不含目标的明细:保持原状
}

// goalFromItems 从消息条目里按顺序重放 goal 工具调用,还原当前目标
// (历史恢复用;与 todosFromItems 同一思路)。
export function goalFromItems(items: ChatItem[]): { objective: string; phase: string } | null {
  let goal: { objective: string; phase: string } | null = null;
  for (const it of items) {
    if (it.kind !== 'tool') continue;
    let args: { objective?: string; action?: string } = {};
    try {
      args = JSON.parse(it.args || '{}');
    } catch {
      continue; // 残缺参数跳过
    }
    if (it.name === 'create_goal' && args.objective) {
      goal = { objective: args.objective, phase: 'working' };
    } else if (it.name === 'update_goal' && goal) {
      if (args.action === 'edit' && args.objective) goal.objective = args.objective;
      else if (args.action === 'complete') goal.phase = 'complete';
      else if (args.action === 'pause') goal.phase = 'paused';
      else if (args.action === 'resume') goal.phase = 'working';
      else if (args.action === 'blocked') goal.phase = 'blocked';
    }
  }
  return goal;
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
