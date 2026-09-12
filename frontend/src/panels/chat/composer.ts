// composer.ts — 聊天输入框:自动增高、Enter 发送 / Shift+Enter 换行、
// 粘贴/选择图片(data URL 多模态)、运行中切换为停止按钮。
// 模型暂停提问(ask)时,输入框整体变高并在框内直接展示选项与问题,
// 点击单选选项即确认提交。
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme, controls } from '../../ui/base';
import type { AskItem } from '../../state/chat-model';
import './ask-form';

@customElement('grf-composer')
export class GrfComposer extends LitElement {
  /** 运行中(切换为停止) */
  @property({ type: Boolean }) running = false;
  /** 有暂停待应答时不允许普通发送 */
  @property({ type: Boolean }) inputRequired = false;
  /** 待应答的提问(非空时输入框内嵌问题与选项) */
  @property({ type: Array }) asks: AskItem[] = [];
  @property({ type: String }) placeholder = '发送消息…(Enter 发送,Shift+Enter 换行)';

  @state() private images: string[] = [];
  @state() private text = '';

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
      }
      .wrap {
        border: 1px solid var(--grf-border);
        border-radius: 12px;
        /* 背景与卡片同黑拉通,仅以描边勾勒输入框 */
        background: transparent;
        padding: 8px 10px;
        display: grid;
        gap: 6px;
        transition: border-color 0.15s;
      }
      .wrap:focus-within {
        border-color: var(--grf-accent);
      }
      /* 应答态:输入框整体变高,内嵌问题与选项 */
      .wrap.asking {
        border-color: var(--grf-accent);
        background: var(--grf-accent-soft);
        padding: 14px 16px;
      }
      .ask-wrap {
        display: grid;
        gap: 12px;
      }
      .ask-head {
        display: flex;
        align-items: center;
        gap: 7px;
        color: var(--grf-accent-text);
        font-size: var(--grf-font-size-sm);
        font-weight: 600;
      }
      .ask-head svg {
        width: 15px;
        height: 15px;
      }
      textarea {
        background: transparent;
        border: none;
        padding: 0;
        font-size: var(--grf-font-size);
        line-height: 1.6;
        resize: none;
        min-height: 24px;
        max-height: 200px;
        font-family: var(--grf-font);
        color: var(--grf-text);
        outline: none;
        width: 100%;
        box-sizing: border-box;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .hint {
        flex: 1;
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .imgs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .img-chip {
        position: relative;
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius-sm);
        overflow: hidden;
        width: 64px;
        height: 64px;
      }
      .img-chip img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .img-chip button {
        position: absolute;
        top: 2px;
        right: 2px;
        padding: 1px 3px;
        background: rgba(0, 0, 0, 0.65);
        border: none;
        border-radius: 4px;
        color: #fff;
        line-height: 1;
      }
      .img-chip button svg {
        width: 10px;
        height: 10px;
      }
      /* 发送/停止:仅图标按钮(无文字),统一 30×30 方形 */
      .send,
      .stop {
        padding: 0;
        width: 30px;
        height: 30px;
        flex: none;
        justify-content: center;
      }
      .send svg,
      .stop svg {
        width: 15px;
        height: 15px;
      }
      .send {
        background: var(--grf-accent);
        border-color: var(--grf-accent);
        color: #fff;
      }
      .send:hover:not(:disabled) {
        filter: brightness(1.12);
      }
      .stop {
        background: var(--grf-error-soft);
        border-color: var(--grf-error);
        color: var(--grf-error);
      }
      .stop:hover:not(:disabled) {
        background: rgba(229, 83, 75, 0.22);
      }
      .attach {
        color: var(--grf-text-dim);
      }
      input[type='file'] {
        display: none;
      }
    `,
  ];

  render() {
    const asking = this.asks.length > 0;
    return html`
      <div class="wrap ${asking ? 'asking' : ''}">
        ${asking
          ? html`
              <div class="ask-wrap">
                <div class="ask-head">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                    <path d="M2.5 3.5h11v7.5h-6L4 13.5V11H2.5z" stroke-linejoin="round" />
                  </svg>
                  模型需要你的回答
                </div>
                ${this.asks.map(
                  (a) => html`
                    <grf-ask-form flat .item=${a} show-dismiss></grf-ask-form>
                  `,
                )}
              </div>
            `
          : nothing}
        ${asking
          ? nothing
          : html`
              ${this.images.length
                ? html`
                    <div class="imgs">
                      ${this.images.map(
                        (u, i) => html`
                          <div class="img-chip">
                            <img src=${u} alt="附件" />
                            <button @click=${() => this.removeImage(i)} title="移除">
                              <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
                            </button>
                          </div>
                        `,
                      )}
                    </div>
                  `
                : nothing}
              <textarea
                .value=${this.text}
                placeholder=${this.inputRequired ? '等待应答上方问题…' : this.placeholder}
                rows="1"
                spellcheck="false"
                @input=${this.onInput}
                @keydown=${this.onKeydown}
                @paste=${this.onPaste}
              ></textarea>
              <div class="bar">
                <button class="ghost attach" title="附加图片" ?disabled=${this.running} @click=${this.pickImage}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
                    <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1" stroke-linejoin="round" />
                    <circle cx="6" cy="6.6" r="1.1" />
                    <path d="M2.8 11.5l3.4-3 2.4 2.2 2.2-2 2.4 2.6" stroke-linejoin="round" />
                  </svg>
                </button>
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple @change=${this.onFile} />
                <span class="hint">${this.hint()}</span>
                ${this.running
                  ? html`<button class="stop" title="停止" aria-label="停止" @click=${this.stop}>
                      <svg viewBox="0 0 16 16" fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /></svg>
                    </button>`
                  : html`<button
                      class="send"
                      title="发送"
                      aria-label="发送"
                      ?disabled=${this.inputRequired}
                      @click=${this.submit}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9">
                        <path d="M8 13V3.8" stroke-linecap="round" />
                        <path d="M4 7.8L8 3.8l4 4" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>`}
              </div>
            `}
      </div>
    `;
  }

  private hint(): string {
    if (this.running) return '回合运行中…';
    if (this.inputRequired) return '模型在等待上面的交互应答';
    return '';
  }

  private onInput(e: InputEvent): void {
    const ta = e.target as HTMLTextAreaElement;
    this.text = ta.value;
    this.autosize(ta);
  }

  private autosize(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    }
  }

  private onPaste(e: ClipboardEvent): void {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void this.addFile(file);
        }
      }
    }
  }

  private pickImage(): void {
    this.renderRoot.querySelector<HTMLInputElement>('input[type=file]')?.click();
  }

  private onFile(e: Event): void {
    const input = e.target as HTMLInputElement;
    for (const f of input.files ?? []) void this.addFile(f);
    input.value = '';
  }

  private async addFile(f: File): Promise<void> {
    const url = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(f);
    });
    this.images = [...this.images, url];
  }

  private removeImage(i: number): void {
    this.images = this.images.filter((_, x) => x !== i);
  }

  private submit(): void {
    if (this.running || this.inputRequired) return;
    if (!this.text.trim() && !this.images.length) return;
    this.fire('send', { text: this.text, images: this.images });
    this.text = '';
    this.images = [];
    const ta = this.renderRoot.querySelector('textarea');
    if (ta) {
      ta.value = '';
      this.autosize(ta);
    }
  }

  private stop(): void {
    this.fire('stop', {});
  }

  private fire(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-composer': GrfComposer;
  }
}
