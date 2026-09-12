// app-shell.ts — <grf-app-shell>:ZCode 风格桌面布局。
// 视觉上仅两块:左导航栏 + 主体工作面板(黑色圆角大卡,右边栏(tab 化:
// 详情/审查/终端/浏览器)与底部内嵌终端均内嵌其中,默认聊天占满)。
// 工作卡拉通到窗口顶部:无独立标题
// 栏,标题栏角色由"左栏顶行(展开时)/ 工作卡头部左上角(收起时)"承担
// —— macOS 红绿灯悬浮其左,其后紧跟常驻左边栏开关(任一时刻只出现
// 一个),余为窗口拖拽区。左栏收起 = 整块移除,工作卡拉通整个窗体。
// 两个视图,均遵守"左导航 + 右工作"结构:工作视图(项目/会话导航 +
// 聊天卡)与设置视图(设置分区导航 + 设置卡),经 grf-open-settings
// 进入、grf-close-settings 返回。
// panels 属性选择装配哪些部分 —— 与"裸 grf-harness 可配置开启哪些工具"对齐的
// UI 面配置;桌面 app 全开,嵌入宿主按需裁剪。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, panelRegistered } from '../ui/base';
import { icon } from '../util/icons';
import { inWails } from '../host/bridge';
import { makeTitleDrag, type TitleDrag } from '../util/titledrag';
import '../panels/session-list';
import '../panels/file-list';
import '../panels/settings-nav';
import '../panels/settings-page';
import '../panels/chat/chat-panel';
import type { SettingsSection } from '../panels/settings-nav';
import type { SidePanelTab } from '../panels/chat/chat-panel';

/**
 * 装配哪些部分。console 键现为底栏(内嵌终端,桌面态专属);嵌入态终端
 * 面板未注册时底栏自动隐藏(事件台已从应用布局移除,grf-console 仅作
 * 独立嵌入面板保留)。
 */
export type PanelName = 'sessions' | 'chat' | 'sidebar' | 'console';

@customElement('grf-app-shell')
export class GrfAppShell extends GrfPanel {
  /** 启用哪些面板,逗号分隔:sessions,chat,sidebar,console(默认全开) */
  @property({ type: String }) panels = 'sessions,chat,sidebar,console';
  /** 初始展开状态覆写,如 "sidebar=false,console=false" */
  @property({ type: String }) layout = '';

  @state() private leftWidth = 248;
  /** 右栏(详情/审查等)默认收起:打开应用仅展开左边栏 */
  @state() private showSidebar = false;
  /** 底栏(内嵌终端)展开态 */
  @state() private showBottom = false;
  @state() private showSessions = true;
  /** 左栏文件列表视图(session-list「查看文件」进入;null = 会话列表) */
  @state() private filesView: { projectId: string; name: string; path: string } | null = null;
  /** 右栏已打开的文件(每个文件一个 file:<path> tab) */
  @state() private fileTabs: { path: string; name: string; rel: string }[] = [];
  /** 右栏已打开的 tab(空 = 右栏显示类型入口页) */
  @state() private sideTabs: SidePanelTab[] = [];
  /** 右栏当前激活的 tab */
  @state() private activeSideTab: SidePanelTab = 'detail';
  /** 当前视图:工作(默认) / 设置 */
  @state() private view: 'work' | 'settings' = 'work';
  /** 设置视图当前分区(左栏导航联动) */
  @state() private settingsSection: SettingsSection = 'general';

  /** macOS 桌面态:左栏顶行左侧为红绿灯(关/最小/最大化)预留悬浮位,
   * 最大化按钮之后仅放左边栏开关。 */
  private readonly nativeLights =
    inWails() && /mac/i.test(navigator.platform || navigator.userAgent);

  /** 左栏顶行即窗口标题栏:空白区拖拽移动 / 双击缩放(非桌面态静默) */
  private tdrag: TitleDrag | null = null;

  private dragging: 'left' | null = null;

