// storage.test.ts — 可注入键值存储。
import { describe, it, expect } from 'vitest';
import { MemoryStorage, setKeyValueStorage, keyValueStorage, kvSet, kvGet, kvDel } from '../src/core/store/storage';

// ---------- 可注入存储 ----------

describe('KeyValueStorage', () => {
  it('注入替换后 kv* 走新存储', () => {
    const mem = new MemoryStorage();
    setKeyValueStorage(mem);
    expect(keyValueStorage()).toBe(mem);
    kvSet('k', { a: 1 });
    expect(mem.getItem('k')).toBe('{"a":1}');
    expect(kvGet<{ a: number }>('k')?.a).toBe(1);
    kvDel('k');
    expect(kvGet('k')).toBeNull();
  });

  it('kvGet 容错:损坏 JSON 与不存在均返回 null', () => {
    const mem = new MemoryStorage();
    setKeyValueStorage(mem);
    mem.setItem('bad', '{oops');
    expect(kvGet('bad')).toBeNull();
    expect(kvGet('missing')).toBeNull();
  });
});
