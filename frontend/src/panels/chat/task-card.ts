// task-card.ts — <goder-task-card>:assistant 输出的 <goder-task> 结构块渲染
// 成的自动化任务沉淀卡。任务名 + 指令预览 + 「保存为自动化任务」按钮
// (点击经 save 事件上报,chat-panel 落库到当前操作员名下);已保存
// (操作员名下存在同名同指令任务)只读展示。
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { theme } from '../../ui/panel';
import { icon } from '../../util/icons';

@customElement('goder-task-card')
export class GoderTaskCard extends LitElement {
  @property() name = '';
  @property() instructions = '';
  /** 操作员名下已有同名同指令任务(保存按钮换成已保存标记) */
  @property({ type: Boolean }) saved = false;

  static styles = [
    theme,
    css`
      :host {
        display: block;
        margin: 8px 0;
      }
      .task-card {
        border: 1px solid var(--goder-border);
        border-radius: var(--goder-radius);
        background: var(--goder-bg-raise);
        overflow: hidden;
      }
      .tc-head {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 8px 10px 6px;
        color: var(--goder-accent-text);
        font-weight: 650;
        font-size: var(--goder-font-size-sm);
      }
      .tc-head svg {
        width: 14px;
        height: 14px;
        flex: none;
      }
      .tc-name {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .tc-body {
        margin: 0;
        padding: 2px 10px 8px;
        font-family: var(--goder-mono);
        font-size: var(--goder-font-size-xs);
        line-height: 1.55;
        color: var(--goder-text-dim);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 140px;
        overflow-y: auto;
      }
      .tc-foot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-top: 1px solid var(--goder-border-soft);
      }
      .tc-foot .primary {
        border: none;
        border-radius: 6px;
        padding: 4px 12px;
        background: var(--goder-accent);
        color: #fff;
        font-size: var(--goder-font-size-xs);
        font-weight: 600;
        cursor: pointer;
      }
      .tc-foot .primary:hover {
        filter: brightness(1.1);
      }
      .tc-saved {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: var(--goder-success);
        font-size: var(--goder-font-size-xs);
        font-weight: 600;
      }
      .tc-saved svg {
        width: 12px;
        height: 12px;
      }
      .tc-hint {
        color: var(--goder-text-faint);
        font-size: var(--goder-font-size-xs);
      }
    `,
  ];

  render() {
    return html`
      <div class="task-card" title="自动化任务:保存后显示在聊天列右上角状态浮窗,点击即可执行">
        <div class="tc-head">${unsafeHTML(icon.bot)}<span class="tc-name">${this.name || '未命名任务'}</span></div>
        <pre class="tc-body">${this.instructions}</pre>
        <div class="tc-foot">
          ${this.saved
            ? html`<span class="tc-saved">${unsafeHTML(icon.check)} 已保存</span>
                <span class="tc-hint">状态浮窗中点击即可执行</span>`
            : html`<button class="primary" @click=${this.onSave}>保存为自动化任务</button>
                <span class="tc-hint">保存后可在状态浮窗一键执行</span>`}
        </div>
      </div>
    `;
  }

  private onSave(): void {
    this.dispatchEvent(
      new CustomEvent('save', {
        detail: { name: this.name, instructions: this.instructions },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-task-card': GoderTaskCard;
  }
}
