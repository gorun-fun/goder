// tool-card.ts — 工具调用行:{工具中文名} {主参数(路径/命令)} [+增/-删] ·
// {时长} ›,点击展开显示可读的关键参数明细,不展示原始 JSON。主参数与
// edit/write 的 +nn/-nn 都从(可能仍在流式生成中的)参数容错统计,随模型
// 输出实时上屏。ask_user_question 由上层过滤,不渲染。
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme } from '../../ui/panel';
import { fileEditStat, fmtToolDuration, toolDetail, toolFilePath, toolLabel, toolPrimaryText } from '../../util/fmt';
import type { ToolItem } from '../../core/model/chat-model';

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
      /* 运行中:整行用主题强调色提示;调用结束回归默认弱化色 */
      .line.running,
      .line.running:hover {
        color: var(--grf-accent-text);
      }
      .line.running .subject.file:hover {
        color: var(--grf-accent);
      }
      .lab {
        flex: none;
      }
      .stat {
        display: inline-flex;
        gap: 5px;
        font-family: var(--grf-mono);
      }
      .subject {
        flex: 0 1 auto;
        min-width: 2em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--grf-mono);
      }
      /* 文件类工具:文件名可点击,在右栏直接开 tab 打开 */
      .subject.file {
        cursor: pointer;
        text-decoration: underline dotted;
        text-underline-offset: 3px;
      }
      .subject.file:hover {
        color: var(--grf-accent-text);
      }
      .time {
        flex: none;
        color: var(--grf-text-faint);
        font-family: var(--grf-mono);
      }
      .stat {
        display: inline-flex;
        flex: none;
        gap: 5px;
        font-family: var(--grf-mono);
      }
      .stat .add {
        color: var(--grf-success);
      }
      .stat .del {
        color: var(--grf-error);
      }
      .chev {
        width: 12px;
        height: 12px;
        flex: none;
        color: var(--grf-text-faint);
        transition: transform 0.15s;
      }
      /* 状态尾注(运行中/失败/已拒绝):固定不收缩,长命令由 subject 截断 */
      .tail {
        flex: none;
        white-space: nowrap;
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
    // 状态尾注:运行中/失败/已拒绝;耗时则紧跟工具名展示,不放行尾。
    let tail = '';
    if (it.status === 'running') tail = '运行中';
    else if (it.status === 'error') tail = '失败';
    else if (it.status === 'denied') tail = '已拒绝';
    const detail = toolDetail(it.name, it.args);
    // 主参数(文件路径/命令)尽早显示:参数流式期间容错提取,文件名一流出
    // 就上屏,不再只剩"运行中"转圈。
    const subject = toolPrimaryText(it.name, it.args);
    // 文件类工具:行内展示文件名(悬停看全路径),点击在右栏开 tab 打开
    // (grf-open-file 由 app-shell 接管,已开则激活)。
    const filePath = toolFilePath(it.name, it.args);
    const fileName = filePath ? (filePath.split('/').pop() || filePath) : undefined;
    // 执行耗时紧跟工具名之后,文件/命令再跟其后。
    const dur = it.status !== 'error' && it.status !== 'denied' ? fmtToolDuration(it.endedAt ? it.endedAt - it.startedAt : undefined) : '';
    // edit/write:参数流式期间即统计 +增/-删(残缺 JSON 容错),随输出跳动;
    // 完成后按输出里的 N replacements 修正 replace_all 倍数。
    const stat = fileEditStat(it.name, it.args, it.output);
    return html`
      <div class="line ${it.status === 'running' ? 'running' : ''}" @click=${() => (this.open = !this.open)}>
        <span class="lab">${label}</span>
        ${dur ? html`<span class="time">${dur}</span>` : nothing}
        ${fileName && filePath
          ? html`<span
              class="subject file"
              title=${`点击在右栏打开:${filePath}`}
              @click=${(e: Event) => {
                e.stopPropagation();
                this.dispatchEvent(
                  new CustomEvent('grf-open-file', {
                    detail: { path: filePath, name: fileName, rel: fileName },
                    bubbles: true,
                    composed: true,
                  }),
                );
              }}
              >${fileName}</span
            >`
          : subject
            ? html`<span class="subject">${subject}</span>`
            : nothing}
        ${stat && (stat.add || stat.del)
          ? html`<span class="stat">
              ${stat.add ? html`<span class="add">+${stat.add}</span>` : nothing}
              ${stat.del ? html`<span class="del">-${stat.del}</span>` : nothing}
            </span>`
          : nothing}
        ${tail ? html`<span class="tail">· ${tail}</span>` : nothing}
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
