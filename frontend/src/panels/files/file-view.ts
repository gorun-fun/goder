// file-view.ts — <goder-file-view>:右栏「文件」tab 的文件预览(桌面态,
// 左栏文件树点击文件打开,每个文件一个 tab)。按扩展名分三类:
// 文本(等宽字体 + 行号,Desktop.ReadFile,上限 2MB)、图片(<img> data
// URL,Desktop.ReadImage,上限 10MB)、markdown(默认源码,头部眼睛图标
// 切换渲染预览)。头部标题显示项目内相对路径。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GoderPanel, theme, controls } from '../../ui/panel';
import { markdownCss } from '../../ui/markdown-css';
import type { PropertyValues } from 'lit';
import { icon } from '../../util/icons';
import { renderMarkdown } from '../../util/markdown';
import { inWails, readFileText, readImageDataUrl } from '../../host/bridge';

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

@customElement('goder-file-view')
export class GoderFileView extends GoderPanel {
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

  // openHtmlPreview html 文件的「眼睛」:桌面态直接下发真实路径(原生
  // webview 按 file:// 加载,相对资源/刷新均按真实路径解析),非桌面形态
  // 回退 data URL。
  private openHtmlPreview(): void {
    if (!this.text) return;
    const url = inWails() ? this.path : `data:text/html;charset=utf-8,${encodeURIComponent(this.text)}`;
    this.dispatchEvent(new CustomEvent('goder-open-browser-url', { detail: { url }, bubbles: true, composed: true }));
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
        font-family: var(--goder-font);
        font-size: var(--goder-font-size);
        color: var(--goder-text);
      }
      .head {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--goder-border-soft);
        font-weight: 650;
        font-size: var(--goder-font-size-sm);
        user-select: none;
        min-width: 0;
      }
      .head .ic {
        flex: none;
        display: inline-flex;
        color: var(--goder-text-faint);
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
        font-family: var(--goder-mono);
        font-weight: 500;
        font-size: var(--goder-font-size-xs);
      }
      .head button {
        flex: none;
        padding: 3px 5px;
      }
      .head .eye.on {
        color: var(--goder-accent-text);
        background: var(--goder-accent-soft);
      }
      .body {
        flex: 1;
        min-height: 0;
        display: flex;
        overflow: auto;
        font-family: var(--goder-mono);
        font-size: var(--goder-font-size-xs);
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
        color: var(--goder-text-faint);
        background: var(--goder-bg-raise);
        border-right: 1px solid var(--goder-border-soft);
        user-select: none;
        white-space: pre;
      }
      .code {
        flex: none;
        margin: 0;
        padding: 8px 12px 12px;
        white-space: pre;
        color: var(--goder-text);
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
        border-radius: var(--goder-radius-sm);
        border: 1px solid var(--goder-border-soft);
      }
      /* markdown 渲染预览(容器;元素样式在下方 markdownCss) */
      .md {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 14px 16px 20px;
        line-height: 1.72;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .empty {
        padding: 40px 16px;
        text-align: center;
        color: var(--goder-text-faint);
        font-size: var(--goder-font-size-xs);
      }
      .empty.err {
        color: var(--goder-error);
      }
    `,
    /* markdown 输出元素样式与消息正文同款(full 档,单一维护点) */
    markdownCss('full'),
    css`
      /* 与消息正文的两处本地差异:代码块亮色底(消息区为深色底)、
       * 表格边框更柔和且单元格稍窄;选择器与 markdownCss 同形以保证覆写 */
      .md pre.md-code {
        background: var(--goder-bg-raise);
      }
      .md pre.md-code code {
        color: inherit;
      }
      .md table.md-table th,
      .md table.md-table td {
        border-color: var(--goder-border-soft);
        padding: 4px 9px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-file-view': GoderFileView;
  }
}
