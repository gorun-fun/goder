// status-pop.ts — <grf-status-pop>:聊天列右上角状态浮窗。
// 自动化任务库(置顶,点击任务即在所属操作员下新建执行会话)、当前项目
// git 概览与模型 todo 任务 —— 有内容才显示对应区块,都没有则整框不渲染;
// 默认收起为单行,用户手动展开/收起的状态跨会话持久化(localStorage);
// 非 git 内容(任务列表/目标/自动化任务数)发生变化时自动展开。聊天列
// 过窄时强制单行(narrow 属性)。todos/goal/自动化任务自行订阅 scope
// 数据域;git 状态由宿主(chat 面板)轮询后经属性传入。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import type { GitStatusDTO } from '../../host/bridge';
import type { AutomationTask } from '../../core/store/persistence';

@customElement('grf-status-pop')
export class GrfStatusPop extends GrfPanel {
  /** 当前项目 git 状态(null = 未取到/不适用) */
  @property({ type: Object }) git: GitStatusDTO | null = null;
  /** 聊天列过窄:强制单行,避免盖住对话内容 */
  @property({ type: Boolean }) narrow = false;

  /** 展开态(收起为单行:有任务列表时显示任务完成度,否则 git 行级变更);
   *  默认收起,手动切换持久化,任务/目标变化时自动展开 */
  @state() private open = loadOpen();
  /** 上次观测到的任务/目标快照(会话 id + 内容),用于检测变化触发自动展开 */
  private snap: { sid: string; key: string } | null = null;
  /** 两段式删除确认:已进入待确认态的任务 id */
  @state() private armedTaskDelete?: string;
  private disarmTaskTimer?: number;

