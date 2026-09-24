// session-list.ts — <grf-session-list>:左栏项目级会话列表。
// 桌面态顶部多一个「自动化」类别:操作员分组(kind:'operator' 项目,
// home 下同名目录作工作区,bot 图标),与项目分组同构(可折叠/悬停
// 新建会话/两段式删除);「项目」小节头随之移入滚动区(sticky)。
// 项目分组(可折叠)→ 会话;项目行以文件夹图标开头(折叠/展开切换
// 开/合样式),悬停操作:查看文件(左栏切换为该项目文件列表)/新建会话/
// 删除项目(两段式行内确认,见 onProjectDeleteClick);会话行不缩进,
// 状态点与项目文件夹图标同列居中、标题与项目名左对齐;
// 会话显示距今相对时间,悬停时时间隐去、露出删除(两段式行内确认,见
// onDeleteClick);新建项目走原生目录选择(桌面)或内联输入(web)。底部
// 为身份 chip(grf-user-chip,支持宿主注入)+ 设置入口(进入设置页)。
// 会话行状态指示:运行中 = 旋转小圆环;等待用户查看(回合完成未读/
// 等待输入)= 蓝点;默认空闲不显示。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { repeat } from 'lit/directives/repeat.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { fmtRelative } from '../../util/fmt';
import { UNGROUPED, ungroupedAllowed } from '../../core/store/scope';
import { getNewProject } from '../../registry/registry';
import type { ProjectRecord } from '../../core/store/persistence';
import { inWails, pickFolder } from '../../host/bridge';
import './user-chip';

@customElement('grf-session-list')
export class GrfSessionList extends GrfPanel {
  /** 隐藏底部连接区(嵌入态由宿主全局配置时) */
  @property({ type: Boolean, attribute: 'no-connection' }) noConnection = false;

  /** web 态新建项目的内联输入 */
  @state() private newProject = false;
  @state() private draftName = '';
  /** 桌面态新建操作员的内联输入(操作员名 = 主目录下工作区目录名) */
  @state() private newOperator = false;
  @state() private operatorName = '';
  /** 两段式删除确认:已进入待确认态的会话 id */
  @state() private armedDelete?: string;
  /** 待确认态自动退出计时器 */
  private disarmTimer?: number;
  /** 两段式删除确认:已进入待确认态的项目 id(与会话各自独立) */
  @state() private armedProjectDelete?: string;
  private disarmProjTimer?: number;

