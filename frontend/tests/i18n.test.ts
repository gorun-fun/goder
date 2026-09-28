// i18n.test.ts — gettext 风格文案通道。
import { describe, it, expect } from 'vitest';
import { setI18n, translate, tFor } from '../src/core/i18n';

// ---------- i18n ----------

describe('i18n', () => {
  it('key 即默认文案,命中返回译文并插值', () => {
    setI18n('t-scope', { locale: 'en', messages: { '新会话': 'New chat', '已排队 {n} 条': 'queued {n}' } });
    expect(translate('t-scope', '新会话')).toBe('New chat');
    expect(translate('t-scope', '已排队 {n} 条', { n: 3 })).toBe('queued 3');
    expect(translate('t-scope', '未覆盖的文案')).toBe('未覆盖的文案');
    expect(translate('other-scope', '新会话')).toBe('新会话');
    expect(tFor('t-scope')('新会话')).toBe('New chat');
    setI18n('t-scope', undefined);
    expect(translate('t-scope', '新会话')).toBe('新会话');
  });
});
