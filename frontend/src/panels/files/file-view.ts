// file-view.ts — <grf-file-view>:右栏「文件」tab 的文件预览(桌面态,
// 左栏文件树点击文件打开,每个文件一个 tab)。按扩展名分三类:
// 文本(等宽字体 + 行号,Desktop.ReadFile,上限 2MB)、图片(<img> data
// URL,Desktop.ReadImage,上限 10MB)、markdown(默认源码,头部眼睛图标
// 切换渲染预览)。头部标题显示项目内相对路径。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import type { PropertyValues } from 'lit';
import { icon } from '../../util/icons';
import { renderMarkdown } from '../../util/markdown';
import { readFileText, readImageDataUrl } from '../../host/bridge';

/** 图片扩展名(走 ReadImage 预览) */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
/** markdown 扩展名(提供渲染预览切换) */
const MD_EXTS = new Set(['md', 'markdown']);
/** html 扩展名(眼睛在右栏「浏览器」tab 内渲染) */
const HTML_EXTS = new Set(['html', 'htm']);

function extOf(path: string): string {
  const seg = path.split('/').pop() ?? '';
  const i = seg.lastIndexOf('.');
  return i > 0 ? seg.slice(i + 1).toLowerCase() : '';
}

@customElement('grf-file-view')
export class GrfFileView extends GrfPanel {
  /** 文件绝对路径 */
  @property({ type: String }) path = '';
  /** 文件名(缺省取 path 尾段) */
  @property({ type: String }) name = '';
  /** 项目内相对路径(头部标题;缺省回退文件名) */
  @property({ type: String }) rel = '';

  /** 文件类别 */
  @state() private kind: 'text' | 'image' | 'md' = 'text';
  @state() private text = '';
  @state() private imgSrc = '';
  @state() private error = '';
  @state() private loading = false;
  /** md 渲染预览开关(源码 ⇄ 渲染) */
  @state() private mdPreview = false;

