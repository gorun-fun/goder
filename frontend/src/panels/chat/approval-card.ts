// approval-card.ts — 逐工具审批暂停卡片:展示待批工具与全量参数,
// 批准 / 拒绝(可附反馈,反馈文本会回给模型)。
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme, controls } from '../../ui/panel';
import { toolArgSummary, toolLabel } from '../../util/fmt';
import type { ApprovalItem } from '../../core/model/chat-model';

@customElement('goder-approval-card')
export class GoderApprovalCard extends LitElement {
  @property({ type: Object }) item!: ApprovalItem;

  @state() private showFeedback = false;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
      }
      .card {
        border: 1px solid var(--goder-warn);
        background: var(--goder-warn-soft);
        border-radius: var(--goder-radius);
        padding: 12px 14px;
        margin: 8px 0;
        display: grid;
        gap: 10px;
      }
      .banner {
        display: flex;
        align-items: center;
        gap: 7px;
        color: var(--goder-warn);
        font-size: var(--goder-font-size-sm);
        font-weight: 600;
      }
      .banner svg {
        width: 15px;
        height: 15px;
        flex: none;
      }
      .tool {
        font-family: var(--goder-mono);
        font-size: var(--goder-font-size-sm);
        color: var(--goder-text);
      }
      .args {
        font-family: var(--goder-mono);
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-dim);
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 220px;
        overflow: auto;
        background: var(--goder-bg);
        border: 1px solid var(--goder-border-soft);
        border-radius: var(--goder-radius-sm);
        padding: 8px 10px;
        margin: 0;
      }
      .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
      }
      .feedback {
        width: 100%;
        font-size: var(--goder-font-size-sm);
        min-height: 52px;
        resize: vertical;
      }
      .done {
        color: var(--goder-text-dim);
        font-size: var(--goder-font-size-sm);
      }
    `,
  ];

  render() {
    const it = this.item;
    if (it.state !== 'pending') {
      return html`<div class="card">
        <div class="banner">${it.state === 'approved' ? '✓ 已批准' : '✕ 已拒绝'}</div>
        <div class="done">
          ${toolLabel(it.name)}
          ${it.state === 'rejected' && it.feedback ? html` — 反馈:${it.feedback}` : nothing}
        </div>
      </div>`;
    }
    return html`
      <div class="card">
        <div class="banner">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M8 2.2l6 11H2l6-11z" stroke-linejoin="round" />
            <path d="M8 6.4v3.2" stroke-linecap="round" />
            <circle cx="8" cy="11.4" r=".7" fill="currentColor" stroke="none" />
          </svg>
          工具执行需要批准
        </div>
        <div class="tool">${toolLabel(it.name)} — ${toolArgSummary(it.name, it.args)}</div>
        <pre class="args">${this.pretty(it.args)}</pre>
        ${this.showFeedback
          ? html`<textarea class="feedback" placeholder="拒绝反馈(会回给模型,例如:别动这个文件,改用 …)"></textarea>`
          : nothing}
        <div class="actions">
          <button class="ghost" @click=${() => (this.showFeedback = !this.showFeedback)}>
            ${this.showFeedback ? '收起反馈' : '附拒绝反馈'}
          </button>
          <button class="danger" @click=${this.reject}>拒绝</button>
          <button class="primary" @click=${() => this.fire('approve', { callId: it.callId, approved: true })}>批准</button>
        </div>
      </div>
    `;
  }

  private pretty(args: string): string {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }

  private reject(): void {
    if (this.showFeedback) {
      const ta = this.renderRoot.querySelector<HTMLTextAreaElement>('.feedback');
      this.fire('approve', { callId: this.item.callId, approved: false, feedback: ta?.value ?? '' });
    } else {
      this.fire('approve', { callId: this.item.callId, approved: false, feedback: '' });
    }
  }

  private fire(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-approval-card': GoderApprovalCard;
  }
}