  /** 相对时间(刚刚/n分钟…)每分钟自刷新 */
  private minuteTick?: number;

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
      .head {
        flex: none;
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 1px solid var(--grf-border-soft);
        user-select: none;
      }
      .head .t {
        font-weight: 650;
        font-size: var(--grf-font-size);
        flex: 1;
      }
      .list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        padding: 6px 6px 12px;
      }
      /* 滚动区内的「项目」小节头:滚动经过时吸顶(背景遮住下层内容) */
      .sec-head {
        position: sticky;
        top: -6px;
        z-index: 1;
        margin: 4px -6px 2px;
        padding: 7px 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        background: var(--grf-bg-raise);
        border-bottom: 1px solid var(--grf-border-soft);
        user-select: none;
        font-weight: 650;
        font-size: var(--grf-font-size);
      }
      .sec-head .t {
        flex: 1;
      }
      .hint-empty {
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
        padding: 10px 10px;
        line-height: 1.5;
      }
      /* 操作员分组行:bot 图标常显(折叠以透明度区分),悬停着色 */
      .proj-head.op-group .fic {
        color: var(--grf-text-faint);
        opacity: 0.9;
      }
      .proj-head.op-group:not(.open) .fic {
        opacity: 0.55;
      }
      .proj-head.op-group:hover .fic {
        color: var(--grf-accent-text);
        opacity: 1;
      }
      .proj {
        margin-bottom: 2px;
      }
      .proj-head {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 7px 7px;
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        user-select: none;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-xs);
        font-weight: 650;
        letter-spacing: 0.3px;
      }
      .proj-head:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .proj-head .fic {
        width: 14px;
        height: 14px;
        flex: none;
        color: var(--grf-text-faint);
      }
      .proj-head:hover .fic {
        color: var(--grf-accent-text);
      }
      .proj-head .name {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .proj-head .op {
        opacity: 0;
        display: flex;
        gap: 2px;
      }
      .proj-head:hover .op {
        opacity: 1;
      }
      .op button {
        padding: 2px 4px;
        border: none;
        background: transparent;
        color: var(--grf-text-faint);
      }
      .op button:hover {
        color: var(--grf-text);
        background: var(--grf-bg-active);
      }
      /* 项目删除待确认态:垃圾桶换为红色「确认」文字(与会话删除同语义) */
      .op button.armed {
        color: var(--grf-error);
        font-size: var(--grf-font-size-xs);
        font-weight: 650;
        line-height: 1;
      }
      .op button.armed:hover {
        color: var(--grf-error);
      }
      .op svg {
        width: 12px;
        height: 12px;
      }
      /* 会话与项目同行对齐:状态点位于项目文件夹图标的 14px 图标槽内,
       * 标题起点与项目名一致(左 7px 内边距 + 14px 槽 + 5px 间距) */
      .sessions {
        margin: 2px 0 6px;
      }
      .sess {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 7px 7px;
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-sm);
        min-width: 0;
      }
      .sess:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .sess.active {
        background: var(--grf-accent-soft);
        color: var(--grf-text);
      }
      .sess .t {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* 图标槽:与项目行 .fic 同宽,状态指示居中其中 */
      .sess .ic {
        width: 14px;
        height: 14px;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      /* 蓝点 = 等待用户查看(回合完成未读 / 等待输入);默认不显示 */
      .sess .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--grf-accent);
        flex: none;
      }
      /* 运行中:旋转小圆环(SVG 弧线,border 画弧在小尺寸下弧长随角度抖动,
       * 看起来像"转到一半重新开始") */
      .sess .spin {
        width: 10px;
        height: 10px;
        flex: none;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .sess .at {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      /* 悬停:时间隐去,原位露出删除按钮(占位互换,不跳动) */
      .sess .at,
      .sess .del {
        min-width: 34px;
      }
      .sess .at {
        text-align: right;
      }
      .sess .del {
        display: none;
        flex: none;
        justify-content: center;
        padding: 2px 4px;
        border: none;
        background: transparent;
        color: var(--grf-text-faint);
      }
      .sess .del svg {
        width: 12px;
        height: 12px;
      }
      .sess .del:hover {
        color: var(--grf-error);
        background: var(--grf-bg-active);
      }
      /* 待确认态:垃圾桶换为红色「确认」文字,再次点击才真正删除 */
      .sess .del.armed {
        color: var(--grf-error);
        font-size: var(--grf-font-size-xs);
        font-weight: 650;
        line-height: 1;
      }
      .sess .del.armed:hover {
        background: var(--grf-bg-active);
      }
      .sess:hover .at {
        display: none;
      }
      .sess:hover .del {
        display: inline-flex;
      }
      .edit-in {
        font-size: var(--grf-font-size-sm);
        padding: 3px 6px;
      }
      .footbar {
        flex: none;
        border-top: 1px solid var(--grf-border-soft);
        padding: 8px 12px;
        display: flex;
        align-items: center;
        gap: 8px;
        user-select: none;
      }
      .footbar .gear {
        flex: none;
        padding: 3px 5px;
        border: none;
        background: transparent;
        color: var(--grf-text-faint);
        cursor: pointer;
        border-radius: 5px;
        display: inline-flex;
      }
      .footbar .gear:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
      }
      .footbar .gear svg {
        width: 14px;
        height: 14px;
      }
      .newproj-form {
        display: flex;
        gap: 5px;
        padding: 4px 6px;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.minuteTick = window.setInterval(() => this.requestUpdate(), 60_000);
  }

  disconnectedCallback(): void {
    if (this.minuteTick) window.clearInterval(this.minuteTick);
    this.minuteTick = undefined;
    if (this.disarmTimer) window.clearTimeout(this.disarmTimer);
    this.disarmTimer = undefined;
    if (this.disarmProjTimer) window.clearTimeout(this.disarmProjTimer);
    this.disarmProjTimer = undefined;
    super.disconnectedCallback();
  }

  render() {
    const s = this.store;
    const desktop = inWails();
    const operators = desktop ? s.operatorGroups() : [];
    const projects = [...s.index.projects]
      .filter((p) => p.kind !== 'operator')
      // 嵌入方禁未分组(configure ungroupedSessions:false):「未分组会话」
      // 分组不再渲染(索引伪项目保留,兜底逻辑仍以 UNGROUPED 兜底)。
      .filter((p) => p.id !== UNGROUPED || ungroupedAllowed(s.name))
      .sort((a, b) => (a.id === UNGROUPED ? 1 : b.id === UNGROUPED ? -1 : a.createdAt < b.createdAt ? 1 : -1));
    return html`
      ${desktop
        ? html`
            <div class="head">
              <span class="t">自动化</span>
              <button class="ghost" title="添加操作员(在主目录创建同名工作区)" @click=${this.startNewOperator}>
                ${unsafeHTML(icon.plus)}
              </button>
            </div>
          `
        : nothing}
      <div class="list">
        ${desktop ? this.renderOperators(operators) : nothing}
        <div class="sec-head">
          <span class="t">项目</span>
          <button class="ghost" title="新建项目" @click=${this.startNewProject}>${unsafeHTML(icon.plus)}</button>
          <button class="ghost" title="刷新列表" @click=${() => void s.refreshConversations()}>
            ${unsafeHTML(icon.refresh)}
          </button>
        </div>
        ${this.newProject
          ? html`
              <div class="proj">
                <div class="newproj-form">
                  <input
                    class="edit-in newproj-in"
                    type="text"
                    .value=${this.draftName}
                    placeholder="项目名"
                    @input=${(e: InputEvent) => (this.draftName = (e.target as HTMLInputElement).value)}
                    @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.commitNewProject()}
                    @blur=${this.commitNewProject}
                  />
                </div>
              </div>
            `
          : nothing}
        ${projects.map((p) => this.renderProject(p.id, p.name, !!p.collapsed, p.path))}
        ${projects.length === 0 && !this.newProject
          ? html`<div class="hint-empty">还没有项目。点击「项目」右侧 + 新建。</div>`
          : nothing}
      </div>
      ${this.noConnection
        ? nothing
        : html`
            <div class="footbar">
              <grf-user-chip scope=${this.scope}></grf-user-chip>
              <button class="gear" title="设置" @click=${() => this.fire('grf-open-settings')}>${unsafeHTML(icon.settings)}</button>
            </div>
          `}
    `;
  }

  /** 「自动化」类别:操作员内联输入 + 操作员分组(与项目分组同构)。 */
  private renderOperators(operators: ProjectRecord[]) {
    return html`
      ${this.newOperator
        ? html`
            <div class="proj">
              <div class="newproj-form">
                <input
                  class="edit-in newproj-in"
                  type="text"
                  .value=${this.operatorName}
                  placeholder="操作员名(主目录下同名文件夹)"
                  @input=${(e: InputEvent) => (this.operatorName = (e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.commitNewOperator()}
                  @blur=${this.commitNewOperator}
                />
              </div>
            </div>
          `
        : nothing}
      ${operators.map((p) => this.renderProject(p.id, p.name, !!p.collapsed, p.path, true))}
      ${operators.length === 0 && !this.newOperator
        ? html`<div class="hint-empty">还没有操作员。点击上方 + 添加,以会话形式协作调试电脑操作。</div>`
        : nothing}
    `;
  }

  private renderProject(pid: string, name: string, collapsed: boolean, path?: string, operator = false) {
    const s = this.store;
    const sessions = Object.entries(s.index.sessions)
      .filter(([, rec]) => rec.projectId === pid)
      .sort((a, b) => (a[1].updatedAt ?? a[1].createdAt) < (b[1].updatedAt ?? b[1].createdAt) ? 1 : -1);
    const activeProj = s.activeProjectId === pid;
    const tip = path ? `${name}\n${path}` : name;

    return html`
      <div class="proj">
        <div
          class="proj-head ${collapsed ? '' : 'open'} ${operator ? 'op-group' : ''}"
          style=${activeProj ? 'color:var(--grf-text)' : ''}
          title=${tip}
          @click=${() => s.toggleProjectCollapsed(pid)}
        >
          <span class="fic"
            >${operator
              ? unsafeHTML(icon.bot)
              : unsafeHTML(collapsed ? icon.folder : icon.folderOpen)}</span
          >
          <span class="name">${name}</span>
          <span class="op" @click=${(e: Event) => e.stopPropagation()}>
            ${path && inWails()
              ? html`<button
                  title="查看文件:${path}"
                  @click=${() => this.fire('grf-open-files', { projectId: pid, name, path })}
                >
                  ${unsafeHTML(icon.folder)}
                </button>`
              : nothing}
            ${pid !== UNGROUPED
              ? html`<button title="新建会话" @click=${() => void s.newDraft(pid)}>
                    ${unsafeHTML(icon.plus)}
                  </button>
                  <button
                    class=${this.armedProjectDelete === pid ? 'armed' : ''}
                    title=${this.armedProjectDelete === pid
                      ? operator
                        ? '再次点击确认:删除操作员及其全部会话'
                        : '再次点击确认:删除项目及其全部会话'
                      : operator
                        ? '删除操作员(连同其全部会话归档;主目录工作区保留)'
                        : '删除项目(连同其全部会话归档)'}
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      this.onProjectDeleteClick(pid);
                    }}
                  >
                    ${this.armedProjectDelete === pid ? '确认' : unsafeHTML(icon.trash)}
                  </button>`
              : nothing}
          </span>
        </div>
        ${collapsed
          ? nothing
          : html`
              <div class="sessions">
                ${pid === s.activeProjectId && s.activeSessionId?.startsWith('draft:')
                  ? this.renderSession(s.activeSessionId, '新会话(未发送)', '')
                  : nothing}
                ${repeat(
                  sessions,
                  ([sid]) => sid,
                  ([sid, rec]) => this.renderSession(sid, rec.title, rec.updatedAt ?? rec.createdAt),
                )}
              </div>
            `}
      </div>
    `;
  }

  private renderSession(sid: string, title: string, at: string) {
    const s = this.store;
    const active = s.activeSessionId === sid;
    const running = s.isRunning(sid);
    const unread = !running && s.needsAttention(sid);
    const armed = this.armedDelete === sid;

    return html`
      <div
        class="sess ${active ? 'active' : ''}"
        @click=${() => s.selectSession(sid)}
        title=${title}
      >
        <span class="ic">
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
            : unread
              ? html`<span class="dot"></span>`
              : nothing}
        </span>
        <span class="t">${title}</span>
        ${sid.startsWith('draft:')
          ? nothing
          : html`<span class="at">${fmtRelative(at)}</span>
              <button
                class="del ${armed ? 'armed' : ''}"
                title=${armed ? '再次点击确认删除' : '删除会话(从列表移除,历史保留)'}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.onDeleteClick(sid);
                }}
              >
                ${armed ? '确认' : unsafeHTML(icon.trash)}
              </button>`}
      </div>
    `;
  }

  // onDeleteClick 两段式行内确认:首击进入待确认态(按钮变红色「确认」,
  // 3 秒未跟击自动退出),再击才真正归档。不用 window.confirm——wails 桌面
  // 的 WKWebView 未实现 JS 弹窗宿主委托,confirm() 恒为 false,删除会静默失效。
  private onDeleteClick(sid: string): void {
    if (this.armedDelete === sid) {
      this.disarmDelete();
      void this.store.archiveSession(sid);
      return;
    }
    this.armedDelete = sid;
    if (this.disarmTimer) window.clearTimeout(this.disarmTimer);
    this.disarmTimer = window.setTimeout(() => this.disarmDelete(), 3000);
  }

  private disarmDelete(): void {
    if (this.disarmTimer) window.clearTimeout(this.disarmTimer);
    this.disarmTimer = undefined;
    this.armedDelete = undefined;
  }

  // onProjectDeleteClick 项目删除的两段式行内确认(与会话删除同模式):
  // 删除会连带归档该项目全部会话,误触代价更高,故按钮 title 点名后果;
  // 首击只进入待确认态,再击才真正执行。同屏同时只保留一个待确认态。
  private onProjectDeleteClick(pid: string): void {
    if (this.armedProjectDelete === pid) {
      this.disarmProjectDelete();
      this.store.deleteProject(pid, true);
      return;
    }
    this.disarmDelete();
    this.disarmProjectDelete();
    this.armedProjectDelete = pid;
    this.disarmProjTimer = window.setTimeout(() => this.disarmProjectDelete(), 3000);
  }

  private disarmProjectDelete(): void {
    if (this.disarmProjTimer) window.clearTimeout(this.disarmProjTimer);
    this.disarmProjTimer = undefined;
    this.armedProjectDelete = undefined;
  }

  private startNewProject(): void {
    // 桌面态:原生目录选择器,项目名取目录 basename;web 态:内联输入名称。
    if (inWails()) {
      void pickFolder().then((dir) => {
        if (!dir) return; // 取消
        const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;
        this.store.createProject(name, dir);
      });
      return;
    }
    this.newProject = true;
    this.draftName = '';
    this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector('.newproj-form input, .edit-in') as HTMLInputElement | null;
      el?.focus();
    });
  }

  private commitNewProject(): void {
    if (!this.newProject) return;
    const name = this.draftName.trim();
    this.newProject = false;
    this.draftName = '';
    if (!name) {
      this.requestUpdate();
      return;
    }
    // 宿主 newProject 钩子优先(embed.configure 的 newProject 落点):
    // 嵌入方创建自己的项目实体后返回根目录路径,goder 据此登记带 path
    // 的项目;返回 null = 嵌入方已处理/拒绝,不落原生项目。异步期间输入
    // 态先收起,结果回来再登记(store.createProject 自带 notify 刷新)。
    const hook = this.store ? getNewProject(this.store.name) : undefined;
    if (hook) {
      void Promise.resolve(hook(name)).then((path) => {
        if (path) this.store.createProject(name, path);
      });
      this.requestUpdate();
      return;
    }
    this.store.createProject(name);
    this.requestUpdate();
  }

  // 新建操作员:内联输入名字(= 主目录下工作区目录名),回车/失焦提交。
  // createOperator 在 scope 侧建目录 + 落项目 + 开首个会话;失败(名字
  // 非法/非桌面态)只 log 提示,这里不留输入态。
  private startNewOperator(): void {
    this.newOperator = true;
    this.operatorName = '';
    this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector('.newproj-form input, .edit-in') as HTMLInputElement | null;
      el?.focus();
    });
  }

  private commitNewOperator(): void {
    if (!this.newOperator) return;
    const name = this.operatorName.trim();
    this.newOperator = false;
    this.operatorName = '';
    if (name) void this.store.createOperator(name);
    this.requestUpdate();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-session-list': GrfSessionList;
  }
}
