// base.ts — 面板公共基类与共享主题。所有 grf-* 面板继承 GrfPanel:
// - scope 属性选择共享数据域(嵌入态多实例互不干扰)
// - 订阅 scope 版本号驱动重渲染
// - server/token 属性可直接配置连接(不必走 JS API)
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { configureScope, getScope, type GrfScope } from '../state/scope';
import type { Unsubscribe } from '../state/store';

// 主题令牌(ZCode 风格深色)。宿主页面可覆盖 :root 上的同名变量换肤。
// 外观挂钩层:面板 :host 上的外观类令牌均经 var(--grf-skin-*, 默认值)
// 间接取值 —— 设置页在 documentElement 上写 --grf-skin-* 即可凭继承穿透
// 全部 shadow DOM 实现运行时换肤(浅色/强调色/字号);宿主直接在面板
// 元素上覆盖 --grf-* 的换肤方式不变(文档规则优先于 :host,仍会生效)。
export const theme = css`
  :host {
    /* 布局 */
    --grf-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    --grf-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;

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
    /* 主体工作卡片底色(聊天/设置等黑色圆角大卡) */
    --grf-card: var(--grf-skin-card, #000);
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

export class GrfPanel extends LitElement {
  @property({ reflect: true }) scope = 'default';
  /** 直连 gh server 地址(形如 http://127.0.0.1:7400),可选 */
  @property({ attribute: 'server' }) serverAttr?: string;
  /** Bearer 令牌,可选 */
  @property({ attribute: 'token' }) tokenAttr?: string;

  protected store!: GrfScope;
  private unsub?: Unsubscribe;

  connectedCallback(): void {
    super.connectedCallback();
    this.attachScope();
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = undefined;
    super.disconnectedCallback();
  }

  protected updated(props: Map<string, unknown>): void {
    if (props.has('scope') || props.has('serverAttr') || props.has('tokenAttr')) {
      this.attachScope();
    }
  }

  private attachScope(): void {
    this.unsub?.();
    if (this.serverAttr || this.tokenAttr) {
      this.store = configureScope(this.scope, {
        ...(this.serverAttr ? { baseUrl: this.serverAttr } : {}),
        ...(this.tokenAttr ? { token: this.tokenAttr } : {}),
      });
    } else {
      this.store = getScope(this.scope);
    }
    this.unsub = this.store.subscribe(() => this.requestUpdate());
    this.requestUpdate();
  }

  protected fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

export { css, html, nothing };

/** 面板元素是否已注册(如 grf-terminal 仅桌面入口注册;嵌入态据此降级隐藏)。 */
export function panelRegistered(tag: string): boolean {
  return typeof customElements !== 'undefined' && customElements.get(tag) != null;
}
