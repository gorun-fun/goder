// settings-nav.ts — <grf-settings-nav>:设置视图的左栏导航。
// 顶部返回工作区,下方分区列表(常规/外观/模型设置);当前分区由宿主
// (app-shell)持有,经 section 属性下发,切换时冒泡 grf-settings-section
// 事件。底部身份区与 <grf-session-list> 一致。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { desktopUserName } from '../../host/bridge';

export type SettingsSection = 'general' | 'appearance' | 'models';

@customElement('grf-settings-nav')
export class GrfSettingsNav extends GrfPanel {
  /** 当前分区(宿主下发) */
  @property({ type: String }) section: SettingsSection = 'general';
  /** 与 session-list 对齐:嵌入态宿主自管身份区时可隐藏底部 */
  @property({ type: Boolean, attribute: 'no-connection' }) noConnectionFooter = false;

  @state() private userName = '';

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--grf-bg-raise);
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        color: var(--grf-text);
      }
      /* 整行可点的返回条目(与 file-list 一致) */
      .back {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 9px 12px;
        border-bottom: 1px solid var(--grf-border-soft);
        font-weight: 650;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
        cursor: pointer;
        user-select: none;
      }
      .back:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .back svg {
        width: 13px;
        height: 13px;
        flex: none;
      }
      .list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        padding: 6px 6px 12px;
      }
      .title {
        flex: none;
        padding: 8px 12px 2px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        font-weight: 650;
        letter-spacing: 0.4px;
        user-select: none;
      }
      .item {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 6px 8px;
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-sm);
        user-select: none;
      }
      .item:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .item.on {
        background: var(--grf-accent-soft);
        color: var(--grf-accent-text);
      }
      .item svg {
        width: 14px;
        height: 14px;
        flex: none;
      }
      .footbar {
        flex: none;
        border-top: 1px solid var(--grf-border-soft);
        padding: 8px 12px;
        display: flex;
        align-items: center;
        gap: 8px;
        user-select: none;
      }
      .footbar .user {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .footbar .user svg {
        width: 13px;
        height: 13px;
        flex: none;
        color: var(--grf-text-faint);
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    void desktopUserName().then((n) => {
      if (n) this.userName = n;
    });
  }

  render() {
    const items: [SettingsSection, string, string][] = [
      ['general', '常规', icon.settings],
      ['appearance', '外观', icon.palette],
      ['models', '模型设置', icon.brain],
    ];
    return html`
      <div class="back" title="返回工作区" @click=${() => this.fire('grf-close-settings')}>
        ${unsafeHTML(icon.arrowLeft)}
        <span>返回工作区</span>
      </div>
      <div class="title">设置</div>
      <div class="list">
        ${items.map(
          ([key, label, ic]) => html`
            <div class="item ${this.section === key ? 'on' : ''}" @click=${() => this.fire('grf-settings-section', key)}>
              ${unsafeHTML(ic)}
              <span>${label}</span>
            </div>
          `,
        )}
      </div>
      ${this.noConnectionFooter
        ? nothing
        : html`
            <div class="footbar">
              <span class="user" title=${this.userName || '本地用户'}>${unsafeHTML(icon.user)}<span>${this.userName || '本地用户'}</span></span>
            </div>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-settings-nav': GrfSettingsNav;
  }
}
