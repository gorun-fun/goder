// file-list.ts — <grf-file-list>:左栏项目文件树(桌面态,session-list
// 项目行的「查看文件」进入)。顶部为整行可点的「返回工作区」条目(冒泡
// grf-close-files 回到会话列表);其下以缩进树展示项目目录:目录行点击
// 原地展开/折叠(子级懒加载并缓存),不做逐级进入;文件行点击在右栏
// 打开(grf-open-file,见 app-shell → 右栏「文件」tab)。隐藏条目(.git
// 等)由 Desktop.ListDir 滤除。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../ui/base';
import type { PropertyValues, TemplateResult } from 'lit';
import { icon } from '../util/icons';
import { fmtRelative } from '../util/fmt';
import { listDir, type FileEntryDTO } from '../host/bridge';

@customElement('grf-file-list')
export class GrfFileList extends GrfPanel {
  /** 项目根目录绝对路径 */
  @property({ type: String }) root = '';
  /** 项目名(树标题行) */
  @property({ type: String }) projName = '';

  /** 已加载目录:绝对路径 → 条目(懒加载缓存) */
  @state() private tree = new Map<string, FileEntryDTO[] | null>();
  /** 展开的目录绝对路径集合 */
  @state() private expanded = new Set<string>();

  protected willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has('root') && this.root && !this.tree.has(this.root)) {
      this.expanded = new Set([this.root]);
      void this.loadDir(this.root);
    }
  }

  private async loadDir(dir: string): Promise<void> {
    if (this.tree.has(dir)) return;
    this.tree.set(dir, null); // null = 读取中
    this.tree = new Map(this.tree);
    const ents = await listDir(dir);
    if (!this.tree.has(dir)) return; // 根已切换:丢弃
    this.tree.set(dir, ents ?? []);
    this.tree = new Map(this.tree);
    if (!ents) this.errorDirs.add(dir);
    else this.errorDirs.delete(dir);
    this.requestUpdate();
  }

  /** 读取失败的目录(显示「读取失败」占位行) */
  private errorDirs = new Set<string>();

  private toggleDir(dir: string): void {
    if (this.expanded.has(dir)) this.expanded.delete(dir);
    else {
      this.expanded.add(dir);
      void this.loadDir(dir);
    }
    this.expanded = new Set(this.expanded);
  }

  render() {
    return html`
      <div class="back" title="返回工作区" @click=${() => this.fire('grf-close-files')}>
        ${unsafeHTML(icon.arrowLeft)}
        <span>返回工作区</span>
      </div>
      <div class="list">
        <div class="proj">${this.projName || '项目'}</div>
        ${this.renderDir(this.root, 0)}
      </div>
    `;
  }

  // renderDir 递归渲染某目录的子条目(缩进树);目录行原地展开/折叠。
  private renderDir(dir: string, depth: number): TemplateResult | typeof nothing | Array<TemplateResult | typeof nothing> {
    if (!this.expanded.has(dir)) return nothing;
    const loaded = this.tree.get(dir);
    if (loaded === undefined) return nothing;
    if (loaded === null) {
      return html`<div class="row load" style="padding-left:${11 + depth * 13}px">读取中…</div>`;
    }
    if (this.errorDirs.has(dir)) {
      return html`<div class="row load" style="padding-left:${11 + depth * 13}px">读取目录失败</div>`;
    }
    if (loaded.length === 0) {
      return html`<div class="row load" style="padding-left:${11 + depth * 13}px">空目录</div>`;
    }
    return loaded.map((e) => this.renderEntry(dir, e, depth));
  }

  private renderEntry(dir: string, e: FileEntryDTO, depth: number): TemplateResult {
    const full = `${dir}/${e.name}`;
    if (e.isDir) {
      const open = this.expanded.has(full);
      return html`
        <div
          class="row dir ${open ? 'open' : ''}"
          style="padding-left:${7 + depth * 13}px"
          title=${full}
          @click=${() => this.toggleDir(full)}
        >
          <span class="chev">${unsafeHTML(icon.chevron)}</span>
          <span class="ic">${unsafeHTML(open ? icon.folderOpen : icon.folder)}</span>
          <span class="nm">${e.name}</span>
        </div>
        ${this.renderDir(full, depth + 1)}
      `;
    }
    return html`
      <div
        class="row file"
        style="padding-left:${7 + depth * 13}px"
        title=${full}
        @click=${() =>
          this.fire('grf-open-file', {
            path: full,
            name: e.name,
            // 项目内相对路径(右栏 tab 与标题展示用)
            rel: full.startsWith(`${this.root}/`) ? full.slice(this.root.length + 1) : e.name,
          })}
      >
        <span class="chev"></span>
        <span class="ic">${unsafeHTML(icon.file)}</span>
        <span class="nm">${e.name}</span>
        <span class="at">${fmtRelative(e.modTime)}</span>
      </div>
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
        background: var(--grf-bg-raise);
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        color: var(--grf-text);
      }
      /* 整行可点的返回条目 */
      .back {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 9px 12px;
        border-bottom: 1px solid var(--grf-border-soft);
        font-weight: 650;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
        cursor: pointer;
        user-select: none;
      }
      .back:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .back svg {
        width: 13px;
        height: 13px;
        flex: none;
      }
      .list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        padding: 6px 6px 12px;
      }
      .proj {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        font-weight: 650;
        letter-spacing: 0.3px;
        padding: 4px 7px 6px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        user-select: none;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 5px 7px;
        border-radius: var(--grf-radius-sm);
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-sm);
        min-width: 0;
        cursor: default;
      }
      /* 展开指示:目录行右向箭头,展开后转 90°(向下) */
      .chev {
        width: 11px;
        height: 11px;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--grf-text-faint);
      }
      .chev svg {
        width: 10px;
        height: 10px;
        transition: transform 0.12s;
      }
      .row.dir.open .chev svg {
        transform: rotate(90deg);
      }
      .row .ic {
        width: 14px;
        height: 14px;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--grf-text-faint);
      }
      .row .ic svg {
        width: 13px;
        height: 13px;
      }
      .row .nm {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row .at {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .row.load {
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
        cursor: default;
      }
      .row.dir {
        cursor: pointer;
      }
      .row.dir:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .row.dir:hover .ic {
        color: var(--grf-accent-text);
      }
      .row.file {
        cursor: pointer;
      }
      .row.file:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .row.file:hover .ic {
        color: var(--grf-accent-text);
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-file-list': GrfFileList;
  }
}
