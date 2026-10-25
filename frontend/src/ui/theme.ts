// theme.ts — 主题令牌与共享控件样式(ZCode 风格深色)。
// 宿主页面可覆盖 :root 上的同名变量换肤;外观挂钩层:面板 :host 上的
// 外观类令牌均经 var(--goder-skin-*, 默认值)间接取值 —— 设置页在
// documentElement 上写 --goder-skin-* 即可凭继承穿透全部 shadow DOM 实现
// 运行时换肤(浅色/强调色/字号);宿主直接在面板元素上覆盖 --goder-* 的
// 换肤方式不变(文档规则优先于 :host,仍会生效)。
import { css } from 'lit';

// 完整令牌清单即下方 theme 块;三方换肤只需覆写同名 --goder-* 变量。
export const theme = css`
  :host {
    /* 布局 */
    --goder-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    /* 等宽栈:Linux(WebKitGTK+fontconfig)对缺失字体名会乱替换(可能落到
     * 非等宽字体,xterm 按错误字宽排版、字距显宽),故把 Linux 常见等宽
     * 字体放最前 —— ui-monospace/SF Mono 等缺失名必须排在它们之后。
     * macOS/Windows 的字体引擎对缺失家族是直接跳过,不受此排序影响。 */
    --goder-mono: 'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono', 'Cascadia Mono',
      ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;

    /* 色板(外观类令牌走 skin 挂钩,其余为固定语义色)
     * 注意:lit 的 css 模板内只能用块注释——CSS 不认 // 注释,解析器会把 //
     * 连同其后直到分号的整条声明一并丢弃(曾导致 --goder-font/--goder-bg 静默失效)。 */
    --goder-bg: var(--goder-skin-bg, #17181d);
    --goder-bg-raise: var(--goder-skin-bg-raise, #1d1f26);
    --goder-bg-hover: var(--goder-skin-bg-hover, #262a33);
    --goder-bg-active: var(--goder-skin-bg-active, #2d323e);
    --goder-border: var(--goder-skin-border, #2a2d36);
    --goder-border-soft: var(--goder-skin-border-soft, #232630);
    /* 左栏与工作卡的纵向分割线:深色默认透明(背景色阶已可区分,见
     * app-shell 的 .left),浅色皮肤覆写为灰色(两栏同为白色需显式分隔) */
    --goder-border-split: var(--goder-skin-border-split, transparent);
    --goder-text: var(--goder-skin-text, #d7dae0);
    --goder-text-dim: var(--goder-skin-text-dim, #8b909c);
    --goder-text-faint: var(--goder-skin-text-faint, #5f636e);
    --goder-accent: var(--goder-skin-accent, #4c8dff);
    --goder-accent-soft: var(--goder-skin-accent-soft, rgba(76, 141, 255, 0.14));
    --goder-accent-text: var(--goder-skin-accent-text, #7faeff);
    --goder-user-bubble: var(--goder-skin-user-bubble, #26313f);
    --goder-success: #3fb96f;
    --goder-success-soft: rgba(63, 185, 111, 0.13);
    --goder-error: #e5534b;
    --goder-error-soft: rgba(229, 83, 75, 0.12);
    --goder-warn: #d4a72c;
    --goder-warn-soft: rgba(212, 167, 44, 0.13);
    --goder-reasoning: #8d7ce8;
    --goder-reasoning-soft: rgba(141, 124, 232, 0.1);
    --goder-shadow: var(--goder-skin-shadow, 0 8px 28px rgba(0, 0, 0, 0.4));
    /* 主体工作卡片底色(聊天/设置等圆角大卡),比导航栏(--goder-bg-raise)深一档 */
    --goder-card: var(--goder-skin-card, #13151b);
    --goder-scroll-thumb: var(--goder-skin-scroll-thumb, #333845);
    --goder-border-hover: var(--goder-skin-border-hover, #363b47);

    /* 尺寸(字号随外观设置缩放) */
    --goder-radius: 8px;
    --goder-radius-sm: 6px;
    --goder-font-size: var(--goder-skin-font-size, 13.5px);
    --goder-font-size-sm: var(--goder-skin-font-size-sm, 12px);
    --goder-font-size-xs: var(--goder-skin-font-size-xs, 11px);
  }
`;

// 面板内部通用控件样式(配合 theme 一起 adopt)。
export const controls = css`
  button {
    font-family: var(--goder-font);
    font-size: var(--goder-font-size-sm);
    color: var(--goder-text);
    background: var(--goder-bg-raise);
    border: 1px solid var(--goder-border);
    border-radius: var(--goder-radius-sm);
    padding: 4px 10px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    line-height: 1.5;
    transition: background 0.12s, border-color 0.12s;
  }
  button:hover:not(:disabled) {
    background: var(--goder-bg-hover);
    border-color: var(--goder-border-hover);
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  button.primary {
    background: var(--goder-accent);
    border-color: var(--goder-accent);
    color: #fff;
  }
  button.primary:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  button.danger {
    color: var(--goder-error);
  }
  button.ghost {
    background: transparent;
    border-color: transparent;
    color: var(--goder-text-dim);
    padding: 4px 6px;
  }
  button.ghost:hover:not(:disabled) {
    color: var(--goder-text);
    background: var(--goder-bg-hover);
  }
  button svg {
    width: 14px;
    height: 14px;
    flex: none;
  }
  input[type='text'],
  input[type='password'],
  input[type='number'],
  input:not([type]),
  textarea,
  select {
    font-family: var(--goder-font);
    font-size: var(--goder-font-size);
    color: var(--goder-text);
    background: var(--goder-bg);
    border: 1px solid var(--goder-border);
    border-radius: var(--goder-radius-sm);
    padding: 5px 8px;
    outline: none;
    width: 100%;
    box-sizing: border-box;
  }
  input:focus,
  textarea:focus,
  select:focus {
    border-color: var(--goder-accent);
  }
  ::placeholder {
    color: var(--goder-text-faint);
  }
  ::-webkit-scrollbar {
    width: 9px;
    height: 9px;
    /* WebKit 自定义滚动条不给背景时会退回白色底,必须显式透明 */
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: var(--goder-scroll-thumb);
    border-radius: 5px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-corner {
    background: transparent;
  }
`;
