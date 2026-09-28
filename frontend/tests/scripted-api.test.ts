// scripted-api.test.ts — 可编程假后端:协议面对齐与脚本能力。
// 核心方法:真实 GoderClient / agent-api 函数 + setApiFetch 注入 fake,
// 反向锁定 scripted-api 与 client.ts / agent-api.ts 的协议一致性
// (路径/请求形状/响应形状漂移在此先红)。
import { describe, it, expect, afterEach } from 'vitest';
import { GoderClient, GoderApiError } from '../src/core/api/client';
import { setApiFetch } from '../src/core/api/fetch';
import { createScriptedApi } from '../src/core/api/scripted-api';
import { fetchModelCfg, putModelCfg } from '../src/core/settings/agent-api';
import type { SSEEvent } from '../src/core/api/types';

afterEach(() => {
  setApiFetch(undefined); // 恢复默认传输层,不泄漏到其他用例
});

function clientOn(api: ReturnType<typeof createScriptedApi>): GoderClient {
  setApiFetch(api.asFetch());
  return new GoderClient({ baseUrl: 'http://127.0.0.1:9999/goder-api', token: 't-test' });
}

describe('scripted-api 协议面(真实 client 全链路)', () => {
  it('health/会话列表/详情/历史:种子数据按 wire 形状返回', async () => {
    const api = createScriptedApi({
      conversations: [
        {
          id: 'fc_seed',
          lastResponseId: 'resp_seed',
          history: [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '在的' },
          ],
        },
      ],
    });
    const c = clientOn(api);
    await expect(c.health()).resolves.toBeUndefined();
    const list = await c.listConversations();
    expect(list.map((x) => x.id)).toEqual(['fc_seed']);
    expect(list[0]).toMatchObject({ object: 'conversation', workspace: expect.any(String) });
    const detail = await c.getConversation('fc_seed');
    expect(detail).toMatchObject({ id: 'fc_seed', paused: false, running: false, last_response_id: 'resp_seed' });
    const items = await c.conversationItems('fc_seed');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ role: 'user', content: '你好' });
    // 请求已记录(断言面)
    expect(api.requests().some((r) => r.method === 'GET' && r.path === '/conversations')).toBe(true);
  });

  it('默认回声场景:草稿发送 → 流式事件 → completed 终态 + 会话迁移', async () => {
    const api = createScriptedApi();
    const c = clientOn(api);
    const events: SSEEvent[] = [];
    const final = await c.send({
      input: '第一句问候',
      onEvent: (ev) => events.push(ev),
      idleTimeoutMs: 5_000,
    });
    // 终态与迁移
    expect(final.status).toBe('completed');
    expect(final['grf:session_id']).toMatch(/^fc_/);
    expect(final.model).toBe('fake-model');
    expect(final.usage?.total_tokens).toBeGreaterThan(0);
    // 流式:逐段 delta(过程态而非一次性)与事件顺序
    const deltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    const joined = deltas.map((d) => d.delta ?? '').join('');
    expect(joined).toContain('第一句问候');
    expect(events.at(-1)?.type).toBe('response.completed');
    // 新会话已建档、历史落定
    const sid = final['grf:session_id']!;
    const items = await c.conversationItems(sid);
    expect(items[0]).toMatchObject({ role: 'user', content: '第一句问候' });
    expect(items.at(-1)).toMatchObject({ role: 'assistant' });
    const detail = await c.getConversation(sid);
    expect(detail.running).toBe(false);
    expect(detail.last_response_id).toBe(final.id);
    // 第二轮:previous_response_id 链定位同一会话
    const second = await c.send({ input: '第二句', previousResponseId: final.id });
    expect(second['grf:session_id']).toBe(sid);
    const items2 = await c.conversationItems(sid);
    expect(items2.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('approval-pause 场景:incomplete 终态挂起会话(paused=true)', async () => {
    const api = createScriptedApi().scenario('approval-pause');
    const c = clientOn(api);
    const final = await c.send({ input: '删个文件' });
    expect(final.status).toBe('incomplete');
    expect(final.incomplete_details?.reason).toBe('grf:input_required');
    expect(final.incomplete_details?.grf_requests?.[0]).toMatchObject({ name: 'bash', kind: 'function' });
    const detail = await c.getConversation(final['grf:session_id']!);
    expect(detail.paused).toBe(true);
    expect(detail.running).toBe(false);
    // 应答回传:input_result 续跑走默认回声
    const req = final.incomplete_details!.grf_requests![0];
    const resumed = await c.send({
      previousResponseId: final.id,
      input: [{ type: 'grf:input_result', call_id: req.call_id, approved: true }],
    });
    expect(resumed.status).toBe('completed');
  });

  it('failNext:匹配的下一次发送返回非 2xx(GoderApiError 形状)', async () => {
    const api = createScriptedApi();
    const c = clientOn(api);
    api.failNext({ inputIncludes: '引爆' }, { status: 503, message: '上游维护中' });
    await expect(c.send({ input: '请引爆错误' })).rejects.toMatchObject({
      status: 503,
      message: '上游维护中',
    });
    // 一次性:规则消费后恢复
    await expect(c.send({ input: '再来一次' })).resolves.toMatchObject({ status: 'completed' });
  });

  it('stream-break 场景:流无终态中断,retrieveResponse 对账恢复', async () => {
    const api = createScriptedApi().scenario('stream-break');
    const c = clientOn(api);
    await expect(c.send({ input: '断一下' })).rejects.toBeInstanceOf(GoderApiError);
    // 断流后 retrieve 拿回预写终态(前端 recoverAfterStreamBreak 的依据)
    const sid = api.state().conversations.find((x) => x.turns === 1)?.id;
    expect(sid).toBeTruthy();
    const detail = await c.getConversation(sid!);
    const recovered = await c.retrieveResponse(detail.last_response_id!);
    expect(recovered).toMatchObject({ status: 'completed' });
    expect(recovered!.output.at(-1)).toMatchObject({ type: 'message', role: 'assistant' });
  });

  it('慢流中 cancel:端点返回 cancelled 资源,会话 running 收口', async () => {
    const api = createScriptedApi().scenario('slow-stream');
    const c = clientOn(api);
    const p = c.send({
      input: '慢慢说',
      // 前端真实行为:curRespId 随 SSE 事件随到随记,cancel 用它寻址
      onEvent: (ev) => { if (ev.response?.id) respId = ev.response.id; },
    });
    let respId = '';
    await new Promise((r) => setTimeout(r, 700)); // 等首帧建立 curRespId
    const sid = api.state().conversations[0].id;
    const detail = await c.getConversation(sid);
    expect(detail.running).toBe(true);
    expect(respId).toMatch(/^resp_/);
    const cancelled = await c.cancelResponse(respId);
    // slow-stream 进行中 last_responseId 未写:cancel 走 runningRounds 命中
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    // 流上随后送达 cancelled 终态帧(与真实服务端一致),send 正常收口
    await expect(p).resolves.toMatchObject({ status: 'cancelled' });
    await new Promise((r) => setTimeout(r, 100));
    expect((await c.getConversation(sid)).running).toBe(false);
  });

  it('scriptNext 定制脚本:帧序列与自动补齐的公共字段', async () => {
    const api = createScriptedApi();
    const c = clientOn(api);
    api.scriptNext({ inputIncludes: '定制' }, [
      { delay: 10, event: { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_x', role: 'assistant', status: 'in_progress', content: [] } } },
      { delay: 10, event: { type: 'response.output_text.delta', item_id: 'msg_x', delta: '定制回复' } },
    ]);
    const final = await c.send({ input: '请给我定制内容' });
    expect(final.status).toBe('completed');
    // 公共字段自动补齐:每帧 response.id 一致(curRespId 寻址的前提)
    const seen = api.requests().filter((r) => r.path === '/responses');
    expect(seen.at(-1)?.body).toMatchObject({ input: '请给我定制内容', stream: true });
  });

  it('scriptConversation 队列:会话定向、逐轮消费、耗尽回落场景', async () => {
    const api = createScriptedApi();
    const c = clientOn(api);
    const first = await c.send({ input: 'round1' });
    const sid = first['grf:session_id']!;
    api.scriptConversation(sid, [
      { delay: 5, event: { type: 'grf:notice', kind: 'notice', detail: '定向脚本消息' } },
    ]);
    const second = await c.send({ input: 'round2', previousResponseId: first.id });
    const third = await c.send({ input: 'round3', previousResponseId: second.id });
    expect(second.status).toBe('completed');
    expect(third.status).toBe('completed'); // 队列耗尽回落默认 echo
  });

  it('task-block / notice-todos 等场景:终态资源携带对应内容', async () => {
    const api = createScriptedApi();
    const c = clientOn(api);
    api.scenario('task-block');
    const task = await c.send({ input: '沉淀任务' });
    const text = (task.output.at(-1)?.content ?? []).map((p) => p.text ?? '').join('');
    expect(text).toContain('<goder-task>');
    api.scenario('notice-todos');
    const events: SSEEvent[] = [];
    await c.send({ input: '带清单的回复', onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'grf:notice' && e.kind === 'todos')).toBe(true);
  });

  it('agent-api:默认模型配置/探测/PUT 回读', async () => {
    const api = createScriptedApi();
    const c = clientOn(api);
    const base = c.config.baseUrl;
    const cfg = await fetchModelCfg(base, 't-test');
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]).toMatchObject({ name: 'fake', hasKey: true, models: ['fake/chat', 'fake/pro'] });
    cfg.providers.push({ name: 'added', type: '', baseUrl: 'https://x.invalid', apiKey: '', models: [] });
    await putModelCfg(base, 't-test', cfg);
    const reread = await fetchModelCfg(base, 't-test');
    expect(reread.providers.map((p) => p.name)).toEqual(['fake', 'added']);
  });

  it('归档与 404 语义', async () => {
    const api = createScriptedApi({ conversations: [{ id: 'fc_gone' }] });
    const c = clientOn(api);
    await c.archiveConversation('fc_gone');
    expect((await c.listConversations())).toHaveLength(0);
    await expect(c.getConversation('fc_missing')).rejects.toMatchObject({ status: 404 });
    expect(await c.retrieveResponse('resp_missing')).toBeNull();
  });
});

describe('fetch 注入点', () => {
  it('setApiFetch 装载与恢复', async () => {
    const original = (globalThis.fetch.bind(globalThis), typeof globalThis.fetch);
    expect(original).toBe('function');
    const api = createScriptedApi();
    setApiFetch(api.asFetch());
    const c = new GoderClient({ baseUrl: '/goder-api', token: '' });
    await expect(c.health()).resolves.toBeUndefined(); // 命中 fake
    setApiFetch(undefined);
    expect(() => new GoderClient({ baseUrl: '/goder-api', token: '' })).not.toThrow();
  });
});
