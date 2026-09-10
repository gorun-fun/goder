// review.ts — <grf-review>:git 审查面板(右栏 tab 之一)。
// 读取当前项目目录的 git 状态(分支/领先落后/文件分组),点文件行内展开
// diff;经 Desktop 服务执行 git,仅桌面态可用。打开期间 10s 轮询刷新。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../ui/base';
import { icon } from '../util/icons';
import { inWails, gitStatus, gitDiff, type GitStatusDTO, type GitEntryDTO } from '../host/bridge';

/** 分组展示键(entry 归属):S=已暂存 W=未暂存 ?=未跟踪 */
type Group = 'S' | 'W' | '?';

const groupOf = (e: GitEntryDTO): Group | null => {
  if (e.index === '?' && e.work === '?') return '?';
  if (e.index !== ' ' && e.index !== '?') return 'S';
  if (e.work !== ' ' && e.work !== '?') return 'W';
  return null;
};

const GROUP_LABEL: Record<Group, string> = { S: '已暂存', W: '未暂存', '?': '未跟踪' };

@customElement('grf-review')
export class GrfReview extends GrfPanel {
  /** 审查的项目本地目录 */
  @property({ type: String }) cwd = '';

  @state() private status: GitStatusDTO | null = null;
  @state() private error = '';
  @state() private loading = false;
  /** 当前展开的 diff 键(`${group}:${path}`) */
  @state() private expanded = '';
  private diffs = new Map<string, string>();
  private poll?: number;
  private seq = 0;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        font-size: var(--grf-font-size-sm);
        background: transparent;
      }
      .head {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--grf-border-soft);
        user-select: none;
      }
      .branch {
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: 1;
      }
      .ab {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .ab.up {
        color: var(--grf-success);
      }
      .ab.down {
        color: var(--grf-warn);
      }
      .head button.ghost {
        padding: 2px 5px;
      }
      .list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 6px 6px 12px;
      }
      .grp {
        margin-bottom: 4px;
      }
      .grp-t {
        font-size: var(--grf-font-size-xs);
        font-weight: 650;
        color: var(--grf-text-faint);
        letter-spacing: 0.4px;
        padding: 6px 6px 3px;
        user-select: none;
      }
      .file {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 6px;
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        color: var(--grf-text-dim);
        min-width: 0;
      }
      .file:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .file.on {
        background: var(--grf-bg-active);
        color: var(--grf-text);
      }
      .file .st {
        flex: none;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
        width: 14px;
        text-align: center;
      }
      .st.mod {
        color: var(--grf-warn);
      }
      .st.add {
        color: var(--grf-success);
      }
      .st.del {
        color: var(--grf-error);
      }
      .st.untr {
        color: var(--grf-text-faint);
      }
      .file .p {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
      }
      .diff {
        margin: 0 4px 4px;
        border: 1px solid var(--grf-border-soft);
        border-radius: var(--grf-radius-sm);
        overflow: auto;
        max-height: 320px;
        background: var(--grf-bg);
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
        line-height: 1.55;
      }
      .diff .ln {
        white-space: pre;
        padding: 0 8px;
        min-width: max-content;
      }
      .diff .ln.add {
        color: var(--grf-success);
        background: var(--grf-success-soft);
      }
      .diff .ln.del {
        color: var(--grf-error);
        background: var(--grf-error-soft);
      }
      .diff .ln.hunk {
        color: var(--grf-reasoning);
        background: var(--grf-reasoning-soft);
      }
      .diff .ln.meta {
        color: var(--grf-text-faint);
      }
      .hint {
        padding: 40px 18px;
        text-align: center;
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-sm);
        line-height: 1.8;
        display: grid;
        gap: 8px;
        justify-items: center;
      }
      .hint svg {
        width: 30px;
        height: 30px;
        opacity: 0.5;
      }
      .err {
        margin: 10px 12px;
        border: 1px solid var(--grf-error);
        background: var(--grf-error-soft);
        color: var(--grf-error);
        border-radius: var(--grf-radius-sm);
        padding: 8px 12px;
        font-size: var(--grf-font-size-xs);
        word-break: break-all;
      }
      .clean {
        padding: 30px 18px;
        text-align: center;
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-sm);
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.refresh();
    this.poll = window.setInterval(() => this.refresh(), 10_000);
  }

  disconnectedCallback(): void {
    if (this.poll) window.clearInterval(this.poll);
    this.poll = undefined;
    super.disconnectedCallback();
  }

  protected updated(props: Map<string, unknown>): void {
    super.updated(props);
    if (props.has('cwd') && props.get('cwd') !== undefined) {
      this.diffs.clear();
      this.expanded = '';
      this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    if (!inWails() || !this.cwd) return;
    const mySeq = ++this.seq;
    this.loading = true;
    try {
      const st = await gitStatus(this.cwd);
      if (mySeq !== this.seq) return; // 过期响应丢弃
      this.status = st;
      this.error = '';
    } catch (e) {
      if (mySeq !== this.seq) return;
      this.status = null;
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (mySeq === this.seq) this.loading = false;
    }
  }

  private async toggleFile(e: GitEntryDTO, g: Group): Promise<void> {
    const key = `${g}:${e.path}`;
    if (this.expanded === key) {
      this.expanded = '';
      return;
    }
    this.expanded = key;
    if (!this.diffs.has(key)) {
      const d = await gitDiff(this.cwd, e.path, g === 'S');
      this.diffs.set(key, d ?? '(无差异或读取失败)');
      this.requestUpdate();
    }
  }

  /** 状态字母(X/Y)→ 展示用单字母与着色 */
  private stClass(g: Group): string {
    return g === '?' ? 'untr' : 'mod';
  }
  private stText(e: GitEntryDTO, g: Group): string {
    if (g === '?') return '?';
    return g === 'S' ? (e.index === 'R' ? 'R' : e.index) : e.work;
  }

  render() {
    if (!inWails()) {
      return this.renderHint('git 审查仅在桌面应用内可用');
    }
    if (!this.cwd) {
      return this.renderHint('当前项目未设置本地路径', '桌面态新建项目时选择目录,终端与审查都以它为工作区');
    }
    if (this.error) {
      return html`<div class="head">
          <span class="branch">—</span>
          <button class="ghost" title="刷新" @click=${() => this.refresh()}>${unsafeHTML(icon.refresh)}</button>
        </div>
        <div class="err">${this.error}</div>`;
    }
    const st = this.status;
    if (!st) {
      return this.renderHint('加载中…');
    }
    const groups: Array<[Group, GitEntryDTO[]]> = (['S', 'W', '?'] as Group[])
      .map((g) => [g, st.entries.filter((e) => groupOf(e) === g)] as [Group, GitEntryDTO[]])
      .filter(([, list]) => list.length > 0);

    return html`
      <div class="head">
        <span class="branch" title=${st.upstream ? `${st.branch} → ${st.upstream}` : st.branch}>
          ${st.branch}${st.upstream ? html`<span style="color:var(--grf-text-faint)"> → ${st.upstream}</span>` : nothing}
        </span>
        ${st.ahead ? html`<span class="ab up" title="领先远程 ${st.ahead} 个提交">↑${st.ahead}</span>` : nothing}
        ${st.behind ? html`<span class="ab down" title="落后远程 ${st.behind} 个提交">↓${st.behind}</span>` : nothing}
        <button class="ghost" title="刷新" @click=${() => this.refresh()}>${unsafeHTML(icon.refresh)}</button>
      </div>
      <div class="list">
        ${groups.length === 0
          ? html`<div class="clean">工作区干净,没有待审查的改动</div>`
          : groups.map(([g, list]) => this.renderGroup(g, list))}
      </div>
    `;
  }

  private renderGroup(g: Group, list: GitEntryDTO[]) {
    return html`
      <div class="grp">
        <div class="grp-t">${GROUP_LABEL[g]} (${list.length})</div>
        ${list.map((e) => {
          const key = `${g}:${e.path}`;
          return html`
            <div class="file ${this.expanded === key ? 'on' : ''}" title=${e.origPath ? `${e.origPath} → ${e.path}` : e.path} @click=${() => void this.toggleFile(e, g)}>
              <span class="st ${this.stClass(g)}">${this.stText(e, g)}</span>
              <span class="p">${e.path}</span>
            </div>
            ${this.expanded === key ? this.renderDiff(key) : nothing}
          `;
        })}
      </div>
    `;
  }

  private renderDiff(key: string) {
    const text = this.diffs.get(key);
    if (text === undefined) {
      return html`<div class="diff" style="padding:6px 8px;color:var(--grf-text-faint)">读取 diff…</div>`;
    }
    const lines = text.split('\n');
    return html`
      <div class="diff">
        ${lines.map((ln) => {
          let cls = '';
          if (ln.startsWith('@@')) cls = 'hunk';
          else if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ')) cls = 'meta';
          else if (ln.startsWith('+')) cls = 'add';
          else if (ln.startsWith('-')) cls = 'del';
          return html`<div class="ln ${cls}">${ln || ' '}</div>`;
        })}
      </div>
    `;
  }

  private renderHint(text: string, sub?: string) {
    return html`
      <div class="hint">
        ${unsafeHTML(icon.gitBranch)}
        <div>${text}</div>
        ${sub ? html`<div style="font-size:var(--grf-font-size-xs);color:var(--grf-text-faint)">${sub}</div>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-review': GrfReview;
  }
}