  static styles = [
    theme,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        background: var(--grf-bg);
        color: var(--grf-text);
        font-family: var(--grf-font);
        overflow: hidden;
        position: relative;
      }
      .main {
        flex: 1;
        display: flex;
        min-height: 0;
        min-width: 0;
        /* 左栏拖拽条的定位基准 */
        position: relative;
      }
      .left {
        flex: none;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .left grf-session-list,
      .left grf-settings-nav {
        flex: 1;
        min-height: 0;
      }
      /* 左栏顶行 = 标题栏(展开时):红绿灯(仅 macOS)后紧跟左边栏
       * 开关,余为拖拽区;收起后该角色移交工作卡头部左上角 */
      .side-top {
        flex: none;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 8px 12px;
        box-sizing: border-box;
        user-select: none;
        background: var(--grf-bg-raise);
        border-bottom: 1px solid var(--grf-border-soft);
      }
      .side-top.lights {
        padding-left: 80px;
      }
      .side-top .toggler {
        display: flex;
      }
      .side-top .toggler button {
        background: transparent;
        border: none;
        color: var(--grf-text-faint);
        padding: 3px 7px;
        cursor: pointer;
        border-radius: 5px;
        display: inline-flex;
        align-items: center;
      }
      .side-top .toggler button:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .side-top .toggler button.on {
        color: var(--grf-accent-text);
        background: var(--grf-accent-soft);
      }
      .side-top .toggler svg {
        width: 13px;
        height: 13px;
      }
      /* 左栏拖拽条:绝对定位悬浮在左栏右边界上(左右各压 4px),不占布局
       * 空间 —— 左栏与工作卡完全贴合无边距;默认隐形,悬停亮出强调色 */
      .gutter-v {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 8px;
        margin-left: -4px;
        z-index: 20;
        cursor: col-resize;
      }
      .gutter-v::after {
        content: '';
        position: absolute;
        inset: 0 3.5px;
        background: transparent;
      }
      .gutter-v:hover::after {
        background: var(--grf-accent);
      }
      /* 主体工作面板:左侧贴住左栏(无边距),右侧 5px 边距衬托黑色圆角
       * 卡片;顶部贴住窗口上沿、底部拉通到窗口底 —— 卡片头部与左栏顶行
       * 同为 40px 高,两行底部分隔线对齐,左栏收起/展开时标题行位置与
       * 高度均不跳动 */
      .center {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        padding: 0 5px 0 0;
        box-sizing: border-box;
      }
      .center grf-chat,
      .center grf-settings-page {
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      .hidden {
        display: none !important;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.parseLayout();
    this.tdrag = makeTitleDrag('button');
    // 设置视图切换(session-list 齿轮进入 / 设置导航返回 / 切换分区)
    this.addEventListener('grf-open-settings', this.onOpenSettings);
    this.addEventListener('grf-close-settings', () => (this.view = 'work'));
    // 左栏文件列表视图(session-list「查看文件」进入 / file-list 返回退出)
    this.addEventListener('grf-open-files', (e: Event) => {
      this.filesView = (e as CustomEvent).detail;
      this.view = 'work';
    });
    this.addEventListener('grf-close-files', () => (this.filesView = null));
    // 左栏文件树点文件:右栏为该文件开一个独立 tab 预览(已开则激活);
    // 右栏未开时自动展开
    this.addEventListener('grf-open-file', (e: Event) => {
      const f = (e as CustomEvent).detail as { path: string; name: string; rel?: string };
      const tab: SidePanelTab = `file:${f.path}`;
      if (!this.sideTabs.includes(tab)) this.sideTabs = [...this.sideTabs, tab];
      if (!this.fileTabs.some((x) => x.path === f.path)) {
        this.fileTabs = [...this.fileTabs, { path: f.path, name: f.name, rel: f.rel ?? f.name }];
      }
      this.activeSideTab = tab;
      this.showSidebar = true;
    });
    this.addEventListener('grf-settings-section', (e: Event) => {
      this.settingsSection = (e as CustomEvent<SettingsSection>).detail;
    });
    window.addEventListener('pointermove', this.onDrag);
    window.addEventListener('pointerup', this.stopDrag);
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    this.removeEventListener('grf-open-settings', this.onOpenSettings);
    window.removeEventListener('pointermove', this.onDrag);
    window.removeEventListener('pointerup', this.stopDrag);
    super.disconnectedCallback();
  }

  private onOpenSettings = (): void => {
    this.view = 'settings';
  };

  private parseLayout(): void {
    if (!this.layout) return;
    for (const kv of this.layout.split(',')) {
      const [k, v] = kv.split('=').map((x) => x?.trim());
      if (k === 'sidebar') this.showSidebar = v !== 'false';
      if (k === 'console' || k === 'bottom') this.showBottom = v !== 'false';
      if (k === 'sessions') this.showSessions = v !== 'false';
      if (k === 'leftWidth') this.leftWidth = Number(v) || this.leftWidth;
    }
  }

  private panelOn(name: PanelName): boolean {
    return this.panels.split(',').map((p) => p.trim()).includes(name);
  }

  private onGutterStart(): void {
    this.dragging = 'left';
  }

  private onDrag = (e: PointerEvent): void => {
    if (this.dragging !== 'left') return;
    const rect = this.getBoundingClientRect();
    this.leftWidth = Math.min(Math.max(e.clientX - rect.left, 170), rect.width * 0.45);
  };

  private stopDrag = (): void => {
    this.dragging = null;
  };

  // ---------- 右栏 tab 状态(chat-panel 经事件上抛,这里受控维护) ----------

  private openSideTab(tab: SidePanelTab): void {
    if (!this.sideTabs.includes(tab)) this.sideTabs = [...this.sideTabs, tab];
    this.activeSideTab = tab;
  }

  private closeSideTab(tab: SidePanelTab): void {
    const next = this.sideTabs.filter((t) => t !== tab);
    this.sideTabs = next;
    // 文件 tab 关闭:同步移除已打开文件记录
    if (tab.startsWith('file:')) {
      const p = tab.slice(5);
      this.fileTabs = this.fileTabs.filter((f) => f.path !== p);
    }
    if (this.activeSideTab === tab) {
      this.activeSideTab = next[next.length - 1] ?? 'detail';
    }
  }

  render() {
    const hasSessions = this.panelOn('sessions');
    const hasChat = this.panelOn('chat');
    const hasSidebar = this.panelOn('sidebar');
    const hasConsole = this.panelOn('console');

    return html`
      <div class="main">
        ${hasSessions && this.showSessions
          ? html`
              <div class="left" style="width:${this.leftWidth}px">
                <div
                  class="side-top ${this.nativeLights ? 'lights' : ''}"
                  @mousedown=${(e: MouseEvent) => this.tdrag?.onDown(e)}
                  @dblclick=${(e: MouseEvent) => this.tdrag?.onDbl(e)}
                >
                  <span class="toggler">
                    <button class="on" title="收起会话列表" @click=${() => (this.showSessions = false)}>${unsafeHTML(icon.panelLeft)}</button>
                  </span>
                </div>
                ${this.view === 'settings'
                  ? html`<grf-settings-nav scope=${this.scope} section=${this.settingsSection}></grf-settings-nav>`
                  : this.filesView
                    ? html`<grf-file-list
                        scope=${this.scope}
                        root=${this.filesView.path}
                        projName=${this.filesView.name}
                      ></grf-file-list>`
                    : html`<grf-session-list scope=${this.scope} server=${this.serverAttr ?? nothing} token=${this.tokenAttr ?? nothing}></grf-session-list>`}
              </div>
              <div class="gutter-v" style="left:${this.leftWidth}px" @pointerdown=${this.onGutterStart}></div>
            `
          : nothing}
        <div class="center">
          ${this.view === 'settings'
            ? html`<grf-settings-page
                scope=${this.scope}
                section=${this.settingsSection}
                .leftToggle=${hasSessions}
                .leftOn=${this.showSessions}
                .leftLights=${this.nativeLights}
                @grf-toggle-sessions=${() => (this.showSessions = !this.showSessions)}
              ></grf-settings-page>`
            : hasChat
              ? html`<grf-chat
                  scope=${this.scope}
                  server=${this.serverAttr ?? nothing}
                  token=${this.tokenAttr ?? nothing}
                  .bottomToggle=${hasConsole && inWails() && panelRegistered('grf-terminal')}
                  .sidebarToggle=${hasSidebar}
                  .bottomOn=${this.showBottom}
                  .sidebarOn=${this.showSidebar}
                  .sideTabs=${this.sideTabs}
                  .activeSideTab=${this.activeSideTab}
                  .fileTabs=${this.fileTabs}
                  .leftToggle=${hasSessions}
                  .leftOn=${this.showSessions}
                  .leftLights=${this.nativeLights}
                  @grf-toggle-terminal=${() => (this.showBottom = !this.showBottom)}
                  @grf-toggle-sidebar=${() => (this.showSidebar = !this.showSidebar)}
                  @grf-toggle-sessions=${() => (this.showSessions = !this.showSessions)}
                  @grf-side-tab-open=${(e: Event) => this.openSideTab((e as CustomEvent<SidePanelTab>).detail)}
                  @grf-side-tab-close=${(e: Event) => this.closeSideTab((e as CustomEvent<SidePanelTab>).detail)}
                  @grf-side-tab-activate=${(e: Event) => (this.activeSideTab = (e as CustomEvent<SidePanelTab>).detail)}
                ></grf-chat>`
              : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-app-shell': GrfAppShell;
  }
}
