// browser.ts — <grf-browser>:右栏内嵌浏览器(地址栏 + iframe)。
// 纯前端实现,桌面/嵌入态均可用;上次访问地址按 scope 记忆在
// localStorage。部分站点通过 X-Frame-Options 禁止内嵌,只能显示空白,
// 属浏览器安全策略,无法绕过。
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../ui/base';
import { icon } from '../util/icons';

/** 看起来像域名的输入自动补 https:// */
function normalizeUrl(v: string): string {
  const t = v.trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data):/i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?|#)/i.test(t)) return `https://${t}`;
  return t;
}

@customElement('grf-browser')
export class GrfBrowser extends GrfPanel {
  /** 地址栏输入值 */
  @state() private input = '';
  /** 当前加载的地址(空 = 未导航) */
  @state() private url = '';
  /** 实际赋给 iframe 的 src(刷新时先置空再还原以强制重载) */
  @state() private frameSrc = '';
  private reloadTimer = 0;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: transparent;
      }
      .bar {
        flex: none;
        display: flex;
        gap: 5px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--grf-border-soft);
      }
      .bar input {
        flex: 1;
        min-width: 0;
        font-size: var(--grf-font-size-xs);
        font-family: var(--grf-mono);
        padding: 4px 8px;
      }
      .bar button.ghost {
        padding: 4px 6px;
      }
      .page {
        flex: 1;
        min-height: 0;
        position: relative;
        background: #fff;
      }
      iframe {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: none;
      }
      .hint {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 10px;
        background: var(--grf-card);
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-sm);
        text-align: center;
        padding: 0 24px;
      }
      .hint svg {
        width: 30px;
        height: 30px;
        opacity: 0.5;
      }
      .hint .sub {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        line-height: 1.8;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    try {
      const saved = localStorage.getItem(this.storeKey());
      if (saved) {
        this.url = saved;
        this.input = saved;
        this.frameSrc = saved;
      }
    } catch {
      /* 忽略 */
    }
  }

  disconnectedCallback(): void {
    window.clearTimeout(this.reloadTimer);
    super.disconnectedCallback();
  }

  private storeKey(): string {
    return `grf-ui:${this.scope}:browser-url`;
  }

  private go(): void {
    const u = normalizeUrl(this.input);
    if (!u) return;
    this.input = u;
    this.url = u;
    this.frameSrc = u;
    try {
      localStorage.setItem(this.storeKey(), u);
    } catch {
      /* 忽略 */
    }
  }

  /** open 外部导航入口(file-view 的 html 渲染眼睛):直接加载指定地址 */
  open(u: string): void {
    const n = normalizeUrl(u);
    if (!n) return;
    this.input = n;
    this.url = n;
    this.frameSrc = n;
    try {
      localStorage.setItem(this.storeKey(), n);
    } catch {
      /* 忽略 */
    }
  }

  private reload(): void {
    if (!this.url) return;
    this.frameSrc = '';
    this.reloadTimer = window.setTimeout(() => {
      this.frameSrc = this.url;
    }, 0);
  }

  render() {
    return html`
      <div class="bar">
        <input
          type="text"
          placeholder="输入网址,如 example.com"
          .value=${this.input}
          spellcheck="false"
          @input=${(e: InputEvent) => (this.input = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.go()}
        />
        <button class="ghost" title="跳转" @click=${() => this.go()}>${unsafeHTML(icon.send)}</button>
        <button class="ghost" title="刷新" @click=${() => this.reload()}>${unsafeHTML(icon.refresh)}</button>
      </div>
      <div class="page">
        ${this.frameSrc
          ? html`<iframe src=${this.frameSrc} referrerpolicy="no-referrer"></iframe>`
          : html`
              <div class="hint">
                ${unsafeHTML(icon.globe)}
                <div>${this.url ? '加载中…' : '输入网址开始浏览'}</div>
                <div class="sub">部分站点(如 Google/银行)禁止被内嵌框架显示,属站点安全策略。</div>
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-browser': GrfBrowser;
  }
}
