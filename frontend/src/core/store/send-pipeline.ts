// send-pipeline.ts — 发送/恢复管线:三层重试与终态对账,从 GoderScope
// 抽出的自愈逻辑(依赖经 SendPipelineDeps 注入,便于独立测试)。
// 层次:requestWithChainHeal(链尾失配自愈)→ requestWithRetry(工具调用
// 瞬时 400 有限重试)→ sendWithStreamRetry(断流/连接类失败退避重发,
// 重发前先 tryRecoverFinal 终态对账)。幂等性由 lastResponseId 链保证。
import { GoderApiError, type GoderClient } from '../api/client';
import { friendlyError, isToolChoiceUnsupported } from '../api/errors';
import type { ResponseResource, SendOptions } from '../api/types';
import { applyResponseSnapshot, type SessionRuntime } from '../model/chat-model';
import { getRetryPolicy } from './retry-policy';

/** 错误消息的可读形态(GoderApiError/Error 取 message,再过已知错误翻译)。 */
export function errText(err: unknown, t?: (key: string, params?: Record<string, string | number>) => string): string {
  const raw =
    err instanceof GoderApiError || err instanceof Error ? err.message : String(err);
  return t ? friendlyError(raw, t) : friendlyError(raw);
}

/** 管线对宿主(scope)的依赖面。 */
export interface SendPipelineDeps {
  client: Pick<GoderClient, 'send' | 'getConversation' | 'retrieveResponse'>;
  /** 系统日志(事件台可见;level 与 scope 的 ConsoleEntry.level 同集)。 */
  log(level: 'info' | 'warn' | 'error' | 'event', text: string): void;
  /** i18n 翻译(key 即中文默认文案)。 */
  t(key: string, params?: Record<string, string | number>): string;
  /** 对账快照已应用到运行时(触发界面刷新)。 */
  onApplied(): void;
  /** 采纳服务器链尾为本地链尾(运行时 + 项目索引;scope 提供)。 */
  adoptChainTail(sid: string, respId: string): void;
}

export interface SendPipeline {
  /** 发送入口(含全部自愈层)。 */
  requestWithChainHeal(rt: SessionRuntime, sid: string, opts: SendOptions): Promise<ResponseResource>;
  /** 查会话终态并尝试对账(取消/同步路径复用)。 */
  tryRecoverFinal(rt: SessionRuntime, sid: string): Promise<ResponseResource | null>;
}

