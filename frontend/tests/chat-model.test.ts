// chat-model.test.ts — SSE 归约器与历史还原。
import { describe, it, expect } from 'vitest';
import { applyEvent, materializeRequest, newRuntime, todosFromItems, historyToItems } from '../src/core/model/chat-model';
import type { SSEEvent } from '../src/core/api/types';

// ---------- SSE 归约器 ----------

describe('applyEvent', () => {
  it('assistant 流式 delta 跟随 output_item 寻址', () => {
    const rt = newRuntime();
    const c1 = applyEvent(rt, {
      type: 'response.output_item.added',
      item: { type: 'message', role: 'assistant', id: 'it_1' },
    } as unknown as SSEEvent);
    applyEvent(rt, { type: 'response.output_text.delta', item_id: 'it_1', delta: '回' } as unknown as SSEEvent);
    applyEvent(rt, { type: 'response.output_text.delta', item_id: 'it_1', delta: '复' } as unknown as SSEEvent);
    expect(c1).toBe(true);
    const asst = rt.items.find((i) => i.kind === 'assistant');
    expect(asst && asst.kind === 'assistant' && asst.text).toBe('回复');
    expect(asst && asst.kind === 'assistant' && asst.streaming).toBe(true);
    // 完成事件:streaming 归假
    applyEvent(rt, {
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', id: 'it_1', content: [{ type: 'output_text', text: '回复' }] },
    } as unknown as SSEEvent);
    expect(asst && asst.kind === 'assistant' && asst.streaming).toBe(false);
  });

  it('historyToItems 还原用户消息与工具结果(伪 user 消息不进气泡)', () => {
    const items = historyToItems([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: [{ type: 'text', text: '在' }] },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file-a' },
    ] as never);
    expect(items.filter((i) => i.kind === 'user').length).toBe(1);
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool && tool.kind === 'tool' && tool.output).toBe('file-a');
  });

  it('工具调用物化为 tool 条目(名字/参数/结果)', () => {
    const rt = newRuntime();
    applyEvent(rt, { type: 'grf:tool_call.started', item: { type: 'grf:tool_call', name: 'bash', call_id: 'c9', arguments: '{"command":"ls"}' } } as unknown as SSEEvent);
    applyEvent(rt, { type: 'grf:tool_call.completed', item: { type: 'grf:tool_call', name: 'bash', call_id: 'c9', arguments: '{"command":"ls"}', output_text: 'file-a\nfile-b' } } as unknown as SSEEvent);
    const tool = rt.items.find((i) => i.kind === 'tool');
    expect(tool && tool.kind === 'tool' && tool.name).toBe('bash');
    expect(tool && tool.kind === 'tool' && tool.output).toContain('file-a');
  });

  it('input_required 物化 ask/approval 卡片,幂等不重复', () => {
    const rt = newRuntime();
    const req = { call_id: 'q1', name: 'ask_user_question', kind: 'question' as const, arguments: '{"questions":[{"id":"q1","question":"选?"}]}' };
    expect(materializeRequest(rt, req)).toBe(true);
    expect(materializeRequest(rt, req)).toBe(true); // 恢复 pending,不新增
    expect(rt.items.filter((i) => i.kind === 'ask').length).toBe(1);
    const ap = { call_id: 'a1', name: 'bash', kind: 'tool_approval' as const, arguments: '{"command":"rm"}' };
    materializeRequest(rt, ap);
    const approval = rt.items.find((i) => i.kind === 'approval');
    expect(approval && approval.kind === 'approval' && approval.name).toBe('bash');
  });

  it('todo_write 还原任务列表(todos 随工具参数)', () => {
    const rt = newRuntime();
    applyEvent(rt, {
      type: 'grf:tool_call.completed',
      item: { type: 'grf:tool_call', name: 'todo_write', call_id: 't1', arguments: '{\"todos\":[{\"content\":\"a\",\"status\":\"pending\"},{\"content\":\"b\",\"status\":\"completed\"}]}' },
    } as unknown as SSEEvent);
    expect(todosFromItems(rt.items)?.length).toBe(2);
  });
});
