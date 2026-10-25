// appearance.test.ts — 外观纯计算的回归:CSS 变量表生成(默认外观全
// 清除、浅色皮肤覆写、自定义强调色派生、默认蓝浅色文字加深、字号档、
// 跟随系统落定)与 localStorage 镜像读取(旧档位迁移、越界钳制、损坏回退)。
// 该模块无 DOM 依赖,node 测试环境直接单测(存储经可注入 KV 通道)。
import { describe, expect, it } from 'vitest';
import { ACCENTS, DEFAULT_APPEARANCE, LS_KEY, appearanceCssVars, loadAppearanceLocal, resolveTheme } from '../src/core/settings/appearance';
import type { Appearance } from '../src/core/settings/appearance';
import { MemoryStorage, setKeyValueStorage, kvSet } from '../src/core/store/storage';

const ap = (patch: Partial<Appearance>): Appearance => ({ ...DEFAULT_APPEARANCE, ...patch });

describe('appearanceCssVars', () => {
  it('默认外观(深色 + 默认蓝 + 13.5px)全表为 null(走 ui/theme.ts 默认值)', () => {
    const vars = appearanceCssVars(DEFAULT_APPEARANCE, 'dark');
    expect(Object.keys(vars)).toHaveLength(21); // 15 skin + 3 accent + 3 字号
    for (const v of Object.values(vars)) expect(v).toBeNull();
  });

  it('浅色主题整体覆写皮肤,深色清除', () => {
    const light = appearanceCssVars(ap({ theme: 'light' }), 'light');
    expect(light['--goder-skin-bg']).toBe('#f4f5f7');
    expect(light['--goder-skin-text']).toBe('#26292f');
    // 左栏分割线:浅色灰线、深色清除(走 ui/theme.ts 的透明默认值)
    expect(light['--goder-skin-border-split']).toBe('#d5d8de');
    const dark = appearanceCssVars(ap({ theme: 'dark' }), 'dark');
    expect(dark['--goder-skin-bg']).toBeNull();
    expect(dark['--goder-skin-text']).toBeNull();
    expect(dark['--goder-skin-border-split']).toBeNull();
  });

  it('system 模式完全由落定深浅决定(探测在 settings-store,纯计算侧只认入参)', () => {
    const sysDark = appearanceCssVars(ap({ theme: 'system' }), 'dark');
    expect(sysDark['--goder-skin-bg']).toBeNull();
    expect(sysDark['--goder-skin-border-split']).toBeNull();
    const sysLight = appearanceCssVars(ap({ theme: 'system' }), 'light');
    expect(sysLight['--goder-skin-bg']).toBe('#f4f5f7');
    expect(sysLight['--goder-skin-border-split']).toBe('#d5d8de');
    // 默认蓝浅色落定时仍写加深文字变体(与显式浅色同口径)
    expect(sysLight['--goder-skin-accent-text']).toBe(ACCENTS.blue.textOnLight);
  });

  it('resolveTheme:显式模式原样,system 按系统探测落定', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('自定义 hex 强调色派生各主题变体(text 向白、textOnLight 向黑插值)', () => {
    const vars = appearanceCssVars(ap({ accent: '#336699' }), 'dark');
    expect(vars['--goder-skin-accent']).toBe('#336699');
    expect(vars['--goder-skin-accent-text']).toBe('#6c91b6'); // (51,102,153) 向白 0.28
    expect(vars['--goder-skin-accent-soft']).toBe('rgba(51, 102, 153, 0.16)');
    const lightVars = appearanceCssVars(ap({ theme: 'light', accent: '#336699' }), 'light');
    expect(lightVars['--goder-skin-accent-text']).toBe('#214263'); // 向黑 0.35
  });

  it('大写 hex 归一为小写', () => {
    expect(appearanceCssVars(ap({ accent: '#4C8DFF' }), 'dark')['--goder-skin-accent']).toBe('#4c8dff');
  });

  it('预设 key 强调色直接用预设表', () => {
    const vars = appearanceCssVars(ap({ accent: 'rose' }), 'dark');
    expect(vars['--goder-skin-accent']).toBe(ACCENTS.rose.accent);
    expect(vars['--goder-skin-accent-text']).toBe(ACCENTS.rose.text);
  });

  it('非法强调色回退默认蓝', () => {
    const vars = appearanceCssVars(ap({ accent: 'not-a-color' }), 'dark');
    expect(vars['--goder-skin-accent']).toBe(ACCENTS.blue.accent);
    expect(vars['--goder-skin-accent-soft']).toBe(ACCENTS.blue.soft);
  });

  it('默认蓝浅色主题仍写加深文字变体保对比度,深色全部清除', () => {
    expect(appearanceCssVars(ap({ theme: 'light' }), 'light')['--goder-skin-accent-text']).toBe(ACCENTS.blue.textOnLight);
    expect(appearanceCssVars(ap({ theme: 'dark' }), 'dark')['--goder-skin-accent-text']).toBeNull();
  });

  it('字号:13.5 基准清除,其余按 sm = 基准 -1.5、xs = 基准 -2.5', () => {
    const vars = appearanceCssVars(ap({ fontSize: 15 }), 'dark');
    expect(vars['--goder-skin-font-size']).toBe('15px');
    expect(vars['--goder-skin-font-size-sm']).toBe('13.5px');
    expect(vars['--goder-skin-font-size-xs']).toBe('12.5px');
  });
});

describe('loadAppearanceLocal', () => {
  it('无记录回退默认外观', () => {
    setKeyValueStorage(new MemoryStorage());
    expect(loadAppearanceLocal()).toEqual({ theme: 'dark', accent: 'blue', fontSize: 13.5 });
  });

  it('旧档位名(compact/standard/relaxed)迁移为基准像素', () => {
    const mem = new MemoryStorage();
    setKeyValueStorage(mem);
    kvSet(LS_KEY, { theme: 'light', fontSize: 'compact' });
    expect(loadAppearanceLocal()).toEqual({ theme: 'light', accent: 'blue', fontSize: 12.5 });
  });

  it('system 主题取值合法保留(跟随系统)', () => {
    const mem = new MemoryStorage();
    setKeyValueStorage(mem);
    kvSet(LS_KEY, { theme: 'system' });
    expect(loadAppearanceLocal().theme).toBe('system');
  });

  it('字号越界钳制到 [FONT_MIN, FONT_MAX],非法 theme/accent 回退', () => {
    const mem = new MemoryStorage();
    setKeyValueStorage(mem);
    kvSet(LS_KEY, { theme: 'solarized', accent: '', fontSize: 999 });
    expect(loadAppearanceLocal()).toEqual({ theme: 'dark', accent: 'blue', fontSize: 20 });
    kvSet(LS_KEY, { fontSize: 2 });
    expect(loadAppearanceLocal().fontSize).toBe(11);
  });

  it('损坏 JSON 容错回退默认', () => {
    const mem = new MemoryStorage();
    setKeyValueStorage(mem);
    mem.setItem(LS_KEY, '{oops');
    expect(loadAppearanceLocal()).toEqual(DEFAULT_APPEARANCE);
  });
});