  protected willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has('path') && this.path) void this.load();
  }

  private async load(): Promise<void> {
    const p = this.path;
    const ext = extOf(p);
    this.kind = IMAGE_EXTS.has(ext) ? 'image' : MD_EXTS.has(ext) ? 'md' : 'text';
    this.mdPreview = false;
    this.loading = true;
    this.error = '';
    try {
      if (this.kind === 'image') {
        const src = await readImageDataUrl(p);
        if (this.path !== p) return;
        this.imgSrc = src;
      } else {
        const text = await readFileText(p);
        if (this.path !== p) return;
        this.text = text;
      }
      this.loading = false;
    } catch (e) {
      if (this.path !== p) return;
      this.text = '';
      this.imgSrc = '';
      this.error = (e as Error)?.message ?? String(e);
      this.loading = false;
    }
  }

  private get fileTitle(): string {
    return this.rel || this.name || this.path.split('/').pop() || this.path;
  }

  // openHtmlPreview html 文件的「眼睛」:内容编码为 data URL,抛给
  // chat-panel 在右栏开浏览器 tab 并导航渲染(与本面板的 md 预览对应)。
  private openHtmlPreview(): void {
    if (!this.text) return;
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(this.text)}`;
    this.dispatchEvent(new CustomEvent('grf-open-browser-url', { detail: { url }, bubbles: true, composed: true }));
  }

  render() {
    if (!this.path) {
      return html`<div class="head">文件</div><div class="empty">未选择文件(在左栏文件树中点击文件打开)</div>`;
    }
    const lines = this.text ? this.text.split('\n') : [];
    return html`
      <div class="head" title=${this.path}>
        <span class="ic">${unsafeHTML(this.kind === 'image' ? icon.image : icon.file)}</span>
        <span class="t">${this.fileTitle}</span>
        ${this.kind === 'md'
          ? html`<button
              class="eye ghost ${this.mdPreview ? 'on' : ''}"
              title=${this.mdPreview ? '查看源码' : '渲染预览'}
              @click=${() => (this.mdPreview = !this.mdPreview)}
            >
              ${unsafeHTML(icon.eye)}
            </button>`
          : HTML_EXTS.has(extOf(this.path))
            ? html`<button
                class="eye ghost"
                title="在右栏浏览器 tab 渲染"
                ?disabled=${!this.text}
                @click=${() => this.openHtmlPreview()}
              >
                ${unsafeHTML(icon.eye)}
              </button>`
            : nothing}
        <button
          class="copy ghost"
          title="复制内容"
          ?disabled=${!this.text}
          @click=${() => void navigator.clipboard?.writeText(this.text).catch(() => {})}
        >
          ${unsafeHTML(icon.copy)}
        </button>
      </div>
      ${this.loading
        ? html`<div class="empty">读取中…</div>`
        : this.error
          ? html`<div class="empty err">${this.error}</div>`
          : this.kind === 'image'
            ? html`<div class="img-wrap"><img src=${this.imgSrc} alt=${this.fileTitle} /></div>`
            : this.kind === 'md' && this.mdPreview
              ? html`<div class="md">${unsafeHTML(renderMarkdown(this.text))}</div>`
              : html`
                  <div class="body">
                    <pre class="ln">${lines.map((_, i) => html`${i + 1}\n`)}</pre>
                    <pre class="code">${this.text}</pre>
                  </div>
                `}
    `;
  }

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: transparent;
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        color: var(--grf-text);
      }
      .head {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--grf-border-soft);
        font-weight: 650;
        font-size: var(--grf-font-size-sm);
        user-select: none;
        min-width: 0;
      }
      .head .ic {
        flex: none;
        display: inline-flex;
        color: var(--grf-text-faint);
      }
      .head .ic svg {
        width: 13px;
        height: 13px;
      }
      .head .t {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        /* 相对路径含目录段,用小一号避免挤占操作按钮 */
        font-family: var(--grf-mono);
        font-weight: 500;
        font-size: var(--grf-font-size-xs);
      }
      .head button {
        flex: none;
        padding: 3px 5px;
      }
      .head .eye.on {
        color: var(--grf-accent-text);
        background: var(--grf-accent-soft);
      }
      .body {
        flex: 1;
        min-height: 0;
        display: flex;
        overflow: auto;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
        line-height: 1.6;
      }
      /* 行号列固定宽,内容横向滚动时行号固定在左侧 */
      .ln {
        flex: none;
        margin: 0;
        padding: 8px 0 12px;
        width: 40px;
        box-sizing: border-box;
        text-align: right;
        padding-right: 10px;
        color: var(--grf-text-faint);
        background: var(--grf-bg-raise);
        border-right: 1px solid var(--grf-border-soft);
        user-select: none;
        white-space: pre;
      }
      .code {
        flex: none;
        margin: 0;
        padding: 8px 12px 12px;
        white-space: pre;
        color: var(--grf-text);
        min-width: 0;
      }
      /* 图片:居中展示,可滚动,不放大超过面板宽 */
      .img-wrap {
        flex: 1;
        min-height: 0;
        overflow: auto;
        display: grid;
        place-content: start center;
        padding: 16px;
      }
      .img-wrap img {
        max-width: 100%;
        border-radius: var(--grf-radius-sm);
        border: 1px solid var(--grf-border-soft);
      }
      /* markdown 渲染预览 */
      .md {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 14px 16px 20px;
        line-height: 1.72;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .md > :first-child {
        margin-top: 0;
      }
      .md > :last-child {
        margin-bottom: 0;
      }
      .md .md-p {
        margin: 0 0 8px;
      }
      .md .md-h {
        margin: 14px 0 7px;
        font-weight: 650;
        line-height: 1.4;
      }
      .md h1.md-h,
      .md h2.md-h {
        font-size: 16px;
        border-bottom: 1px solid var(--grf-border-soft);
        padding-bottom: 4px;
      }
      .md h3.md-h {
        font-size: 14.5px;
      }
      .md h4.md-h,
      .md h5.md-h,
      .md h6.md-h {
        font-size: 13.5px;
      }
      .md code {
        font-family: var(--grf-mono);
        font-size: 0.9em;
        background: var(--grf-bg-hover);
        border-radius: 4px;
        padding: 1px 5px;
      }
      .md pre.md-code {
        background: var(--grf-bg-raise);
        border: 1px solid var(--grf-border-soft);
        border-radius: var(--grf-radius-sm);
        padding: 10px 12px;
        overflow: auto;
        margin: 0 0 8px;
      }
      .md pre.md-code code {
        background: none;
        padding: 0;
        font-size: var(--grf-font-size-xs);
        line-height: 1.6;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .md ul,
      .md ol {
        margin: 0 0 8px;
        padding-left: 22px;
      }
      .md li {
        margin: 2px 0;
      }
      .md a {
        color: var(--grf-accent-text);
      }
      .md blockquote.md-quote {
        margin: 0 0 8px;
        padding: 2px 12px;
        border-left: 3px solid var(--grf-border);
        color: var(--grf-text-dim);
      }
      .md hr.md-hr {
        border: none;
        border-top: 1px solid var(--grf-border);
        margin: 12px 0;
      }
      .md table {
        display: block;
        overflow-x: auto;
        max-width: 100%;
        border-collapse: collapse;
        margin: 0 0 8px;
        font-size: var(--grf-font-size-sm);
      }
      .md th,
      .md td {
        border: 1px solid var(--grf-border-soft);
        padding: 4px 9px;
        text-align: left;
        vertical-align: top;
      }
      .md th {
        background: var(--grf-bg-hover);
        font-weight: 650;
        white-space: nowrap;
      }
      .empty {
        padding: 40px 16px;
        text-align: center;
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
      }
      .empty.err {
        color: var(--grf-error);
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-file-view': GrfFileView;
  }
}
