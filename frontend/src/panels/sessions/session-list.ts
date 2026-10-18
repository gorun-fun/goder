// session-list.ts — <goder-session-list>:左栏项目级会话列表。
// 桌面态顶部多一个「自动化」类别:操作员分组(kind:'operator' 项目,
// home 下同名目录作工作区,bot 图标),与项目分组同构(可折叠/悬停
// 新建会话/两段式删除);「项目」小节头随之移入滚动区(sticky)。
// 项目分组(可折叠)→ 会话;项目行以文件夹图标开头(折叠/展开切换
// 开/合样式),悬停操作:查看文件(左栏切换为该项目文件列表)/新建会话/
// 删除项目(两段式行内确认,见 onProjectDeleteClick);会话行不缩进,
// 状态点与项目文件夹图标同列居中、标题与项目名左对齐;
// 会话显示距今相对时间,悬停时时间隐去、露出删除(两段式行内确认,见
// onDeleteClick);新建项目走原生目录选择(桌面)或内联输入(web)。底部
// 为身份 chip(goder-user-chip,支持宿主注入)+ 设置入口(进入设置页)。
// 会话行状态指示:运行中 = 旋转小圆环;等待用户查看(回合完成未读/
// 等待输入)= 蓝点;默认空闲不显示。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { repeat } from 'lit/directives/repeat.js';
import { GoderPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { fmtRelative } from '../../util/fmt';
import { useArmedConfirm, armedBtnCss } from '../../util/armed';
import { renderSpinner, spinnerCss } from '../../util/spinner';
import { UNGROUPED, ungroupedAllowed } from '../../core/store/scope';
import { getNewProject } from '../../registry/registry';
import type { ProjectRecord } from '../../core/store/persistence';
import { inWails, pickFolder } from '../../host/bridge';
import './user-chip';

@customElement('goder-session-list')
export class GoderSessionList extends GoderPanel {
  /** 隐藏底部连接区(嵌入态由宿主全局配置时) */
  @property({ type: Boolean, attribute: 'no-connection' }) noConnection = false;

  /** web 态新建项目的内联输入 */
  @state() private newProject = false;
  @state() private draftName = '';
  /** 桌面态新建操作员的内联输入(操作员名 = 主目录下工作区目录名) */
  @state() private newOperator = false;
  @state() private operatorName = '';
  /** 两段式删除确认(会话 `sess:`/项目 `proj:` 两类 key 共用一个
   * controller,同屏只保留一个待确认态;3s 自动退出与断开清理见
   * util/armed) */
  private armed = useArmedConfirm(this);

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
        background: var(--goder-bg-raise);
        font-family: var(--goder-font);
        font-size: var(--goder-font-size);
        color: var(--goder-text);
      }
      .head {
        flex: none;
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 1px solid var(--goder-border-soft);
        user-select: none;
      }
      .head .t {
        font-weight: 650;
        font-size: var(--goder-font-size);
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
        background: var(--goder-bg-raise);
        border-bottom: 1px solid var(--goder-border-soft);
        user-select: none;
        font-weight: 650;
        font-size: var(--goder-font-size);
      }
      .sec-head .t {
        flex: 1;
      }
      .hint-empty {
        color: var(--goder-text-faint);
        font-size: var(--goder-font-size-xs);
        padding: 10px 10px;
        line-height: 1.5;
      }
      /* 操作员分组行:bot 图标常显(折叠以透明度区分),悬停着色 */
      .proj-head.op-group .fic {
        color: var(--goder-text-faint);
        opacity: 0.9;
      }
      .proj-head.op-group:not(.open) .fic {
        opacity: 0.55;
      }
      .proj-head.op-group:hover .fic {
        color: var(--goder-accent-text);
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
        border-radius: var(--goder-radius-sm);
        cursor: pointer;
        user-select: none;
        color: var(--goder-text-dim);
        font-size: var(--goder-font-size-xs);
        font-weight: 650;
        letter-spacing: 0.3px;
      }
      .proj-head:hover {
        background: var(--goder-bg-hover);
        color: var(--goder-text);
      }
      .proj-head .fic {
        width: 14px;
        height: 14px;
        flex: none;
        color: var(--goder-text-faint);
      }
      .proj-head:hover .fic {
        color: var(--goder-accent-text);
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
        color: var(--goder-text-faint);
      }
      .op button:hover {
        color: var(--goder-text);
        background: var(--goder-bg-active);
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
        border-radius: var(--goder-radius-sm);
        cursor: pointer;
        color: var(--goder-text-dim);
        font-size: var(--goder-font-size-sm);
        min-width: 0;
      }
      .sess:hover {
        background: var(--goder-bg-hover);
        color: var(--goder-text);
      }
      .sess.active {
        background: var(--goder-accent-soft);
        color: var(--goder-text);
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
        background: var(--goder-accent);
        flex: none;
      }
      /* 运行中:旋转小圆环(util/spinner 共用件;动画在 spinnerCss,
       * 此处只定尺寸;不用 border 画弧的原因见该文件头注释) */
      .sess .goder-spin {
        width: 10px;
        height: 10px;
        flex: none;
      }
      .sess .at {
        flex: none;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
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
        color: var(--goder-text-faint);
      }
      .sess .del svg {
        width: 12px;
        height: 12px;
      }
      .sess .del:hover {
        color: var(--goder-error);
        background: var(--goder-bg-active);
      }
      .sess:hover .at {
        display: none;
      }
      .sess:hover .del {
        display: inline-flex;
      }
      .edit-in {
        font-size: var(--goder-font-size-sm);
        padding: 3px 6px;
      }
      .footbar {
        flex: none;
        border-top: 1px solid var(--goder-border-soft);
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
        color: var(--goder-text-faint);
        cursor: pointer;
        border-radius: 5px;
        display: inline-flex;
      }
      .footbar .gear:hover {
        color: var(--goder-text);
        background: var(--goder-bg-hover);
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
    /* 两段式删除待确认态(垃圾桶换红色「确认」文字);放数组末尾以
     * 压过上方两类名基态规则,详见 util/armed 的 armedBtnCss 注释 */
    armedBtnCss,
    spinnerCss,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.minuteTick = window.setInterval(() => this.requestUpdate(), 60_000);
  }

  disconnectedCallback(): void {
    if (this.minuteTick) window.clearInterval(this.minuteTick);
    this.minuteTick = undefined;
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
              <goder-user-chip scope=${this.scope}></goder-user-chip>
              <button class="gear" title="设置" @click=${() => this.fire('goder-open-settings')}>${unsafeHTML(icon.settings)}</button>
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
          style=${activeProj ? 'color:var(--goder-text)' : ''}
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
                  @click=${() => this.fire('goder-open-files', { projectId: pid, name, path })}
                >
                  ${unsafeHTML(icon.folder)}
                </button>`
              : nothing}
            ${pid !== UNGROUPED
              ? html`<button title="新建会话" @click=${() => void s.newDraft(pid)}>
                    ${unsafeHTML(icon.plus)}
                  </button>
                  <button
                    class=${this.armed.isArmed(`proj:${pid}`) ? 'armed' : ''}
                    title=${this.armed.isArmed(`proj:${pid}`)
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
                    ${this.armed.isArmed(`proj:${pid}`) ? '确认' : unsafeHTML(icon.trash)}
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
    const armed = this.armed.isArmed(`sess:${sid}`);

    return html`
      <div
        class="sess ${active ? 'active' : ''}"
        @click=${() => s.selectSession(sid)}
        title=${title}
      >
        <span class="ic">
          ${running ? renderSpinner() : unread ? html`<span class="dot"></span>` : nothing}
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

  // onDeleteClick 会话删除的两段式行内确认(controller 语义与
  // window.confirm 不可用的原因见 util/armed 头注释):首击进入待确认态
  // (按钮变红色「确认」,3 秒未跟击自动退出),再击才真正归档。
  private onDeleteClick(sid: string): void {
    if (this.armed.click(`sess:${sid}`)) void this.store.archiveSession(sid);
  }

  // onProjectDeleteClick 项目删除的两段式行内确认(与会话删除同模式):
  // 删除会连带归档该项目全部会话,误触代价更高,故按钮 title 点名后果;
  // 首击只进入待确认态,再击才真正执行。同屏同时只保留一个待确认态
  // (controller 布防新 key 自动解除旧 key,含会话删除的布防)。
  private onProjectDeleteClick(pid: string): void {
    if (this.armed.click(`proj:${pid}`)) this.store.deleteProject(pid, true);
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
    'goder-session-list': GoderSessionList;
  }
}
