// tool-card.ts — 工具调用行:{工具中文名} {主参数(路径/命令)} [+增/-删] ·
// {时长} ›,点击展开显示可读的关键参数明细,不展示原始 JSON。主参数与
// edit/write 的 +nn/-nn 都从(可能仍在流式生成中的)参数容错统计,随模型
// 输出实时上屏。ask_user_question 由上层过滤,不渲染。
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme } from '../../ui/panel';
import { fileEditStat, fmtToolDuration, toolDetail, toolFilePath, toolLabel, toolPrimaryText } from '../../util/fmt';
import { clickCoordOf, isClickTool, parseShotMeta } from '../../core/model/chat-model';
import type { ToolItem } from '../../core/model/chat-model';

@customElement('goder-tool-card')
export class GoderToolCard extends LitElement {
  @property({ type: Object }) item!: ToolItem;
  /** 点击类工具的定位底图:它之前最近一张截图(data URL);缺省则不显示「查看」。 */
  @property({ type: Object, attribute: false }) ctxShot?: string;
  /** 底图截图的结果文本(含覆盖起点/scale meta;全局坐标换算图上像素用) */
  @property({ type: Object, attribute: false }) ctxMeta?: string;

  @state() private open = false;
  /** 截图放大浮层(点「查看截图」打开) */
  @state() private shotOpen = false;
  /** 点击定位图展开态(点「查看」切换) */
  @state() private spotOpen = false;
  /** 定位底图的原始像素尺寸(算圈圈百分比坐标用) */
  @state() private spotSize?: { w: number; h: number };

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
        color: var(--goder-text-dim);
        font-size: var(--goder-font-size-xs);
        line-height: 1.7;
        overflow-wrap: anywhere;
      }
      .line:hover {
        color: var(--goder-text);
      }
      /* 运行中:整行用主题强调色提示;调用结束回归默认弱化色 */
      .line.running,
      .line.running:hover {
        color: var(--goder-accent-text);
      }
      .line.running .subject.file:hover {
        color: var(--goder-accent);
      }
      .lab {
        flex: none;
      }
      .stat {
        display: inline-flex;
        gap: 5px;
        font-family: var(--goder-mono);
      }
      .subject {
        flex: 0 1 auto;
        min-width: 2em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--goder-mono);
      }
      /* 文件类工具:文件名可点击,在右栏直接开 tab 打开 */
      .subject.file {
        cursor: pointer;
        text-decoration: underline dotted;
        text-underline-offset: 3px;
      }
      .subject.file:hover {
        color: var(--goder-accent-text);
      }
      .time {
        flex: none;
        color: var(--goder-text-faint);
        font-family: var(--goder-mono);
      }
      .stat {
        display: inline-flex;
        flex: none;
        gap: 5px;
        font-family: var(--goder-mono);
      }
      .stat .add {
        color: var(--goder-success);
      }
      .stat .del {
        color: var(--goder-error);
      }
      .chev {
        width: 12px;
        height: 12px;
        flex: none;
        color: var(--goder-text-faint);
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
        font-family: var(--goder-mono);
        font-size: var(--goder-font-size-xs);
        line-height: 1.6;
        color: var(--goder-text-dim);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 240px;
        overflow: auto;
      }
      /* 截图工具:行尾「查看截图」链接 + 全屏放大浮层(点击任意处关闭) */
      .shot-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 24px;
        background: rgb(0 0 0 / 0.72);
        cursor: zoom-out;
      }
      .shot-overlay img {
        max-width: 92vw;
        max-height: 86vh;
        border-radius: 6px;
        box-shadow: 0 8px 40px rgb(0 0 0 / 0.5);
      }
      /* 点击类工具:行内「查看」链接 + 展开的定位图(截图上圈出点击位置) */
      .view {
        flex: none;
        color: var(--goder-accent-text);
        text-decoration: underline dotted;
        text-underline-offset: 3px;
        cursor: pointer;
      }
      .view:hover {
        color: var(--goder-accent);
      }
      .spot {
        position: relative;
      }
      .spot img {
        display: block;
        max-width: 92vw;
        max-height: 86vh;
        border-radius: 6px;
        box-shadow: 0 8px 40px rgb(0 0 0 / 0.5);
      }
      .spot .ring {
        position: absolute;
        width: 18px;
        height: 18px;
        border: 2px solid var(--goder-accent);
        border-radius: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
        /* 呼吸圈:提示这就是本次点击的位置 */
        animation: goder-ring 1.4s ease-in-out infinite;
      }
      .spot .dot {
        position: absolute;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--goder-accent);
        transform: translate(-50%, -50%);
        pointer-events: none;
      }
      @keyframes goder-ring {
        0%,
        100% {
          box-shadow: 0 0 0 0 rgb(0 0 0 / 0);
        }
        50% {
          box-shadow: 0 0 0 4px rgb(0 0 0 / 0.15);
        }
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
    // (goder-open-file 由 app-shell 接管,已开则激活)。
    const filePath = toolFilePath(it.name, it.args);
    const fileName = filePath ? (filePath.split('/').pop() || filePath) : undefined;
    // 执行耗时紧跟工具名之后,文件/命令再跟其后。
    const dur = it.status !== 'error' && it.status !== 'denied' ? fmtToolDuration(it.endedAt ? it.endedAt - it.startedAt : undefined) : '';
    // edit/write:参数流式期间即统计 +增/-删(残缺 JSON 容错),随输出跳动;
    // 完成后按输出里的 N replacements 修正 replace_all 倍数。
    const stat = fileEditStat(it.name, it.args, it.output);
    // 点击类工具:坐标参数 + 前置截图齐备时,行尾给「查看」链接,展开后
    // 在截图上圈出本次点击位置(坐标是截图栅格像素,按原始尺寸换算百分比)。
    const spot = isClickTool(it.name) && it.status !== 'running' ? clickCoordOf(it.args) : undefined;
    const canSpot = !!(spot && this.ctxShot);
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
                  new CustomEvent('goder-open-file', {
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
        ${it.images?.length
          ? html`<span
              class="view"
              title="点击放大查看截图"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.shotOpen = true;
              }}
              >查看截图</span
            >`
          : nothing}
        ${canSpot
          ? html`<span
              class="view"
              title="查看点击位置"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.spotOpen = !this.spotOpen;
              }}
              >查看</span
            >`
          : nothing}
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
      ${canSpot && this.spotOpen && this.ctxShot && spot
        ? html`<div class="shot-overlay" title="点击关闭" @click=${() => (this.spotOpen = false)}>
            <div class="spot">
              <img
                src=${this.ctxShot}
                alt="点击位置"
                @load=${(e: Event) => {
                  const img = e.target as HTMLImageElement;
                  this.spotSize = { w: img.naturalWidth, h: img.naturalHeight };
                }}
              />
              ${this.spotSize
                ? (() => {
                    // 点击坐标是全局屏幕坐标:按截图 meta 换算回图上像素
                    // ((全局 - 覆盖起点) × scale),meta 缺省按主屏原点/1x。
                    const meta = this.ctxMeta ? parseShotMeta(this.ctxMeta) : undefined;
                    const ox = meta?.ox ?? 0;
                    const oy = meta?.oy ?? 0;
                    const sc = meta?.scale ?? 1;
                    const left = `${(((spot.x - ox) * sc / this.spotSize.w) * 100).toFixed(2)}%`;
                    const top = `${(((spot.y - oy) * sc / this.spotSize.h) * 100).toFixed(2)}%`;
                    return html`<span class="ring" style="left:${left};top:${top}"></span
                      ><span class="dot" style="left:${left};top:${top}"></span>`;
                  })()
                : nothing}
            </div>
          </div>`
        : nothing}
      ${it.images?.length && this.shotOpen
        ? html`<div
            class="shot-overlay"
            title="点击关闭"
            @click=${() => (this.shotOpen = false)}
          >
            ${it.images.map((u) => html`<img src=${u} alt="截图" />`)}
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-tool-card': GoderToolCard;
  }
}
