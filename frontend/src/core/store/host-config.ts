// host-config.ts — 嵌入方按 scope 注入的运行时策略(core 侧落点)。
// 与 registry.ts 的宿主配置(user/sideTop/uiEvents 等 UI 层钩子)相对,
// 这里是发送/审批管线内消费的策略;全部「按 scope、不持久化、宿主每次
// 加载自行下发」——与 sessionDefaults 同一约定。
import type { GrfSessionConfig } from '../api/types';

// ---------- sessionDefaults(embed.configure 的 sessionDefaults 落点) ----------

// 嵌入方会话级兜底配置:草稿落定时展开在项目 defaults 之前,项目
// defaults 逐字段覆盖之;两者都缺 system_prompt 才回落 goder 默认提示词
// (除非 disableDefaultPrompt)。workspace 特殊:项目自身路径 > homeDir >
// sessionDefaults.workspace(兜底顺序见 scope 的 grfSession 组装处)。
const sessionDefaultsMap = new Map<string, Partial<GrfSessionConfig>>();

export function setSessionDefaults(scope: string, defaults: Partial<GrfSessionConfig> | undefined): void {
  if (defaults && Object.keys(defaults).length > 0) sessionDefaultsMap.set(scope, defaults);
  else sessionDefaultsMap.delete(scope);
}

export function getSessionDefaults(scope: string): Partial<GrfSessionConfig> | undefined {
  return sessionDefaultsMap.get(scope);
}

/** 禁用 goder 默认身份提示词(嵌入方完全自管 system_prompt:项目 defaults
 *  与 sessionDefaults 都未给时不再兜底注入 goder 身份,system_prompt 留空)。 */
const noDefaultPrompt = new Set<string>();

export function setDisableDefaultPrompt(scope: string, off: boolean): void {
  if (off) noDefaultPrompt.add(scope);
  else noDefaultPrompt.delete(scope);
}

export function defaultPromptDisabled(scope: string): boolean {
  return noDefaultPrompt.has(scope);
}

// ---------- ungroupedSessions(embed.configure 的 ungroupedSessions 落点) ----------

// 嵌入方禁止未分组会话:无激活会话直接发送的兜底项目不再落 UNGROUPED,
// 改绑最近使用的项目;左栏「未分组会话」分组不再渲染(索引里的伪项目
// 保留,兼容既有逻辑)。
const ungroupedDenied = new Set<string>();

export function setUngroupedSessions(scope: string, allow: boolean): void {
  if (allow) ungroupedDenied.delete(scope);
  else ungroupedDenied.add(scope);
}

/** 未分组会话是否允许(嵌入形态默认允许;session-list 据此隐藏分组)。 */
export function ungroupedAllowed(scope: string): boolean {
  return !ungroupedDenied.has(scope);
}

// ---------- 发送钩子(embed.configure 的 onBeforeSend 落点) ----------

/** 待发送载荷(composer 提交的原始输入)。 */
export interface SendPayload {
  text: string;
  images?: string[];
  /** 编辑重发的目标消息 id(chat 面板「编辑后重新发送」) */
  editOf?: string;
}

/** 发送拦截器:在用户消息离开输入框、进入发送管线之前回调。返回
 *  改写后的载荷继续发送;返回 null/undefined 取消本次发送(输入保留
 *  在输入框内)。用于出站审计、前置 RAG 注入、敏感词过滤、路由改写等。
 *  只拦截 UI 发送(composer/编辑重发);编程直调 store.send() 不经过
 *  (嵌入方自己的代码不需要被自己拦截)。 */
export type SendInterceptor = (p: SendPayload) => SendPayload | null | Promise<SendPayload | null>;

const sendInterceptors = new Map<string, SendInterceptor>();

export function setSendInterceptor(scope: string, fn: SendInterceptor | undefined): void {
  if (fn) sendInterceptors.set(scope, fn);
  else sendInterceptors.delete(scope);
}

export function getSendInterceptor(scope: string): SendInterceptor | undefined {
  return sendInterceptors.get(scope);
}

// ---------- 审批钩子(embed.configure 的 onApproval 落点) ----------

/** 待决审批请求(工具调用审批卡出现时的上下文)。 */
export interface ApprovalRequest {
  callId: string;
  sessionId: string;
  /** 待审批的工具名(如 'bash') */
  toolName: string;
  /** 工具入参(已尝试 JSON.parse;残缺参数为原始字符串) */
  input: unknown;
}

/** 审批决策:approved + 可选反馈;返回 null/undefined = 不决策,
 *  显示默认审批卡由用户手动处置。 */
export interface ApprovalDecision {
  approved: boolean;
  feedback?: string;
}

export type ApprovalHook = (req: ApprovalRequest) => ApprovalDecision | null | Promise<ApprovalDecision | null>;

const approvalHooks = new Map<string, ApprovalHook>();

export function setApprovalHook(scope: string, fn: ApprovalHook | undefined): void {
  if (fn) approvalHooks.set(scope, fn);
  else approvalHooks.delete(scope);
}

export function getApprovalHook(scope: string): ApprovalHook | undefined {
  return approvalHooks.get(scope);
}
