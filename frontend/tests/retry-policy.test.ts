// retry-policy.test.ts — 流恢复策略与 API 错误(重试判定的输入)。
import { describe, it, expect } from 'vitest';
import { defaultRetryPolicy, setRetryPolicy, resetRetryPolicy } from '../src/core/store/retry-policy';
import { GrfApiError } from '../src/core/api/client';

// ---------- 恢复策略 ----------

describe('RetryPolicy', () => {
  it('默认判定:连接类可重试,业务错误不重试', () => {
    expect(defaultRetryPolicy.isRetryableError(new TypeError('fetch failed'))).toBe(true);
    expect(defaultRetryPolicy.isRetryableFailure('llm: read stream: unexpected EOF')).toBe(true);
    expect(defaultRetryPolicy.isRetryableFailure('401 unauthorized')).toBe(false);
    expect(defaultRetryPolicy.backoffMs(0)).toBe(800);
    expect(defaultRetryPolicy.backoffMs(9)).toBe(4000);
  });

  it('注入覆写生效,reset 恢复默认', async () => {
    setRetryPolicy({ streamRetryMax: 3, isRetryableFailure: () => true });
    const mod = await import('../src/core/store/retry-policy');
    expect(mod.getRetryPolicy().streamRetryMax).toBe(3);
    expect(mod.getRetryPolicy().isRetryableFailure('anything')).toBe(true);
    resetRetryPolicy();
    expect(mod.getRetryPolicy().streamRetryMax).toBe(10);
    expect(mod.getRetryPolicy().isRetryableFailure('401 unauthorized')).toBe(false);
  });
});

// ---------- GrfApiError(重试判定的输入) ----------

describe('GrfApiError', () => {
  it('携带 status/code', () => {
    const e = new GrfApiError(401, 'unauthorized', 'x');
    expect(e.status).toBe(401);
    expect(e.code).toBe('unauthorized');
    expect(e.isUnauthorized()).toBe(true);
    expect(defaultRetryPolicy.isRetryableError(e)).toBe(false);
    const s = new GrfApiError(0, 'stream_interrupted', 'y');
    expect(defaultRetryPolicy.isRetryableError(s)).toBe(true);
  });
});
