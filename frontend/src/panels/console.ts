// console.ts — <grf-console>:底栏事件台。SSE 事件流与系统消息的行式
// 日志(级别着色、自动滚动、暂停/清空)。相当于 ZCode 的输出面板。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { GrfPanel, theme, controls } from '../ui/base';
import { fmtClock } from '../util/fmt';

@customElement('grf-console')
export class GrfConsole extends GrfPanel {
  /** 过滤:仅显示 warn/error;全部;仅事件 */
  @property({ type: String }) filter: 'all' | 'problems' | 'events' = 'all';

  @state() private stick = true;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: #131419;
        border-top: 1px solid var(--grf-border-soft);
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
      }
      .head {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-bottom: 1px solid var(--grf-border);
        background: var(--grf-bg-raise);
        font-family: var(--grf-font);
      }
      .head .t {
        font-weight: 650;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-xs);
        letter-spacing: 0.4px;
        margin-right: 6px;
      }
      .filters {
        display: flex;
        gap: 2px;
      }
      .f {
        padding: 2px 8px;
        border-radius: 4px;
        cursor: pointer;
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
      }
      .f:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .f.on {
        background: var(--grf-bg-active);
        color: var(--grf-text);
      }
      .spacer {
        flex: 1;
      }
      .head button {
        padding: 2px 7px;
        font-size: var(--grf-font-size-xs);
      }
      .body {
        flex: 1;
        overflow: auto;
        padding: 6px 0;
        min-height: 0;
      }
      .line {
        display: flex;
        gap: 10px;
        padding: 1px 12px;
        line-height: 1.65;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .line:hover {
        background: rgba(255, 255, 255, 0.025);
      }
      .ts {
        color: var(--grf-text-faint);
        flex: none;
        user-select: none;
      }
      .lv {
        flex: none;
        width: 46px;
        text-align: right;
        user-select: none;
      }
      .lv.event { color: var(--grf-accent-text); }
      .lv.info { color: var(--grf-text-dim); }
      .lv.warn { color: var(--grf-warn); }
      .lv.error { color: var(--grf-error); }
      .line.warn .tx { color: var(--grf-warn); }
      .line.error .tx { color: var(--grf-error); }
      .empty {
        padding: 18px;
        text-align: center;
        color: var(--grf-text-faint);
      }
    `,
  ];

  protected updated(): void {
    if (this.stick) {
      const el = this.renderRoot.querySelector('.body');
      if (el) el.scrollTop = el.scrollHeight;
    }
  }

  private onScroll(e: Event): void {
    const el = e.target as HTMLElement;
    this.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }

  render() {
    const s = this.store;
    const entries = s.console.filter((e) =>
      this.filter === 'problems' ? e.level === 'warn' || e.level === 'error' : this.filter === 'events' ? e.level === 'event' : true,
    );
    return html`
      <div class="head">
        <span class="t">事件台</span>
        <div class="filters">
          ${(
            [
              ['all', '全部'],
              ['events', '事件流'],
              ['problems', '问题'],
            ] as const
          ).map(
            ([k, label]) => html`
              <span class="f ${this.filter === k ? 'on' : ''}" @click=${() => (this.filter = k)}>${label}</span>
            `,
          )}
        </div>
        <span class="spacer"></span>
        <button
          class="ghost"
          @click=${() => {
            s.consolePaused = !s.consolePaused;
            s.notify();
          }}
        >
          ${s.consolePaused ? '继续' : '暂停'}
        </button>
        <button class="ghost" @click=${() => s.clearConsole()}>清空</button>
      </div>
      <div class="body" @scroll=${this.onScroll}>
        ${entries.length
          ? entries.map(
              (e) => html`
                <div class="line ${e.level}">
                  <span class="ts">${fmtClock(e.ts)}</span>
                  <span class="lv ${e.level}">${e.level}</span>
                  <span class="tx">${e.text}</span>
                </div>
              `,
            )
          : html`<div class="empty">暂无输出。发送消息后,这里显示原始事件流(grf:notice / 工具事件 / 系统消息)。</div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-console': GrfConsole;
  }
}
