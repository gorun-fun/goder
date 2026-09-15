// status-pop.ts — <grf-status-pop>:聊天列右上角状态浮窗(自动显示)。
// 当前项目 git 概览(置顶)与模型 todo 任务 —— 有内容才显示对应区块,
// 都没有则整框不渲染;首个区块标题行右侧的收缩按钮可收成单行,聊天列
// 过窄时强制单行(narrow 属性)。todos 自行订阅 scope 数据域;git 状态由
// 宿主(chat 面板)轮询后经属性传入。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import type { GitStatusDTO } from '../../host/bridge';

@customElement('grf-status-pop')
export class GrfStatusPop extends GrfPanel {
  /** 当前项目 git 状态(null = 未取到/不适用) */
  @property({ type: Object }) git: GitStatusDTO | null = null;
  /** 聊天列过窄:强制单行,避免盖住对话内容 */
  @property({ type: Boolean }) narrow = false;

  /** 收缩态(单行只显示 git 行级变更);浮窗自动显示,无手动开关 */
  @state() private collapsed = false;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: block;
      }
      .status-pop {
        position: absolute;
        top: 6px;
        right: 10px;
        z-index: 60;
        width: 320px;
        max-width: calc(100% - 20px);
        max-height: min(440px, 72%);
        overflow-y: auto;
        background: var(--grf-bg-raise);
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        box-shadow: var(--grf-shadow);
        display: flex;
        flex-direction: column;
      }
      /* 收缩态:单行,宽度自适应内容;整行可点击展开 */
      .status-pop.collapsed {
        width: auto;
        cursor: pointer;
      }
      .status-pop.collapsed:hover {
        border-color: var(--grf-border-hover);
      }
      .sp-line {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 5px 6px 5px 12px;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      /* 收缩/展开按钮:展开态位于首个区块标题行右侧,收缩态随单行排布 */
      .sp-fold {
        padding: 3px 6px;
        border: none;
        background: transparent;
        color: var(--grf-text-dim);
        cursor: pointer;
        border-radius: 5px;
        display: inline-flex;
      }
      .sp-fold:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
      }
      .sp-fold svg {
        width: 13px;
        height: 13px;
      }
      /* 收起箭头朝上,展开(收缩态里)箭头朝下 */
      .status-pop:not(.collapsed) .sp-fold svg {
        transform: rotate(-90deg);
      }
      .status-pop.collapsed .sp-fold svg {
        transform: rotate(90deg);
      }
      .sp-diff {
        font-variant-numeric: tabular-nums;
      }
      .sp-diff .add {
        color: var(--grf-success);
      }
      .sp-diff .del {
        color: var(--grf-error);
      }
      .sp-sec {
        flex: none;
        padding: 9px 12px 7px;
      }
      .sp-sec + .sp-sec {
        border-top: 1px solid var(--grf-border-soft);
      }
      .sp-sec h4 {
        margin: 0 0 6px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        font-weight: 650;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .sp-sec h4 svg {
        width: 12px;
        height: 12px;
        flex: none;
      }
      .sp-sec .sp-cnt {
        color: var(--grf-text-dim);
        font-variant-numeric: tabular-nums;
      }
      /* 缩放按钮顶到区块标题行最右 */
      .sp-sec h4 .sp-fold {
        margin-left: auto;
      }
      .sp-kv {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 3px 12px;
        font-size: var(--grf-font-size-sm);
      }
      .sp-kv .k {
        color: var(--grf-text-faint);
        white-space: nowrap;
      }
      .sp-kv .v {
        color: var(--grf-text);
        text-align: right;
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }
      /* todo 行:圆点着色区分状态(completed=绿 / in_progress=蓝 / 其余空心) */
      .sp-todo {
        display: flex;
        gap: 7px;
        align-items: baseline;
        padding: 2px 0;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
      }
      .sp-todo .sp-dot {
        flex: none;
        width: 7px;
        height: 7px;
        margin-top: 4px;
        border-radius: 50%;
        border: 1.5px solid var(--grf-text-faint);
        box-sizing: border-box;
      }
      .sp-todo.completed .sp-dot {
        background: var(--grf-success);
        border-color: var(--grf-success);
      }
      .sp-todo.completed .tx {
        color: var(--grf-text-faint);
        text-decoration: line-through;
      }
      .sp-todo.in_progress .sp-dot {
        background: var(--grf-accent);
        border-color: var(--grf-accent);
      }
      .sp-todo.in_progress .tx {
        color: var(--grf-text);
      }
    `,
  ];

  render() {
    const s = this.store;
    const todos = s?.runtimes.get(s.activeSessionId ?? '')?.todos ?? null;
    const hasGit = !!this.git;
    const hasTodos = !!todos?.length;
    // 没有任何可显示的内容:整框隐藏
    if (!hasGit && !hasTodos) return nothing;

    // 收缩态:单行显示 git 行级变更或任务完成度(哪个有显示哪个),
    // 整行可点击展开(按钮点击冒泡到同一处理,效果一致)。
    if (this.collapsed || this.narrow) {
      const doneCnt = todos?.filter((t) => t.status === 'completed').length ?? 0;
      return html`
        <div class="status-pop collapsed" title="展开状态浮窗" @click=${() => (this.collapsed = false)}>
          <div class="sp-line">
            ${hasGit
              ? html`<span class="sp-diff">
                  更改 <span class="add">+${this.git!.additions}</span> <span class="del">-${this.git!.deletions}</span>
                </span>`
              : html`<span>任务 ${doneCnt}/${todos!.length} 完成</span>`}
            <button class="sp-fold" title="展开" @click=${() => (this.collapsed = false)}>
              ${unsafeHTML(icon.chevron)}
            </button>
          </div>
        </div>
      `;
    }

    const doneCnt = todos?.filter((t) => t.status === 'completed').length ?? 0;
    // 缩放按钮不单独占行:跟随首个区块(Git 优先,否则任务)的标题行,靠右
    const foldBtn = html`<button class="sp-fold" title="收起为一行" @click=${() => (this.collapsed = true)}>
      ${unsafeHTML(icon.chevron)}
    </button>`;
    return html`
      <div class="status-pop">
        ${hasGit
          ? html`
              <div class="sp-sec">
                <h4>
                  ${unsafeHTML(icon.gitBranch)} Git
                  ${foldBtn}
                </h4>
                <div class="sp-kv">
                  <span class="k">分支</span>
                  <span class="v">${this.git!.branch || '—'}</span>
                  ${this.git!.upstream
                    ? html`<span class="k">远端</span>
                        <span class="v">${this.git!.ahead}↑ ${this.git!.behind}↓</span>`
                    : nothing}
                  <span class="k">变更</span>
                  <span class="v">
                    ${this.git!.entries.length} 个文件
                    <span class="sp-diff">
                      (<span class="add">+${this.git!.additions}</span> <span class="del">-${this.git!.deletions}</span>)
                    </span>
                  </span>
                </div>
              </div>
            `
          : nothing}
        ${hasTodos
          ? html`
              <div class="sp-sec">
                <h4>
                  ${unsafeHTML(icon.check)} 任务
                  <span class="sp-cnt">${doneCnt}/${todos!.length} 完成</span>
                  ${hasGit ? nothing : foldBtn}
                </h4>
                ${todos!.map(
                  (t) => html`
                    <div class="sp-todo ${t.status}">
                      <span class="sp-dot"></span>
                      <span class="tx">${t.content}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-status-pop': GrfStatusPop;
  }
}
