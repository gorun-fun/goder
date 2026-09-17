// theme.ts — 主题令牌与共享控件样式(ZCode 风格深色)。
// 宿主页面可覆盖 :root 上的同名变量换肤;外观挂钩层:面板 :host 上的
// 外观类令牌均经 var(--grf-skin-*, 默认值)间接取值 —— 设置页在
// documentElement 上写 --grf-skin-* 即可凭继承穿透全部 shadow DOM 实现
// 运行时换肤(浅色/强调色/字号);宿主直接在面板元素上覆盖 --grf-* 的
// 换肤方式不变(文档规则优先于 :host,仍会生效)。
import { css } from 'lit';

// 完整令牌清单即下方 theme 块;三方换肤只需覆写同名 --grf-* 变量。
export const theme = css`
  :host {
    /* 布局 */
    --grf-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    /* 等宽栈:Linux(WebKitGTK)对缺失字体会经 fontconfig 乱替换(可能落到
     * 非等宽字体,xterm 按错误字宽排版),故把 Linux 常见等宽字体排在
     * Apple/MS 专有名之前 —— macOS/Windows 上这些名字不存在时会被安全跳过。 */
    --grf-mono: ui-monospace, 'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono',
      'Cascadia Mono', SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;

    /* 色板(外观类令牌走 skin 挂钩,其余为固定语义色)
     * 注意:lit 的 css 模板内只能用块注释——CSS 不认 // 注释,解析器会把 //
     * 连同其后直到分号的整条声明一并丢弃(曾导致 --grf-font/--grf-bg 静默失效)。 */
    --grf-bg: var(--grf-skin-bg, #17181d);
    --grf-bg-raise: var(--grf-skin-bg-raise, #1d1f26);
    --grf-bg-hover: var(--grf-skin-bg-hover, #262a33);
    --grf-bg-active: var(--grf-skin-bg-active, #2d323e);
    --grf-border: var(--grf-skin-border, #2a2d36);
    --grf-border-soft: var(--grf-skin-border-soft, #232630);
    --grf-text: var(--grf-skin-text, #d7dae0);
    --grf-text-dim: var(--grf-skin-text-dim, #8b909c);
    --grf-text-faint: var(--grf-skin-text-faint, #5f636e);
    --grf-accent: var(--grf-skin-accent, #4c8dff);
    --grf-accent-soft: var(--grf-skin-accent-soft, rgba(76, 141, 255, 0.14));
    --grf-accent-text: var(--grf-skin-accent-text, #7faeff);
    --grf-user-bubble: var(--grf-skin-user-bubble, #26313f);
    --grf-success: #3fb96f;
    --grf-success-soft: rgba(63, 185, 111, 0.13);
    --grf-error: #e5534b;
    --grf-error-soft: rgba(229, 83, 75, 0.12);
    --grf-warn: #d4a72c;
    --grf-warn-soft: rgba(212, 167, 44, 0.13);
    --grf-reasoning: #8d7ce8;
    --grf-reasoning-soft: rgba(141, 124, 232, 0.1);
    --grf-shadow: var(--grf-skin-shadow, 0 8px 28px rgba(0, 0, 0, 0.4));
    /* 主体工作卡片底色(聊天/设置等圆角大卡),比导航栏(--grf-bg-raise)深一档 */
    --grf-card: var(--grf-skin-card, #13151b);
    --grf-scroll-thumb: var(--grf-skin-scroll-thumb, #333845);
    --grf-border-hover: var(--grf-skin-border-hover, #363b47);

    /* 尺寸(字号随外观设置缩放) */
    --grf-radius: 8px;
    --grf-radius-sm: 6px;
    --grf-font-size: var(--grf-skin-font-size, 13.5px);
    --grf-font-size-sm: var(--grf-skin-font-size-sm, 12px);
    --grf-font-size-xs: var(--grf-skin-font-size-xs, 11px);
  }
`;

// 面板内部通用控件样式(配合 theme 一起 adopt)。
export const controls = css`
  button {
    font-family: var(--grf-font);
    font-size: var(--grf-font-size-sm);
    color: var(--grf-text);
    background: var(--grf-bg-raise);
    border: 1px solid var(--grf-border);
    border-radius: var(--grf-radius-sm);
    padding: 4px 10px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    line-height: 1.5;
    transition: background 0.12s, border-color 0.12s;
  }
  button:hover:not(:disabled) {
    background: var(--grf-bg-hover);
    border-color: var(--grf-border-hover);
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  button.primary {
    background: var(--grf-accent);
    border-color: var(--grf-accent);
    color: #fff;
  }
  button.primary:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  button.danger {
    color: var(--grf-error);
  }
  button.ghost {
    background: transparent;
    border-color: transparent;
    color: var(--grf-text-dim);
    padding: 4px 6px;
  }
  button.ghost:hover:not(:disabled) {
    color: var(--grf-text);
    background: var(--grf-bg-hover);
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
    font-family: var(--grf-font);
    font-size: var(--grf-font-size);
    color: var(--grf-text);
    background: var(--grf-bg);
    border: 1px solid var(--grf-border);
    border-radius: var(--grf-radius-sm);
    padding: 5px 8px;
    outline: none;
    width: 100%;
    box-sizing: border-box;
  }
  input:focus,
  textarea:focus,
  select:focus {
    border-color: var(--grf-accent);
  }
  ::placeholder {
    color: var(--grf-text-faint);
  }
  ::-webkit-scrollbar {
    width: 9px;
    height: 9px;
    /* WebKit 自定义滚动条不给背景时会退回白色底,必须显式透明 */
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: var(--grf-scroll-thumb);
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
