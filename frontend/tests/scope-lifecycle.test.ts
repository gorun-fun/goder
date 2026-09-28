// scope-lifecycle.test.ts — scope 引用计数与延迟回收:面板挂载/断开
// 经 acquire/release 配对,归零后延迟清理轮询定时器并摘注册表;期间
// 再 acquire 取消回收。宿主 configure 的内存连接配置在回收重建后保留。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireScope, releaseScope, configureScope } from '../src/core/store/scope';

describe('scope 生命周期(引用计数 + 延迟回收)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquire/release 配对;归零延迟 30s 后回收(定时器停、注册表摘除)', async () => {
    const name = `lc-${Math.random().toString(36).slice(2)}`;
    const s1 = acquireScope(name);
    // scope 暴露的定时器句柄为私有;回收效果以两次 acquire 的实例同一性
    // 与延迟窗口后的实例更替来观察。
    const s2 = acquireScope(name);
    expect(s2).toBe(s1);
    releaseScope(name);
    releaseScope(name);
    // 归零后立即再挂载:取消回收,实例不变
    const s3 = acquireScope(name);
    expect(s3).toBe(s1);
    releaseScope(name);
    // 延迟窗口过后:实例被回收,再 acquire 是新实例(stop 已清轮询定时器)
    await vi.advanceTimersByTimeAsync(31_000);
    const s4 = acquireScope(name);
    expect(s4).not.toBe(s1);
    releaseScope(name);
    await vi.advanceTimersByTimeAsync(31_000);
  });

  it('回收重建不丢宿主 configure 注入的内存配置(未持久化 token)', async () => {
    const name = `cfg-${Math.random().toString(36).slice(2)}`;
    configureScope(name, { baseUrl: '/grf-api', token: 'host-secret' });
    const s1 = acquireScope(name);
    expect(s1.client.config.token).toBe('host-secret');
    releaseScope(name);
    await vi.advanceTimersByTimeAsync(31_000);
    const s2 = acquireScope(name);
    expect(s2.client.config.baseUrl).toBe('/grf-api');
    expect(s2.client.config.token).toBe('host-secret');
    releaseScope(name);
    await vi.advanceTimersByTimeAsync(31_000);
  });
});
