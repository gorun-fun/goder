// user-chip.ts — <grf-user-chip>:左栏底部身份 chip(session-list 与
// settings-nav 共用)。展示名优先级:configure 注入的 user.name > 桌面
// 系统用户名 > 「本地用户」。注入了 user.panel 时 chip 可点击,在 chip
// 上方弹出宿主自绘的用户面板(返回的 HTMLElement 跨开关保活;点击面板
// 外部或 Esc 关闭);未注入时与既有行为一致,仅展示不可点。
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme } from '../../ui/panel';
import { icon } from '../../util/icons';
import { desktopUserName, inWails } from '../../host/bridge';
import { getUser, onUserChange, type PanelContext } from '../../registry/registry';

@customElement('grf-user-chip')
export class GrfUserChip extends GrfPanel {
  /** 桌面系统用户名(纯 web 态为空) */
  @state() private sysName = '';
  /** 用户面板展开态 */
  @state() private open = false;
  /** 宿主面板元素缓存(HTMLElement 跨开关保活;身份重配时丢弃重建) */
  private panelEl?: HTMLElement;
  private offUser?: () => void;

  static styles = [
    theme,
    css`
      :host {
        flex: 1;
        min-width: 0;
        position: relative;
        display: flex;
        align-items: center;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        user-select: none;
      }
      .chip {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .chip svg {
        width: 13px;
        height: 13px;
        flex: none;
        color: var(--grf-text-faint);
      }
      .chip .name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* 注入了自定义面板时:chip 可点,悬停浮起,尾部小箭头提示(收起朝上) */
      .chip.click {
        cursor: pointer;
        padding: 4px 6px;
        margin-left: -6px;
        border-radius: var(--grf-radius-sm);
      }
      .chip.click:hover,
      .chip.click.on {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .chip .arr {
        margin-left: auto;
        flex: none;
        transform: rotate(-90deg);
        transition: transform 0.12s ease;
      }
      .chip.on .arr {
        transform: rotate(90deg);
      }
      .pop {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 8px);
        background: var(--grf-bg-raise);
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        box-shadow: var(--grf-shadow);
        padding: 10px;
        max-height: 60vh;
        overflow-y: auto;
        z-index: 30;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void desktopUserName().then((n) => {
      if (n) this.sysName = n;
    });
    this.offUser = onUserChange(() => {
      this.panelEl = undefined;
      this.close();
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.close();
    this.offUser?.();
    this.offUser = undefined;
    super.disconnectedCallback();
  }

  /** 点击 chip 外部(含面板外)或 Esc 关闭;shadow DOM 内外统一走 composedPath。 */
  private onDocDown = (e: Event): void => {
    if (!e.composedPath().includes(this)) this.close();
  };
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };

  private openPanel(): void {
    this.open = true;
    document.addEventListener('pointerdown', this.onDocDown, true);
    document.addEventListener('keydown', this.onKey, true);
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    document.removeEventListener('pointerdown', this.onDocDown, true);
    document.removeEventListener('keydown', this.onKey, true);
  }

  private panelCtx(): PanelContext {
    return { scope: this.scope, store: this.store, desktop: inWails() };
  }

  private ensurePanel(): HTMLElement {
    if (!this.panelEl) {
      this.panelEl = getUser(this.scope)?.panel?.(this.panelCtx()) ?? document.createElement('div');
    }
    return this.panelEl;
  }

  render() {
    const u = getUser(this.scope);
    const name = u?.name || this.sysName || '本地用户';
    const tip = u?.detail ? `${name}（${u.detail}）` : name;
    const clickable = !!u?.panel;
    return html`
      <div
        class="chip ${clickable ? 'click' : ''} ${this.open ? 'on' : ''}"
        title=${tip}
        role=${clickable ? 'button' : nothing}
        @click=${() => (clickable ? (this.open ? this.close() : this.openPanel()) : undefined)}
      >
        ${unsafeHTML(icon.user)}
        <span class="name">${name}</span>
        ${clickable ? html`<span class="arr">${unsafeHTML(icon.chevron)}</span>` : nothing}
      </div>
      ${this.open && clickable ? html`<div class="pop" part="panel">${this.ensurePanel()}</div>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-user-chip': GrfUserChip;
  }
}
