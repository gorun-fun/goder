// ask-form.ts — ask_user_question 暂停回合的交互表单卡片。
// 选项题(单选/多选)渲染为可点选项:单选点击即提交,多选勾选后经
// "提交回答"提交;无选项的题渲染加高文本框;提交后走 grf:input_result
// 续交。
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme, controls } from '../../ui/panel';
import type { AskItem } from '../../core/model/chat-model';
import type { AskQuestion } from '../../core/api/types';

@customElement('grf-ask-form')
export class GrfAskForm extends LitElement {
  /** 卡片数据 */
  @property({ type: Object }) item!: AskItem;
  /** 提交回调:(answers | dismiss) */
  @property({ type: Boolean, attribute: 'show-dismiss' }) showDismiss = false;
  /** 平铺形态(嵌进 composer 输入框时去掉卡片边框/底色) */
  @property({ type: Boolean }) flat = false;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
      }
      .card {
        border: 1px solid var(--grf-accent);
        border-radius: var(--grf-radius);
        background: var(--grf-accent-soft);
        padding: 14px 16px;
        margin: 8px 0;
        display: grid;
        gap: 14px;
      }
      /* 平铺:嵌入 composer 时与输入框融为一体 */
      .card.flat {
        border: none;
        background: transparent;
        border-radius: 0;
        padding: 0;
        margin: 0;
        gap: 10px;
      }
      /* 平铺形态的头部由 composer 提供,避免重复 */
      .card.flat .banner {
        display: none;
      }
      .banner {
        display: flex;
        align-items: center;
        gap: 7px;
        color: var(--grf-accent-text);
        font-size: var(--grf-font-size-sm);
        font-weight: 600;
      }
      .banner svg {
        width: 15px;
        height: 15px;
      }
      .q {
        display: grid;
        gap: 8px;
      }
      .q .head {
        font-size: var(--grf-font-size);
        color: var(--grf-text);
        line-height: 1.6;
      }
      .q .head .tag {
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
        margin-left: 6px;
      }
      .opts {
        display: grid;
        gap: 6px;
      }
      .opt {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 9px 12px;
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius-sm);
        background: var(--grf-bg-raise);
        cursor: pointer;
        font-size: var(--grf-font-size-sm);
        user-select: none;
      }
      /* 选项边框色恒定:悬停/选中只改底色(选中另有指示点着色),
       * 避免选项在鼠标经过时边框跳色 */
      .opt:hover {
        background: var(--grf-bg-hover);
      }
      .opt.sel {
        background: var(--grf-accent-soft);
      }
      .opt input {
        margin-top: 2px;
        accent-color: var(--grf-accent);
      }
      /* 单选:无原生控件,自绘指示点 */
      .opt .dot {
        flex: none;
        width: 14px;
        height: 14px;
        margin-top: 2px;
        border-radius: 50%;
        border: 1.5px solid var(--grf-text-faint);
        box-sizing: border-box;
      }
      .opt.sel .dot {
        border-color: var(--grf-accent);
        background: radial-gradient(circle, var(--grf-accent) 0 4px, transparent 4.5px);
      }
      .opt .t {
        display: grid;
        gap: 2px;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .opt .d {
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-xs);
      }
      .q textarea {
        width: 100%;
        min-height: 72px;
        resize: vertical;
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        line-height: 1.6;
      }
      .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
      }
      .actions .hint {
        margin-right: auto;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      /* 已应答/已取消:收成一行灰色文字,点击可展开答案明细 */
      .done {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 2px;
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
        cursor: pointer;
        user-select: none;
        min-width: 0;
      }
      .done:hover {
        color: var(--grf-text-dim);
      }
      .done .chev {
        width: 11px;
        height: 11px;
        flex: none;
        transition: transform 0.15s;
      }
      .done .chev.open {
        transform: rotate(90deg);
      }
      .done .k {
        flex: none;
      }
      .done .txt {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .done-detail pre {
        margin: 2px 0 4px 17px;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
        line-height: 1.55;
        color: var(--grf-text-dim);
        white-space: pre-wrap;
        word-break: break-word;
      }
    `,
  ];

  private selection = new Map<string, Set<string>>(); // qid → 选中的 option label

  /** 已应答行的展开态(默认折叠成一行灰字) */
  @state() private openDone = false;

  render() {
    const it = this.item;
    if (it.state !== 'pending') {
      const dismissed = it.state === 'dismissed';
      const summary = dismissed
        ? '模型将自行假设继续'
        : Object.values(it.answers ?? {})
            .map((v) => (Array.isArray(v) ? v.join('、') : String(v)))
            .join(';');
      return html`
        <div class="done" title="点击展开/折叠答案" @click=${() => (this.openDone = !this.openDone)}>
          <svg class="chev ${this.openDone ? 'open' : ''}" viewBox="0 0 16 16">
            <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="k">${dismissed ? '已取消提问' : '已应答'}</span>
          <span class="txt">${summary || '—'}</span>
        </div>
        ${this.openDone
          ? html`<div class="done-detail"><pre>${prettyAnswers(it.answers)}</pre></div>`
          : nothing}
      `;
    }
    // 全部为"单选选项题"时点击选项即提交,无需提交按钮
    const clickSubmit = it.questions.every((q) => q.options?.length && !q.multi_select);
    return html`
      <div class="card ${this.flat ? 'flat' : ''}">
        <div class="banner">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M2.5 3.5h11v7.5h-6L4 13.5V11H2.5z" stroke-linejoin="round" />
          </svg>
          模型需要你的回答
        </div>
        ${it.questions.map((q, qi) => this.renderQuestion(q, qi))}
        <div class="actions">
          ${clickSubmit
            ? html`<span class="hint">点击选项即提交</span>`
            : html`<span class="hint">多选/输入题需点"提交回答"</span>`}
          ${this.showDismiss
            ? html`<button class="ghost" @click=${() => this.fire('dismiss', { callId: it.callId })}>取消提问</button>`
            : nothing}
          ${clickSubmit
            ? nothing
            : html`<button class="primary" @click=${this.submit}>提交回答</button>`}
        </div>
      </div>
    `;
  }

  private renderQuestion(q: AskQuestion, qi: number) {
    return html`
      <div class="q">
        <div class="head">
          ${q.question}${q.header ? html`<span class="tag">${q.header}</span>` : nothing}
        </div>
        ${q.options?.length
          ? html`
              <div class="opts">
                ${q.options.map(
                  (o) => html`
                    ${q.multi_select
                      ? html`
                          <label class="opt ${this.isSelected(q.id, o.label) ? 'sel' : ''}">
                            <input
                              type="checkbox"
                              .checked=${this.isSelected(q.id, o.label)}
                              @change=${() => this.toggle(q.id, o.label, true)}
                            />
                            <span class="t">
                              <span>${o.label}</span>
                              ${o.description ? html`<span class="d">${o.description}</span>` : nothing}
                            </span>
                          </label>
                        `
                      : html`
                          <div
                            class="opt ${this.isSelected(q.id, o.label) ? 'sel' : ''}"
                            title="点击即提交"
                            @click=${() => this.pickSingle(q.id, o.label)}
                          >
                            <span class="dot"></span>
                            <span class="t">
                              <span>${o.label}</span>
                              ${o.description ? html`<span class="d">${o.description}</span>` : nothing}
                            </span>
                          </div>
                        `}
                  `,
                )}
              </div>
            `
          : html`
              <textarea
                data-qid=${q.id}
                placeholder="输入回答…(Enter 换行)"
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.submit();
                }}
              ></textarea>
            `}
      </div>
    `;
  }

  private isSelected(qid: string, label: string): boolean {
    return this.selection.get(qid)?.has(label) ?? false;
  }

  private toggle(qid: string, label: string, multi: boolean): void {
    let set = this.selection.get(qid);
    if (!set) {
      set = new Set();
      this.selection.set(qid, set);
    }
    if (!multi) set.clear();
    if (set.has(label)) set.delete(label);
    else set.add(label);
    this.requestUpdate();
  }

  // pickSingle 单选:选中并立即提交。
  private pickSingle(qid: string, label: string): void {
    this.selection.set(qid, new Set([label]));
    this.submit();
  }

  private submit(): void {
    const answers: Record<string, unknown> = {};
    for (const q of this.item.questions) {
      const sel = this.selection.get(q.id);
      if (q.options?.length) {
        answers[q.id] = q.multi_select ? [...(sel ?? [])] : [...(sel ?? [])][0] ?? '';
      } else {
        const input = this.renderRoot.querySelector<HTMLTextAreaElement>(
          `textarea[data-qid="${CSS.escape(q.id)}"]`,
        );
        answers[q.id] = input?.value ?? '';
      }
    }
    this.fire('answer', { callId: this.item.callId, answers });
  }

  private fire(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

// prettyAnswers 展开态展示:qid → 答案逐行。
function prettyAnswers(answers?: Record<string, unknown>): string {
  const entries = Object.entries(answers ?? {});
  if (!entries.length) return '—';
  return entries
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('、') : String(v)}`)
    .join('\n');
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-ask-form': GrfAskForm;
  }
}
