// types.ts — gh server（ORS 兼容 Responses API）wire 类型。
// 与 grf-harness/server/dto.go 逐字段对齐；grf 扩展用 grf:/grf_ 前缀。

export type ResponseStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'incomplete';

export interface ContentPart {
  type: string; // input_text | input_image | output_text | summary_text | refusal
  text?: string;
  refusal?: string;
  image_url?: string; // data URL 或远程 URL
  detail?: string;
}

export type ItemKind =
  | 'message'
  | 'function_call'
  | 'function_call_output'
  | 'reasoning'
  | 'compaction'
  | 'grf:tool_call';

export interface OutputItem {
  type: ItemKind;
  id: string;
  status?: string;
  // message
  role?: string;
  content?: ContentPart[];
  // function_call / grf:tool_call
  call_id?: string;
  name?: string;
  arguments?: string;
  // grf:tool_call 扩展
  input?: string;
  output_text?: string;
  err?: string;
  agent_id?: string;
  label?: string;
  // function_call_output
  fc_output?: string;
  // reasoning
  summary?: ContentPart[];
  encrypted_content?: string;
}

export interface IncompleteRequest {
  call_id: string;
  name: string;
  kind: 'function' | 'tool_approval' | 'question';
  arguments: string;
}

export interface IncompleteDetails {
  reason: string; // grf:input_required | max_tool_calls
  grf_requests?: IncompleteRequest[];
}

export interface ErrorPayload {
  type: string;
  code: unknown;
  message: string;
  param: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number; reasoning_tokens?: number };
  output_tokens_details?: { cached_tokens?: number; reasoning_tokens?: number };
}

export interface ResponseResource {
  id: string;
  object: 'response';
  created_at: number;
  completed_at?: number | null;
  status: ResponseStatus;
  incomplete_details?: IncompleteDetails | null;
  error?: ErrorPayload | null;
  /** 实际使用的模型(服务端回报)。注意:通常是裸名 —— 不含 provider
   * 前缀,部分供应商的模型名自带 /(如九天 qwen/qwen3.8-27b)。只作展示
   * 与估算用,禁止原样再下发(gh 的 trySwitchModel 只认 provider/model
   * 全名,裸名会被静默忽略)。 */
  model: string;
  previous_response_id?: string;
  instructions?: string | null;
  output: OutputItem[];
  tools?: unknown[];
  tool_choice?: unknown;
  usage?: Usage | null;
  max_tool_calls?: number | null;
  store?: boolean | null;
  'grf:session_id'?: string;
}

export interface CompactResource {
  id: string;
  object: 'response.compaction';
  output: OutputItem[];
  created_at: number;
  usage?: Usage | null;
}

// SSE 事件（event: 行与 data.type 一致）。
export interface SSEEvent {
  type: string;
  sequence_number: number;
  response?: ResponseResource;
  output_index?: number;
  item?: OutputItem;
  item_id?: string;
  content_index?: number;
  part?: ContentPart;
  delta?: string;
  text?: string;
  summary_index?: number;
  error?: ErrorPayload;
  // grf:notice 扩展
  kind?: string; // todos | goal | plan | phase | notice ...
  detail?: string;
  // grf:input_required 扩展(与 response.incomplete 的 incomplete_details 同构)
  grf_input?: IncompleteDetails;
}

export interface Conversation {
  id: string;
  object: 'conversation';
  created_at: string;
  archived?: boolean;
  workspace?: string;
  last_response_id?: string;
}

// llm.StatsSnapshot 无 json tag —— 字段名原样大写。
export interface LLMStats {
  Rounds: number;
  LLMTime: number; // 纳秒
  FirstTokenAvg: number;
  GenerationTime: number;
  PromptTokens: number;
  CompletionTokens: number;
  CachedTokens: number;
  UsageSeen: boolean;
  CachePct: number;
  /** 最后一次 LLM 调用的精确 usage(prompt = 该次全量上下文,含缓存命中)。
   * 累计值 PromptTokens 把回合内每次工具循环的全量 prompt 加一遍,不能
   * 当上下文长度;上下文占用一律取这两个字段(旧版 gh 无此字段,为 0)。 */
  LastPromptTokens?: number;
  LastCompletionTokens?: number;
}

export interface ConversationDetail {
  id: string;
  created_at: string;
  workspace: string;
  last_response_id: string;
  paused: boolean;
  running: boolean;
  /** 当前生效的访问策略(write-workspace|off 等;旧 server 无此字段) */
  policy?: string;
  stats: {
    llm: LLMStats;
    tools: { calls: number; time_ms: number };
  };
}

// GET /v1/conversations/{id}/items —— llm.Message 线格式。
export interface HistPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface HistToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface HistMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | HistPart[];
  tool_calls?: HistToolCall[];
  tool_call_id?: string;
  name?: string;
}

// POST /v1/responses 请求体（本 UI 用到的字段）。
export interface GrfSessionConfig {
  policy?: string; // write-workspace|read-workspace 组合 | off
  auto_approve?: boolean;
  /** 会话级 custom 提示词(身份定义+工作方式);gh 的内置工具说明段
   * (inner prompt)恒定追加,不被它替换。goder 普通会话未配置时兜底
   * session-prompt.ts 的默认值;嵌入方/项目 defaults 可自带覆盖。 */
  system_prompt?: string;
  /** 默认技能名:技能目录(workspace/.grf/skills 两级)中存在该名字时,
   * 其 SKILL.md 全文注入系统提示词,无需模型调 skill 工具;空 = 不注入
   * 任何默认技能(gh 侧已取消 goder-usage 回落)。经项目 defaults 开放给
   * 嵌入方(如 grf-play 配 grf-start 总纲)。 */
  default_skill?: string;
  max_steps?: number;
  disabled_tools?: string[];
  /** 会话工作区(项目本地路径;桌面态新建项目时选择的目录) */
  workspace?: string;
}

export type InputItem =
  | { type: 'message'; role: 'user'; content: ContentPart[] }
  | {
      type: 'grf:input_result';
      call_id: string;
      answers?: Record<string, unknown>;
      approved?: boolean;
      feedback?: string;
      dismiss?: boolean;
    }
  // 会话恢复:为上次中断未落结果的工具调用补一个结果(gh server 对
  // "暂停等待交互"的会话只接受 grf:input_result / function_call_output)。
  | { type: 'function_call_output'; call_id: string; output: string };

export interface SendOptions {
  model?: string;
  /** 思考强度(low/high/max 等;空 = 服务端默认),随请求 reasoning.effort 下发 */
  reasoningEffort?: string;
  input: string | InputItem[];
  previousResponseId?: string;
  instructions?: string;
  grfSession?: GrfSessionConfig;
  /** 编辑重发:截断后的会话历史(必须是当前历史的前缀,服务端逐条校验) */
  grfHistory?: HistMessage[];
  signal?: AbortSignal;
  onEvent?: (e: SSEEvent) => void;
  /** 流上看门狗:单次读超时(默认 120s) */
  idleTimeoutMs?: number;
}

// grf:notice(kind=todos) 的 detail JSON。
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// ask_user_question 的 arguments JSON。
export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multi_select?: boolean;
}
