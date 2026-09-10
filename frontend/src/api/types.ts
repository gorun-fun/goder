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
}

export interface ConversationDetail {
  id: string;
  created_at: string;
  workspace: string;
  last_response_id: string;
  paused: boolean;
  running: boolean;
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
  system_prompt?: string;
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
    };

export interface SendOptions {
  model?: string;
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