  protected willUpdate(): void {
    // 检测非 git 内容(任务列表/目标/自动化任务数)变化:会话切换只重置
    // 基线不触发;同一会话内内容变化则自动展开(不写持久化,下次启动仍以
    // 上次手动选择为准)。
    const s = this.store;
    const sid = s?.activeSessionId ?? '';
    const rt = s?.runtimes.get(sid);
    const key = JSON.stringify({
      goal: rt?.goal ? { phase: rt.goal.phase, objective: rt.goal.objective } : null,
      todos: rt?.todos?.map((t) => [t.status, t.content]) ?? null,
      auto: s?.index.automation?.length ?? 0,
    });
    if (!this.snap || this.snap.sid !== sid) {
      this.snap = { sid, key };
    } else if (this.snap.key !== key) {
      this.snap = { sid, key };
      this.open = true;
    }
  }

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
        margin: 0 0 8px;
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
        gap: 7px 12px;
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
      /* 目标行:阶段着色(working=蓝 / complete=绿 / blocked=红 / paused=灰) */
      .sp-goal {
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text);
        line-height: 1.55;
        overflow-wrap: anywhere;
        padding: 2px 0;
      }
      .sp-goal.complete {
        color: var(--grf-text-faint);
        text-decoration: line-through;
      }
      .sp-goal.blocked {
        color: var(--grf-error);
      }
      .sp-goal.paused {
        color: var(--grf-text-dim);
      }
      /* todo 行:圆点着色区分状态(completed=绿 / in_progress=蓝 / 其余空心) */
      .sp-todo {
        display: flex;
        gap: 7px;
        align-items: baseline;
        padding: 4px 0;
        font-size: var(--grf-font-size-sm);
        line-height: 1.5;
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
      /* 自动化任务行:整行可点执行;运行中转圈、图标着色;悬停时操作员
       * 名隐去、原位露出删除按钮(与会话行同款占位互换) */
      .sp-task {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 6px 5px 2px;
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-sm);
        line-height: 1.4;
      }
      .sp-task:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .sp-task.running {
        color: var(--grf-text);
      }
      .sp-task.dead {
        cursor: default;
        color: var(--grf-text-faint);
      }
      .sp-task .sp-tic {
        flex: none;
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--grf-text-faint);
      }
      .sp-task:hover .sp-tic {
        color: var(--grf-accent-text);
      }
      .sp-task .sp-tic svg {
        width: 13px;
        height: 13px;
      }
      .sp-task .spin {
        width: 12px;
        height: 12px;
        animation: sp-spin 0.9s linear infinite;
      }
      @keyframes sp-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .sp-task .sp-tname {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sp-task .sp-towner,
      .sp-task .sp-tdel {
        min-width: 44px;
        flex: none;
      }
      .sp-task .sp-towner {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        text-align: right;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sp-task .sp-tdel {
        display: none;
        justify-content: center;
        padding: 2px 4px;
        border: none;
        background: transparent;
        color: var(--grf-text-faint);
      }
      .sp-task .sp-tdel svg {
        width: 12px;
        height: 12px;
      }
      .sp-task .sp-tdel:hover {
        color: var(--grf-error);
        background: var(--grf-bg-active);
      }
      .sp-task .sp-tdel.armed {
        color: var(--grf-error);
        font-size: var(--grf-font-size-xs);
        font-weight: 650;
        line-height: 1;
      }
      .sp-task:hover .sp-towner {
        display: none;
      }
      .sp-task:hover .sp-tdel {
        display: inline-flex;
      }
    `,
  ];

  render() {
    const s = this.store;
    const rt = s?.runtimes.get(s.activeSessionId ?? '');
    const todos = rt?.todos ?? null;
    const goal = rt?.goal ?? null;
    const tasks = s?.index.automation ?? [];
    const hasGit = !!this.git;
    const hasTodos = !!todos?.length;
    const hasGoal = !!goal;
    const hasAuto = tasks.length > 0;
    // 没有任何可显示的内容:整框隐藏
    if (!hasGit && !hasTodos && !hasGoal && !hasAuto) return nothing;

    // 收起态:单行显示——优先级:任务完成度 > 目标阶段 > git 行级变更 >
    // 自动化任务数;整行可点击展开(按钮点击冒泡到同一处理)。
    if (!this.open || this.narrow) {
      const doneCnt = todos?.filter((t) => t.status === 'completed').length ?? 0;
      return html`
        <div class="status-pop collapsed" title="展开状态浮窗" @click=${this.expand}>
          <div class="sp-line">
            ${hasTodos
              ? html`<span>任务 ${doneCnt}/${todos!.length} 完成</span>`
              : hasGoal
                ? html`<span>目标 ${goalPhaseText(goal!.phase)}</span>`
                : hasGit
                  ? html`<span class="sp-diff">
                      更改 <span class="add">+${this.git!.additions}</span> <span class="del">-${this.git!.deletions}</span>
                    </span>`
                  : html`<span>自动化任务 ${tasks.length}</span>`}
            <button class="sp-fold" title="展开" @click=${this.expand}>
              ${unsafeHTML(icon.chevron)}
            </button>
          </div>
        </div>
      `;
    }

    const doneCnt = todos?.filter((t) => t.status === 'completed').length ?? 0;
    // 缩放按钮不单独占行:跟随首个区块(自动化优先,否则 Git)的标题行,靠右
    const foldBtn = html`<button class="sp-fold" title="收起为一行" @click=${this.collapse}>
      ${unsafeHTML(icon.chevron)}
    </button>`;
    return html`
      <div class="status-pop">
        ${hasAuto
          ? html`
              <div class="sp-sec">
                <h4>
                  ${unsafeHTML(icon.bot)} 自动化
                  <span class="sp-cnt">${tasks.length}</span>
                  ${foldBtn}
                </h4>
                ${tasks.map((t) => this.renderTaskRow(t))}
              </div>
            `
          : nothing}
        ${hasGit
          ? html`
              <div class="sp-sec">
                <h4>
                  ${unsafeHTML(icon.gitBranch)} Git
                  ${hasAuto ? nothing : foldBtn}
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
        ${hasGoal
          ? html`
              <div class="sp-sec">
                <h4>
                  ${unsafeHTML(icon.target)} 目标
                  <span class="sp-cnt">${goalPhaseText(goal!.phase)}</span>
                  ${hasGit || hasAuto ? nothing : foldBtn}
                </h4>
                <div class="sp-goal ${goal!.phase}">${goal!.objective}</div>
              </div>
            `
          : nothing}
        ${hasTodos
          ? html`
              <div class="sp-sec">
                <h4>
                  ${unsafeHTML(icon.check)} 任务
                  <span class="sp-cnt">${doneCnt}/${todos!.length} 完成</span>
                  ${hasGit || hasGoal || hasAuto ? nothing : foldBtn}
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
  /** 自动化任务行:整行点击 = 执行(在所属操作员下新建执行会话);运行中
   * 显示转圈;悬停露出两段式删除。所属操作员已删除的任务置灰不可执行。 */
  private renderTaskRow(t: AutomationTask) {
    const s = this.store!;
    const running = !!t.lastRunSid && s.isRunning(t.lastRunSid);
    const opName = s.index.projects.find((p) => p.id === t.operatorId)?.name ?? '';
    const dead = !opName;
    const armed = this.armedTaskDelete === t.id;
    return html`
      <div
        class="sp-task ${running ? 'running' : ''} ${dead ? 'dead' : ''}"
        title=${dead
          ? `${t.name}(所属操作员已删除,无法执行)`
          : `${t.name}${opName ? ` · ${opName}` : ''}\n点击执行:${t.instructions.slice(0, 160)}${t.instructions.length > 160 ? '…' : ''}`}
        @click=${() => !dead && s.runAutomationTask(t.id)}
      >
        <span class="sp-tic">
          ${running
            ? html`<svg class="spin" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6" fill="none" stroke="var(--grf-border-hover)" stroke-width="2" />
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  stroke="var(--grf-accent)"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-dasharray="16 38"
                />
              </svg>`
            : unsafeHTML(icon.play)}
        </span>
        <span class="sp-tname">${t.name}</span>
        ${dead
          ? nothing
          : html`<span class="sp-towner">${opName}</span>
              <button
                class="sp-tdel ${armed ? 'armed' : ''}"
                title=${armed ? '再次点击确认删除任务' : '删除任务(不影响已执行过的会话)'}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.onTaskDeleteClick(t.id);
                }}
              >
                ${armed ? '确认' : unsafeHTML(icon.trash)}
              </button>`}
      </div>
    `;
  }

  // onTaskDeleteClick 任务删除的两段式行内确认(与会话/项目删除同模式):
  // 首击进入待确认态(按钮变红色「确认」,3 秒未跟击自动退出),再击删除。
  private onTaskDeleteClick(id: string): void {
    if (this.armedTaskDelete === id) {
      this.disarmTaskDelete();
      this.store?.deleteAutomationTask(id);
      return;
    }
    this.armedTaskDelete = id;
    if (this.disarmTaskTimer) window.clearTimeout(this.disarmTaskTimer);
    this.disarmTaskTimer = window.setTimeout(() => this.disarmTaskDelete(), 3000);
  }

  private disarmTaskDelete(): void {
    if (this.disarmTaskTimer) window.clearTimeout(this.disarmTaskTimer);
    this.disarmTaskTimer = undefined;
    this.armedTaskDelete = undefined;
  }

  disconnectedCallback(): void {
    if (this.disarmTaskTimer) window.clearTimeout(this.disarmTaskTimer);
    this.disarmTaskTimer = undefined;
    super.disconnectedCallback();
  }

  /** 手动展开/收起:状态持久化,下次启动按此恢复 */
  private expand(): void {
    this.open = true;
    saveOpen(true);
  }
  private collapse(): void {
    this.open = false;
    saveOpen(false);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-status-pop': GrfStatusPop;
  }
}

/** 浮窗展开状态的 localStorage 持久化(纯 UI 偏好,不入项目索引) */
const OPEN_KEY = 'grf-ui:status-pop:open';
function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
function saveOpen(v: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  } catch {
    /* 隐私模式等存储不可用时静默 */
  }
}

/** 目标阶段的展示文案 */
function goalPhaseText(phase: string): string {
  switch (phase) {
    case 'complete':
      return '已完成';
    case 'paused':
      return '已暂停';
    case 'blocked':
      return '受阻';
    default:
      return '进行中';
  }
}
