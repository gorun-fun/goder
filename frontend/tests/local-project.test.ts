// local-project.test.ts — 单项目模式(configure localProject):项目概念
// 对使用者不可见,全部会话落一个隐藏的固定 id 默认项目。覆盖:补建与
// 存量未分组迁移(持久化注入)、无参 newDraft 落点、服务端同步新会话
// 落点(scripted api)、LOCAL 项目不可删。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireScope, releaseScope, setLocalProject, LOCAL, UNGROUPED } from '../src/core/store/scope';
import { setPersistence, localStoragePersistence, type ProjectsIndex } from '../src/core/store/persistence';
import { setApiFetch } from '../src/core/api/fetch';
import { createScriptedApi } from '../src/core/api/scripted-api';

describe('单项目模式(localProject)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    setApiFetch(undefined); // 恢复默认传输层,不泄漏到其他用例
    setPersistence(localStoragePersistence);
    await vi.advanceTimersByTimeAsync(31_000); // 归零 scope 延迟回收,停轮询
    vi.useRealTimers();
  });

  /** 新 scope:注入持久化种子并开启单项目模式(默认名「本地项目」)。 */
  function freshScope(seed?: ProjectsIndex) {
    const name = `lp-${Math.random().toString(36).slice(2)}`;
    setLocalProject(name, true);
    setPersistence({ load: async () => seed ?? null, save: async () => {} });
    const s = acquireScope(name);
    return { name, s };
  }

  it('reloadIndex:补建本地项目(默认名),存量未分组会话迁入', async () => {
    const seed: ProjectsIndex = {
      version: 1,
      projects: [{ id: UNGROUPED, name: '未分组会话', createdAt: '2026-01-01T00:00:00Z' }],
      sessions: { fc_old: { projectId: UNGROUPED, title: '旧会话', createdAt: '2026-01-01T00:00:00Z' } },
    };
    const { name, s } = freshScope(seed);
    await s.reloadIndex();
    expect(s.index.projects.find((p) => p.id === LOCAL)?.name).toBe('本地项目');
    expect(s.index.sessions['fc_old']?.projectId).toBe(LOCAL);
    releaseScope(name);
  });

  it('无参 newDraft、服务端同步新会话均落本地项目;LOCAL 不可删', async () => {
    const api = createScriptedApi({ conversations: [{ id: 'fc_remote', lastResponseId: 'resp_r' }] });
    setApiFetch(api.asFetch());
    const { name, s } = freshScope();
    await s.reloadIndex();
    const did = s.newDraft();
    expect(s.drafts.get(did)?.projectId).toBe(LOCAL);
    await s.refreshConversations();
    expect(s.index.sessions['fc_remote']?.projectId).toBe(LOCAL);
    s.deleteProject(LOCAL, false);
    expect(s.index.projects.find((p) => p.id === LOCAL)).toBeTruthy();
    releaseScope(name);
  });

  it('关闭模式(未配置)时行为不变:新会话仍落未分组', async () => {
    const api = createScriptedApi();
    setApiFetch(api.asFetch());
    const name = `lp-off-${Math.random().toString(36).slice(2)}`;
    setPersistence({ load: async () => null, save: async () => {} });
    const s = acquireScope(name);
    await s.reloadIndex();
    const did = s.newDraft();
    expect(s.drafts.get(did)?.projectId).toBe(UNGROUPED);
    releaseScope(name);
  });
});
