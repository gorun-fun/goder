// appearance.ts — 外观(主题/强调色/字号)的纯计算:预设色表、自定义
// 强调色派生、浅色皮肤常量与 CSS 变量表生成,全部无 DOM 依赖(node
// 测试环境可直接单测)。计算纯函数在此,DOM 应用(写 documentElement
// 的 --goder-skin-* 挂钩、穿透全部 shadow DOM)留在 settings-store 的
// applyAppearanceVars;localStorage 镜像(桌面与浏览器两形态重启即恢复)
// 亦在 settings-store 经 core/store 的 storage 通道读写,镜像机制说明
// 见 settings-store 头注释。换肤只经 --goder-* CSS 变量(见 ui/theme.ts)。
import { kvGet } from '../store/storage';

export type ThemeMode = 'dark' | 'light';
/** 强调色:预设 key 或 "#rrggbb" 自定义色值 */
export type AccentValue = string;

/** 强调色预设:text 为深色主题文字变体,textOnLight 为浅色主题文字变体 */
export const ACCENTS = {
  blue: { label: '蓝', accent: '#4c8dff', text: '#7faeff', textOnLight: '#2563eb', soft: 'rgba(76, 141, 255, 0.16)' },
  violet: { label: '紫', accent: '#8d7ce8', text: '#ab9df0', textOnLight: '#6d3fd4', soft: 'rgba(141, 124, 232, 0.18)' },
  green: { label: '绿', accent: '#3fb96f', text: '#6ed598', textOnLight: '#15803d', soft: 'rgba(63, 185, 111, 0.16)' },
  orange: { label: '橙', accent: '#e08a3c', text: '#f0a765', textOnLight: '#b45309', soft: 'rgba(224, 138, 60, 0.18)' },
  rose: { label: '玫红', accent: '#e5637a', text: '#f2899b', textOnLight: '#be3455', soft: 'rgba(229, 99, 122, 0.16)' },
} as const;

/** 旧版字号档位 → 基准像素(迁移用) */
const FONT_MODE_PX: Record<string, number> = { compact: 12.5, standard: 13.5, relaxed: 14.5 };
export const FONT_MIN = 11;
export const FONT_MAX = 20;

// ---------- 自定义强调色派生(hex → 各主题变体) ----------

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** 向白色(t>0)或黑色(t<0)方向插值 */
function mixRgb(rgb: [number, number, number], t: number): string {
  const [r, g, b] = rgb;
  const to = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  const c = (x: number) => clampByte(x + (to - x) * k);
  return `#${[c(r), c(g), c(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** 解析强调色取值:预设 key 或自定义 hex;非法时回退默认蓝。 */
function resolveAccent(v: string): { accent: string; text: string; textOnLight: string; soft: string } {
  if (v in ACCENTS) return ACCENTS[v as keyof typeof ACCENTS];
  const rgb = hexToRgb(v);
  if (rgb) {
    return {
      accent: `#${rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`,
      text: mixRgb(rgb, 0.28),
      textOnLight: mixRgb(rgb, -0.35),
      soft: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.16)`,
    };
  }
  return ACCENTS.blue;
}

/** 浅色主题 skin 挂钩取值(深色为默认值,无需覆写) */
const LIGHT_SKIN: Record<string, string> = {
  '--goder-skin-bg': '#f4f5f7',
  '--goder-skin-bg-raise': '#ffffff',
  '--goder-skin-bg-hover': '#eceef1',
  '--goder-skin-bg-active': '#e3e6ea',
  '--goder-skin-border': '#d5d8de',
  '--goder-skin-border-soft': '#e4e6eb',
  '--goder-skin-border-hover': '#bfc4cc',
  '--goder-skin-text': '#26292f',
  '--goder-skin-text-dim': '#5d636e',
  '--goder-skin-text-faint': '#9096a0',
  '--goder-skin-user-bubble': '#e8ecf2',
  '--goder-skin-shadow': '0 8px 28px rgba(20, 24, 32, 0.12)',
  '--goder-skin-card': '#ffffff',
  '--goder-skin-scroll-thumb': '#c6cad2',
};

/** 字号:基准像素(sm = 基准 -1.5,xs = 基准 -2.5) */
function fontVars(base: number): [string, string, string] {
  return [`${base}px`, `${base - 1.5}px`, `${base - 2.5}px`];
}

export interface Appearance {
  theme: ThemeMode;
  accent: AccentValue;
  fontSize: number;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', accent: 'blue', fontSize: 13.5 };
export const LS_KEY = 'goder-appearance-v1';

/** 从键值存储读回外观(localStorage 镜像的读取侧;损坏/缺省回退默认)。 */
export function loadAppearanceLocal(): Appearance {
  const p = kvGet<Partial<Appearance> & { fontSize?: number | string }>(LS_KEY);
  if (!p) return { ...DEFAULT_APPEARANCE };
  // 旧档位名(compact/standard/relaxed)迁移为基准像素
  const fontSize =
    typeof p.fontSize === 'number'
      ? p.fontSize
      : typeof p.fontSize === 'string' && p.fontSize in FONT_MODE_PX
        ? FONT_MODE_PX[p.fontSize]
        : DEFAULT_APPEARANCE.fontSize;
  return {
    theme: p.theme === 'light' ? 'light' : 'dark',
    accent: typeof p.accent === 'string' && p.accent ? p.accent : 'blue',
    fontSize: Math.max(FONT_MIN, Math.min(FONT_MAX, fontSize)),
  };
}

/**
 * 由外观推导完整的 skin CSS 变量表:键为 --goder-skin-* 挂钩名,值为
 * 该外观下应写的取值,null 表示清除覆写、回落 ui/theme.ts 的深色默认值
 * (深色主题 + 默认蓝 + 13.5px 标准字号时全表为 null)。纯计算,不做
 * 任何 DOM 写入;应用侧(settings-store.applyAppearanceVars)按表逐键
 * setProperty/removeProperty,键序即应用序。
 */
export function appearanceCssVars(a: Appearance): Record<string, string | null> {
  const vars: Record<string, string | null> = {};
  // 主题:深色走默认值,浅色整体覆写
  for (const [k, v] of Object.entries(LIGHT_SKIN)) vars[k] = a.theme === 'light' ? v : null;
  // 强调色:浅色主题文字用加深变体保证对比度
  const onLight = a.theme === 'light';
  const accent = resolveAccent(a.accent);
  const isDefaultBlue = a.accent === 'blue';
  vars['--goder-skin-accent'] = isDefaultBlue ? null : accent.accent;
  vars['--goder-skin-accent-soft'] = isDefaultBlue ? null : accent.soft;
  vars['--goder-skin-accent-text'] = isDefaultBlue && !onLight ? null : onLight ? accent.textOnLight : accent.text;
  // 字号:13.5px 基准走默认值
  const [fs, fss, fsxs] = fontVars(a.fontSize);
  const std = a.fontSize === 13.5;
  vars['--goder-skin-font-size'] = std ? null : fs;
  vars['--goder-skin-font-size-sm'] = std ? null : fss;
  vars['--goder-skin-font-size-xs'] = std ? null : fsxs;
  return vars;
}