export function createSendPipeline(deps: SendPipelineDeps): SendPipeline {
  // tryRecoverFinal 查会话终态:服务器已推进到本地未见过的 response 且已到
  // 终态,则对账并返回该快照(作为本轮 send 的结果);否则返回 null。
  const tryRecoverFinal = async (rt: SessionRuntime, sid: string): Promise<ResponseResource | null> => {
    try {
      const detail = await deps.client.getConversation(sid);
      const last = detail.last_response_id;
      if (!last || last === rt.lastResponseId) return null;
      const snap = await deps.client.retrieveResponse(last);
      if (!snap) return null;
      const status = snap.status;
      if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'incomplete') {
        return null; // 仍在跑:对账无意义,等退避后重发
      }
      if (applyResponseSnapshot(rt, snap)) deps.onApplied();
      return snap;
    } catch {
      return null;
    }
  };

  // requestWithRetry 针对"上游 vLLM 未开启工具调用"的瞬时 400 做有限重试:
  // 上游网关按后端负载均衡,部分后端没带 --enable-auto-tool-choice,重发通常
  // 会落到正常后端。该失败发生在生成之前(终态无输出),重发无副作用;重试
  // 前清掉这次失败物化的错误条目。超过上限仍失败则原样返回,由调用方展示。
  const requestWithRetry = async (rt: SessionRuntime, sid: string, opts: SendOptions): Promise<ResponseResource> => {
    const max = getRetryPolicy().toolChoiceRetryMax;
    for (let attempt = 0; ; attempt++) {
      const final = await sendWithStreamRetry(rt, sid, opts);
      const msg = final.error?.message ?? '';
      if (
        final.status !== 'failed' ||
        (final.output?.length ?? 0) > 0 ||
        attempt >= max ||
        !isToolChoiceUnsupported(msg)
      ) {
        return final;
      }
      rt.items = rt.items.filter(
        (i) => !(i.kind === 'error' && isToolChoiceUnsupported(i.text)),
      );
      deps.log('warn', deps.t('模型服务瞬时不可用(后端未开启工具调用),自动重试 {a}/{m}', { a: attempt + 1, m: max }));
      await new Promise((r) => setTimeout(r, getRetryPolicy().toolChoiceBackoffMs));
    }
  };

  // sendWithStreamRetry 连接层自愈,两类输入都覆盖:
  //  1. 浏览器侧 fetch 抛错(事件流中断/静默断流/网络失败);
  //  2. SSE 流正常结束但终态是 failed 且错误为连接类(如 gh 报
  //     "llm: read stream: unexpected EOF" / "context deadline exceeded")。
  // 先尝试从服务器终态对账(回合其实已完成或已暂停的情况直接拿快照),
  // 否则退避后原样重发,最多 STREAM_RETRY_MAX 次;用户主动取消不重试。
  // 重发可能造成模型重复生成,但比把会话卡死可取——服务端按会话串行,
  // 幂等性由 lastResponseId 链保证。
  const sendWithStreamRetry = async (rt: SessionRuntime, sid: string, opts: SendOptions): Promise<ResponseResource> => {
    const policy = getRetryPolicy();
    let sendOpts = opts;
    for (let attempt = 0; ; attempt++) {
      let final: ResponseResource | null = null;
      try {
        final = await deps.client.send(sendOpts);
      } catch (err) {
        if (opts.signal?.aborted || attempt >= policy.streamRetryMax || !policy.isRetryableError(err)) throw err;
        deps.log('warn', deps.t('连接中断({err}),自动重试 {a}/{m}', { err: errText(err, deps.t), a: attempt + 1, m: policy.streamRetryMax }));
        // 服务器可能已受理并完成该回合:拿终态快照直接用,不盲目重发。
        const snapped = await tryRecoverFinal(rt, sid);
        if (snapped) {
          deps.log('info', deps.t('已从服务器终态恢复回合(连接中断重试期间)'));
          return snapped;
        }
        await new Promise((r) => setTimeout(r, policy.backoffMs(attempt)));
        continue;
      }
      // failed 终态且为连接类错误:清掉本次物化的错误条目,挂到失败
      // response 之后重发一次(不挂链会分叉出新会话)。
      const failMsg = final.error?.message ?? '';
      if (
        final.status === 'failed' &&
        policy.isRetryableFailure(failMsg) &&
        !opts.signal?.aborted &&
        attempt < policy.streamRetryMax
      ) {
        deps.log('warn', deps.t('上游连接错误({err}),自动重试 {a}/{m}', { err: friendlyError(failMsg), a: attempt + 1, m: policy.streamRetryMax }));
        rt.items = rt.items.filter(
          (i) => !(i.kind === 'error' && policy.isRetryableFailure(i.text.replace(/^(发送|应答)失败:/, ''))),
        );
        if (final.id) sendOpts = { ...sendOpts, previousResponseId: final.id };
        await new Promise((r) => setTimeout(r, policy.backoffMs(attempt)));
        continue;
      }
      return final;
    }
  };

  // requestWithChainHeal 链尾失配自愈:gh 严格要求 previous_response_id 为
  // 会话链尾。本地链尾落后于服务器(典型:停止后立刻重发——被取消回合已成
  // 链尾而 lastResponseId 还停在上一回合;或多窗口并发推进)时,首轮请求被
  // 400 拒且报错会被 recoverAfterStreamBreak 吞成"已恢复",用户消息就无声
  // 丢失。这里识别该错误,对账服务器链尾后原样重试一次;重试仍失败则把
  // 真实错误抛给调用方展示。
  const requestWithChainHeal = async (
    rt: SessionRuntime,
    sid: string,
    opts: SendOptions,
  ): Promise<ResponseResource> => {
    try {
      return await requestWithRetry(rt, sid, opts);
    } catch (err) {
      const mismatch =
        err instanceof GoderApiError && /not the latest response|forking history/i.test(err.message);
      if (!mismatch || opts.signal?.aborted) throw err;
      const detail = await deps.client.getConversation(sid).catch(() => null);
      const tail = detail?.last_response_id;
      if (!tail || tail === opts.previousResponseId) throw err;
      deps.log('warn', deps.t('会话链尾已前移(停止/多窗口并发),对账后自动重发'));
      deps.adoptChainTail(sid, tail);
      return await requestWithRetry(rt, sid, { ...opts, previousResponseId: tail });
    }
  };

  return { requestWithChainHeal, tryRecoverFinal };
}
