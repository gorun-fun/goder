// registry.test.ts — registry 装配协议:四区 Zone API、scopes 过滤、
// 工具元数据与渲染器优先级。
import { describe, it, expect, beforeEach } from 'vitest';
import { registry, sideTabId, type SideTabDef, type PanelContext } from '../src/registry/registry';
import { toolLabel } from '../src/util/fmt';
import { applyEvent, newRuntime } from '../src/core/model/chat-model';
import type { SSEEvent } from '../src/core/api/types';

const ctx = (scope = 'default'): PanelContext => ({ scope, store: undefined as never, desktop: false });

// ---------- registry:装配协议 ----------

describe('registry Zone', () => {
  beforeEach(() => {
    registry.nav.remove('t1');
    registry.side.remove('s1');
    registry.side.remove('s2');
  });

  it('add 不改写入参对象(同一份 def 可复用注册)', () => {
    const def = { id: 't1', label: 'x', view: () => undefined as never };
    registry.nav.add(def);
    expect((def as { order?: number }).order).toBeUndefined();
    expect(registry.nav.get('t1')?.order).toBeDefined();
  });

  it('同 id 覆盖,scopes 过滤 per-scope 可见性', () => {
    const a: SideTabDef = { id: 's1', label: 'A', icon: 'i', render: () => undefined as never, scopes: ['app'] };
    const b: SideTabDef = { id: 's2', label: 'B', icon: 'i', render: () => undefined as never };
    registry.side.add(a);
    registry.side.add(b);
    expect(registry.side.visible(ctx('app')).map((d) => d.id)).toContain('s1');
    expect(registry.side.visible(ctx('other')).map((d) => d.id)).not.toContain('s1');
    expect(registry.side.visible(ctx('other')).map((d) => d.id)).toContain('s2');
    // hide 后 visible 排除
    registry.side.hide('s2');
    expect(registry.side.visible(ctx('other')).map((d) => d.id)).not.toContain('s2');
    registry.side.show('s2');
    expect(registry.side.visible(ctx('other')).map((d) => d.id)).toContain('s2');
  });

  it('sideTabId 多实例带 key', () => {
    expect(sideTabId({ defId: 'file', key: '/a/b.ts' })).toBe('file:/a/b.ts');
    expect(sideTabId({ defId: 'detail' })).toBe('detail');
  });

  it('工具元数据注册与查询(label/detail 优先于内置)', () => {
    registry.chat.addToolMeta({ name: 'mcp__x__y', label: '自家的' });
    expect(toolLabel('mcp__x__y')).toBe('自家的');
    expect(toolLabel('bash')).toBe('终端'); // 内置不受影响
    registry.chat.removeToolMeta('mcp__x__y');
    expect(toolLabel('bash')).toBe('终端');
  });

  it('渲染器按工具名优先于 kind 匹配', () => {
    const picked: string[] = [];
    registry.chat.addRenderer({ id: 'r-kind', kind: 'tool', render: () => undefined });
    registry.chat.addRenderer({
      id: 'r-tool',
      toolName: 'mcp__x__y',
      render: () => {
        picked.push('tool-name');
        return undefined;
      },
    });
    const rt = newRuntime();
    applyEvent(rt, { type: 'grf:tool_call.in_progress', item: { type: 'grf:tool_call', name: 'mcp__x__y', call_id: 'c1', arguments: '' } } as unknown as SSEEvent);
    const toolItem = rt.items.find((i) => i.kind === 'tool');
    expect(toolItem).toBeDefined();
    const chosen = registry.chat.rendererFor(toolItem!);
    expect(chosen?.id).toBe('r-tool'); // 后注册的工具名渲染者优先于 kind 渲染器
    registry.chat.removeRenderer('r-tool');
    registry.chat.removeRenderer('r-kind');
    void picked;
  });
});
