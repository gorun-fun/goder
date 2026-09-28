// send-pipeline.test.ts — 发送/恢复管线:三层重试与终态对账的决策逻辑
// (mock 客户端,不触网)。管线是断流自愈的核心路径,抽出独立模块后
// 在此覆盖各分支。
import { describe, it, expect, vi } from 'vitest';
import { createSendPipeline, errText, type SendPipelineDeps } from '../src/core/store/send-pipeline';
import { GoderApiError } from '../src/core/api/client';
import { newRuntime } from '../src/core/model/chat-model';
import type { ResponseResource, SendOptions } from '../src/core/api/types';

const done = (patch: Partial<ResponseResource> = {}): ResponseResource =>
  ({ id: 'resp_1', status: 'completed', output: [], ...patch }) as ResponseResource;

interface Ctx {
  sends: SendOptions[];
  logs: string[];
  adopted: [string, string][];
  applied: number;
}

function makePipeline(
  client: Pick<SendPipelineDeps['client'], 'send' | 'getConversation' | 'retrieveResponse'>,
): { pipeline: ReturnType<typeof createSendPipeline>; ctx: Ctx } {
  const ctx: Ctx = { sends: [], logs: [], adopted: [], applied: 0 };
  const pipeline = createSendPipeline({
    client,
    log: (_level, text) => ctx.logs.push(text),
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    onApplied: () => ctx.applied++,
    adoptChainTail: (sid, respId) => ctx.adopted.push([sid, respId]),
  });
  return { pipeline, ctx };
}

describe('send-pipeline', () => {
  it('成功发送直通,无重试无日志', async () => {
    const { pipeline, ctx } = makePipeline({
      send: async (o) => {
        ctx.sends.push(o);
        return done();
      },
      getConversation: async () => ({ last_response_id: 'resp_1' }) as never,
      retrieveResponse: async () => null as never,
    });
    const rt = newRuntime();
    const out = await pipeline.requestWithChainHeal(rt, 's1', { input: [] } as SendOptions);
    expect(out.status).toBe('completed');
    expect(ctx.sends.length).toBe(1);
    expect(ctx.logs.length).toBe(0);
  });

  it('fetch 抛连接错且终态可对账:拿快照返回,不重发', async () => {
    let sent = 0;
    const { pipeline, ctx } = makePipeline({
      send: async () => {
        sent++;
        if (sent === 1) throw new TypeError('fetch failed');
        return done();
      },
      getConversation: async () => ({ last_response_id: 'resp_9' }) as never,
      retrieveResponse: async () => done({ id: 'resp_9', usage: { input_tokens: 10, output_tokens: 5 } as never }),
    });
    const rt = newRuntime();
    const out = await pipeline.requestWithChainHeal(rt, 's1', { input: [] } as SendOptions);
    expect(out.id).toBe('resp_9');
    expect(sent).toBe(1); // 没有盲目重发
    expect(ctx.applied).toBe(1); // 快照已应用并通知刷新
  });

  it('failed 终态为连接类错误:清错误条目,挂失败 id 退避重发', async () => {
    let sent = 0;
    const { pipeline, ctx } = makePipeline({
      send: async (o) => {
        sent++;
        ctx.sends.push(o);
        if (sent === 1) return done({ id: 'resp_f', status: 'failed', error: { message: 'llm: read stream: unexpected EOF' } }) as never;
        return done({ id: 'resp_2' });
      },
      getConversation: async () => ({ last_response_id: '' }) as never,
      retrieveResponse: async () => null as never,
    });
    const rt = newRuntime();
    rt.items.push({ kind: 'error', id: 'e1', text: '发送失败:llm: read stream: unexpected EOF' });
    const out = await pipeline.requestWithChainHeal(rt, 's1', { input: [] } as SendOptions);
    expect(out.id).toBe('resp_2');
    expect(sent).toBe(2);
    // 重发挂在失败 response 之后(不挂链会分叉出新会话)
    expect(ctx.sends[1].previousResponseId).toBe('resp_f');
    // 本次物化的连接类错误条目被清掉
    expect(rt.items.some((i) => i.kind === 'error')).toBe(false);
  });

  it('链尾失配 400:对账服务器链尾后带新尾重试一次', async () => {
    let sent = 0;
    const { pipeline, ctx } = makePipeline({
      send: async (o) => {
        sent++;
        ctx.sends.push(o);
        if (sent === 1) throw new GoderApiError(400, 'bad_request', 'resp_x is not the latest response in the conversation');
        return done({ id: 'resp_ok' });
      },
      getConversation: async () => ({ last_response_id: 'resp_server_tail' }) as never,
      retrieveResponse: async () => null as never,
    });
    const rt = newRuntime();
    const out = await pipeline.requestWithChainHeal(rt, 's1', { input: [], previousResponseId: 'resp_old' } as SendOptions);
    expect(out.id).toBe('resp_ok');
    expect(sent).toBe(2);
    expect(ctx.adopted).toEqual([['s1', 'resp_server_tail']]);
    expect(ctx.sends[1].previousResponseId).toBe('resp_server_tail');
  });

  it('非重试错误(401)原样抛出,不重试', async () => {
    const { pipeline } = makePipeline({
      send: async () => {
        throw new GoderApiError(401, 'unauthorized', 'token expired');
      },
      getConversation: async () => ({ last_response_id: '' }) as never,
      retrieveResponse: async () => null as never,
    });
    const rt = newRuntime();
    await expect(pipeline.requestWithChainHeal(rt, 's1', { input: [] } as SendOptions)).rejects.toThrow('token expired');
  });

  it('链尾失配但服务器尾与请求一致:真实错误上抛(不无限循环)', async () => {
    const { pipeline } = makePipeline({
      send: async () => {
        throw new GoderApiError(400, 'bad_request', 'forking history is not supported');
      },
      getConversation: async () => ({ last_response_id: 'resp_old' }) as never,
      retrieveResponse: async () => null as never,
    });
    const rt = newRuntime();
    await expect(
      pipeline.requestWithChainHeal(rt, 's1', { input: [], previousResponseId: 'resp_old' } as SendOptions),
    ).rejects.toThrow('forking history');
  });
});

describe('errText', () => {
  it('Error 取 message;已知后端错误翻成可操作提示', () => {
    expect(errText(new Error('boom'))).toBe('boom');
    expect(errText(String('plain'))).toBe('plain');
    const t = (k: string) => k;
    expect(errText(new Error('... enable-auto-tool-choice ...'), t)).toContain('当前模型服务未开启工具调用');
  });
});
