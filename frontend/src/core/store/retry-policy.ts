// retry-policy.ts — 流式发送的恢复策略(可注入)。
// 三层重试(工具调用瞬时 400 重试 → 连接层自愈 → 链尾失配自愈)的判定
// 与参数收敛于此;默认值即历史内置行为,嵌入方可按自家网络环境注入
// (如内网高可用链路放宽重试上限、离线场景加长退避)。
import { GoderApiError } from '../api/client';

export interface RetryPolicy {
  /** 流断连自动重试上限(事件流中断/静默超时/网络错误);默认 10 */
  streamRetryMax: number;
  /** 上游"未开启工具调用"瞬时 400 的重试上限;默认 3 */
  toolChoiceRetryMax: number;
  /** 工具调用重试的间隔 ms;默认 300 */
  toolChoiceBackoffMs: number;
  /** 第 n 次流重试前的退避 ms(n 从 0 起);默认 min(800×(n+1), 4000) */
  backoffMs: (attempt: number) => number;
  /** fetch 抛出的错误是否可重试(连接类) */
  isRetryableError: (err: unknown) => boolean;
  /** failed 终态的错误文本是否为可重试的连接类失败 */
  isRetryableFailure: (msg: string) => boolean;
}

export const defaultRetryPolicy: RetryPolicy = {
  streamRetryMax: 10,
  toolChoiceRetryMax: 3,
  toolChoiceBackoffMs: 300,
  backoffMs: (attempt) => Math.min(800 * (attempt + 1), 4000),
  isRetryableError: (err) => {
    if (err instanceof GoderApiError) {
      return err.code === 'stream_interrupted' || err.code === 'stream_idle_timeout' || err.status === 0;
    }
    return err instanceof TypeError; // fetch 网络失败(连接拒绝/断网/代理断)
  },
  // 只匹配连接类,业务错误(鉴权/参数/配额)不重试——重试也一样失败。
  isRetryableFailure: (msg) =>
    /unexpected eof|context deadline exceeded|client\.timeout|read stream|connection reset|broken pipe|eof/i.test(msg),
};

let policy: RetryPolicy = defaultRetryPolicy;

/** 注入自定义恢复策略(传 partial 与默认合并;全局生效)。 */
export function setRetryPolicy(p: Partial<RetryPolicy>): void {
  policy = { ...defaultRetryPolicy, ...p };
}

/** 恢复默认策略。 */
export function resetRetryPolicy(): void {
  policy = defaultRetryPolicy;
}

/** 当前恢复策略。 */
export function getRetryPolicy(): RetryPolicy {
  return policy;
}
