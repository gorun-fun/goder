// model-inherit.test.ts — 新会话模型继承的「成功」口径:SessionRecord.model
// 只随非 failed 回合记录(send/submitInputResult 成功块),失败回合不污染
// 继承源 —— newDraft(inheritProjectPrefs)继承到的总是最近一次跑通的模型。
// 附带锁定 goder:round-completed 的 ok 语义(completed/incomplete → true,
// failed → false;docs/embedding.md「ok=正常完成」)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireScope, releaseScope } from '../src/core/store/scope';
import { setPersistence, localStoragePersistence } from '../src/core/store/persistence';
import { setApiFetch } from '../src/core/api/fetch';
import { createScriptedApi } from '../src/core/api/scripted-api';

type Scope = ReturnType<typeof acquireScope>;

/** 新 scope:空持久化种子(会话记录全部由本次发送产生)。 */
function freshScope(): { name: string; s: Scope } {
  const name = `mi-${Math.random().toString(36).slice(2)}`;
  setPersistence({ load: async () => null, save: async () => {} });
  return { name, s: acquireScope(name) };
}

/** 假时钟下驱动回合收口:流式帧与退避都由 advanceTimersByTimeAsync 推进。 */
async function settle(p: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(20_000);
  await p;
}

/** 捕获 goder:round-completed 的 ok 序列(node 测试环境无 window,
 * stub 一个 EventTarget 供 emitDom 派发)。 */
function captureRounds(): { ok: boolean[]; off: () => void } {
  const target = new EventTarget();
  const ok: boolean[] = [];
  target.addEventListener('goder:round-completed', (e) =>
    ok.push((e as CustomEvent<{ ok: boolean }>).detail.ok),
  );
  vi.stubGlobal('window', target);
  return { ok, off: () => vi.unstubAllGlobals() };
}

describe('新会话模型继承(只随非 failed 回合记录)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    setApiFetch(undefined); // 恢复默认传输层,不泄漏到其他用例
    setPersistence(localStoragePersistence);
    vi.unstubAllGlobals();
    await vi.advanceTimersByTimeAsync(31_000); // 归零 scope 延迟回收,停轮询
    vi.useRealTimers();
  });

  it('成功回合记录模型全名与思考强度,新会话继承;round-completed ok=true', async () => {
    const api = createScriptedApi();
    setApiFetch(api.asFetch());
    const { name, s } = freshScope();
    const rounds = captureRounds();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    s.newDraft();
    s.setModel('prov/good');
    await settle(s.send('你好'));
    const [sid] = Object.keys(s.index.sessions);
    expect(sid).toMatch(/^fc_/);
    expect(s.index.sessions[sid]).toMatchObject({ model: 'prov/good', effort: 'high' });
    expect(rounds.ok).toEqual([true]);
    // 新会话:同项目(此处同为未分组)最近会话的模型
    s.newDraft();
    expect(s.model).toBe('prov/good');
    rounds.off();
    releaseScope(name);
  });

  it('failed 终态回合不记模型:更近的失败会话不抢继承,新会话仍用上一个成功模型;ok=false', async () => {
    const api = createScriptedApi();
    setApiFetch(api.asFetch());
    const { name, s } = freshScope();
    const rounds = captureRounds();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    s.newDraft();
    s.setModel('prov/good');
    await settle(s.send('你好'));
    const good = Object.keys(s.index.sessions)[0]!;

    // 更近的一次对话换坏模型,回合 failed(错误文案非连接类,不被重试层拦下)
    api.scenario('server-fail-frame');
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    s.newDraft();
    expect(s.model).toBe('prov/good'); // 继承基线
    s.setModel('prov/bad');
    await settle(s.send('坏模型走你'));
    const bad = Object.keys(s.index.sessions).find((x) => x !== good)!;
    // 链尾与活跃度照常推进,但模型/思考强度不随失败回合写入
    expect(s.index.sessions[bad]?.lastResponseId).toBeTruthy();
    expect(s.index.sessions[bad]?.updatedAt).toBeTruthy();
    expect(s.index.sessions[bad]?.model).toBeUndefined();
    expect(s.index.sessions[bad]?.effort).toBeUndefined();
    expect(rounds.ok).toEqual([true, false]);
    // 新会话:继承最近一次跑通的模型,而不是更近的失败模型
    s.newDraft();
    expect(s.model).toBe('prov/good');
    rounds.off();
    releaseScope(name);
  });

  it('incomplete(approval-pause)模型已生成,照记并可继承;ok=true', async () => {
    const api = createScriptedApi().scenario('approval-pause');
    setApiFetch(api.asFetch());
    const { name, s } = freshScope();
    const rounds = captureRounds();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    s.newDraft();
    s.setModel('prov/ask');
    await settle(s.send('删个文件'));
    const [sid] = Object.keys(s.index.sessions);
    expect(s.index.sessions[sid]?.model).toBe('prov/ask');
    expect(rounds.ok).toEqual([true]);
    s.newDraft();
    expect(s.model).toBe('prov/ask');
    rounds.off();
    releaseScope(name);
  });
});
