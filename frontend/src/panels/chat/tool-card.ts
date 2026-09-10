// tool-card.ts — 工具调用行:{工具中文名} · {时长} ›,点击展开显示可读的
// 关键参数(bash 的命令、文件工具的路径等),不展示原始 JSON。
// ask_user_question 由上层过滤,不渲染。
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme } from '../../ui/base';
import { fmtToolDuration, toolDetail, toolLabel } from '../../util/fmt';
import type { ToolItem } from '../../state/chat-model';

@customElement('grf-tool-card')
export class GrfToolCard extends LitElement {
  @property({ type: Object }) item!: ToolItem;

  @state() private open = false;

  static styles = [
    theme,
    css`
      :host {
        display: block;
      }
      .line {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 1px 2px;
        cursor: pointer;
        user-select: none;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-xs);
        line-height: 1.7;
        overflow-wrap: anywhere;
      }
      .line:hover {
        color: var(--grf-text);
      }
      .chev {
        width: 12px;
        height: 12px;
        flex: none;
        color: var(--grf-text-faint);
        transition: transform 0.15s;
      }
      .chev.open {
        transform: rotate(90deg);
      }
      .detail {
        margin: 2px 0 4px 18px;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
        line-height: 1.6;
        color: var(--grf-text-dim);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 240px;
        overflow: auto;
      }
    `,
  ];

  render() {
    const it = this.item;
    const label = toolLabel(it.name);
    let tail = '';
    if (it.status === 'running') tail = '运行中';
    else if (it.status === 'error') tail = '失败';
    else if (it.status === 'denied') tail = '已拒绝';
    else tail = fmtToolDuration(it.endedAt ? it.endedAt - it.startedAt : undefined);
    const detail = toolDetail(it.name, it.args);
    return html`
      <div class="line" @click=${() => (this.open = !this.open)}>
        <span>${tail ? `${label} · ${tail}` : label}</span>
        <svg
          class="chev ${this.open ? 'open' : ''}"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      ${this.open && detail ? html`<pre class="detail">${detail}</pre>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-tool-card': GrfToolCard;
  }
}
