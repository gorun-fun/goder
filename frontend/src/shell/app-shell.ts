// app-shell.ts — <grf-app-shell>:ZCode 风格桌面布局(左导航 + 黑色圆角
// 工作卡)。布局骨架固定,内容全部经 registry(registry/registry.ts)装配:
// 左栏 = 当前导航视图(nav),中央 = 导航的 center(缺省聊天),右栏/底栏
// tab 由 chat 面板按 registry.side/bottom 渲染 —— 内置与三方自定义条目
// 走同一条注册路径,宿主可 hide/show/add/remove 任意定制。
// 视觉:工作卡拉通到窗口顶部(无独立标题栏,标题栏角色由左栏顶行/工作卡
// 头部承担);macOS 红绿灯悬浮其左。文件树(filesView)是会话导航的下钻
// 子视图(非独立导航条目)。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme } from '../ui/panel';
import { icon } from '../util/icons';
import { inWails } from '../host/bridge';
import { closeWindow, isWindowMaximised, isWindowsDesktop, minimiseWindow, toggleMaximiseWindow } from '../host/winctl';
import { makeTitleDrag, type TitleDrag } from '../util/titledrag';
import { registry, sideTabId, type PanelContext, type SideTabInstance } from '../registry/registry';
import '../panels/files/file-list';
import '../panels/chat/chat-panel';

/**
 * 装配哪些区域(legacy 兼容键;更细粒度的裁剪用 registry.hide/show):
 * sessions=左栏 chat=中央聊天卡 sidebar=右栏区域 console=底栏区域。
 */
export type PanelName = 'sessions' | 'chat' | 'sidebar' | 'console';

@customElement('grf-app-shell')
export class GrfAppShell extends GrfPanel {
  /** 启用哪些区域,逗号分隔:sessions,chat,sidebar,console(默认全开) */
  @property({ type: String }) panels = 'sessions,chat,sidebar,console';
  /** 初始展开状态覆写,如 "sidebar=false,console=false,leftWidth=300" */
  @property({ type: String }) layout = '';
  /** 初始激活的导航条目 id(默认第一个可见条目) */
  @property({ type: String }) nav = '';

  @state() private leftWidth = 248;
  /** 右栏(详情/审查等)默认收起:打开应用仅展开左边栏 */
  @state() private showSidebar = false;
  /** 底栏(终端等)展开态 */
  @state() private showBottom = false;
  @state() private showSessions = true;
  /** 当前激活的导航条目 id(默认 'sessions') */
  @state() private activeNavId = 'sessions';
  /** 各导航条目的壳侧状态(如设置分区;经 grf-nav-state 事件上行) */
  @state() private navStates = new Map<string, unknown>();
  /** 会话导航的下钻子视图:项目文件树(null = 会话列表) */
  @state() private filesView: { projectId: string; name: string; path: string } | null = null;
  /** 右栏已打开的 tab 实例(空 = 右栏显示类型入口页) */
  @state() private sideTabs: SideTabInstance[] = [];
  /** 右栏当前激活的 tab id */
  @state() private activeSideTab = '';

  /** macOS 桌面态:左栏顶行左侧为红绿灯(关/最小/最大化)预留悬浮位,
   * 最大化按钮之后仅放左边栏开关。 */
  private readonly nativeLights =
    inWails() && /mac/i.test(navigator.platform || navigator.userAgent);

  /** Windows 桌面态:窗口整窗无边框(原生标题栏与最小化/最大化/关闭都已
   * 移除),右上角由壳自绘 .winctl;顶排头部右侧让位(见 .win)。 */
  private readonly nativeWinControls = isWindowsDesktop();

  /** 窗口当前是否最大化(切换 .winctl 的最大化/还原图标) */
  @state() private winMaximised = false;

  /** 左栏顶行即窗口标题栏:空白区拖拽移动 / 双击缩放(非桌面态静默) */
  private tdrag: TitleDrag | null = null;
  private dragging: 'left' | null = null;
  private regUnsub?: () => void;

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
      .left > * {
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
      /* 激活态:与聊天头部 .tg.on 同款,不显示强调色,仅淡背景 */
      .side-top .toggler button.on {
        color: var(--grf-text);
        background: var(--grf-bg-active);
      }
      .side-top .toggler svg {
        width: 13px;
        height: 13px;
      }
      /* 左栏拖拽条:绝对定位悬浮在左栏右边界上(左右各压 4px),不占布局
       * 空间 —— 左栏与工作卡完全贴合无边距;默认隐形,悬停亮出中性灰
       * (不用强调色,避免分界线变蓝) */
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
        background: var(--grf-border-hover);
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
      .center > * {
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      .hidden {
        display: none !important;
      }
      /* Windows 无边框窗口控制:右上角自绘最小化/最大化/关闭,与顶排同高
       * (40px);面板头部右侧经 .win 让出等宽空间(30×3 + 间隙 + 内边距)。 */
      .winctl {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 60;
        display: flex;
        align-items: center;
        gap: 2px;
        height: 40px;
        padding-right: 4px;
        box-sizing: border-box;
      }
      .winctl button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: var(--grf-text-faint);
        cursor: pointer;
      }
      .winctl button:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .winctl button.close:hover {
        background: #e81123;
        color: #fff;
      }
      .winctl svg {
        width: 13px;
        height: 13px;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.parseLayout();
    if (this.nav) this.activeNavId = this.nav;
    this.tdrag = makeTitleDrag('button');
    // registry 变更(三方增删条目)即时反映到装配
    this.regUnsub = registry.subscribe(() => this.requestUpdate());
    // 导航切换:设置进入(session-list 齿轮)/ 返回 / 三方 grf-nav-activate
    this.addEventListener('grf-open-settings', () => this.navTo('settings'));
    this.addEventListener('grf-close-settings', () => this.navBack());
    this.addEventListener('grf-nav-activate', (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string') this.navTo(id);
    });
    // 导航视图上抛的壳侧状态(如设置分区)
    this.addEventListener('grf-nav-state', (e: Event) => {
      const { nav, state } = (e as CustomEvent<{ nav?: string; state: unknown }>).detail ?? {};
      const id = nav ?? this.activeNavId;
      this.navStates = new Map(this.navStates).set(id, state);
    });
    // 内置设置导航的分区切换事件(字符串载荷)映射为 nav state
    this.addEventListener('grf-settings-section', (e: Event) => {
      this.navStates = new Map(this.navStates).set('settings', (e as CustomEvent).detail);
    });
    // 会话导航的下钻:项目文件树(session-list「查看文件」进入 / 返回退出)
    this.addEventListener('grf-open-files', (e: Event) => {
      this.navTo('sessions'); // navTo 会清空 filesView(下钻随导航切换退出),须先切再设
      this.filesView = (e as CustomEvent).detail;
    });
    this.addEventListener('grf-close-files', () => (this.filesView = null));
    // 右栏确保展开(file-view html 眼睛开浏览器 tab 时;已开则无变化)
    this.addEventListener('grf-show-sidebar', () => (this.showSidebar = true));
    // 左栏文件树点文件:右栏为该文件开一个独立 tab 预览(已开则激活)
    this.addEventListener('grf-open-file', (e: Event) => {
      const f = (e as CustomEvent).detail as { path: string; name: string; rel?: string };
      this.openSideTab({ defId: 'file', key: f.path, title: f.rel ?? f.name });
    });
    window.addEventListener('pointermove', this.onDrag);
    window.addEventListener('pointerup', this.stopDrag);
    // Windows 无边框态:最大化状态只有自绘按钮要知道(切换图标)。窗口尺寸
    // 变化即查询一次,覆盖双击顶排/Win+↑/任务栏等一切非按钮路径。
    if (this.nativeWinControls) {
      window.addEventListener('resize', this.syncMaximised);
      this.syncMaximised();
    }
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    this.regUnsub?.();
    this.regUnsub = undefined;
    window.removeEventListener('pointermove', this.onDrag);
    window.removeEventListener('pointerup', this.stopDrag);
    window.removeEventListener('resize', this.syncMaximised);
    super.disconnectedCallback();
  }

  /** 同步"是否最大化"(自绘按钮图标);桥不可达保持原值。 */
  private syncMaximised = (): void => {
    if (!this.nativeWinControls) return;
    void isWindowMaximised().then((m) => {
      if (m !== null && m !== this.winMaximised) this.winMaximised = m;
    });
  };

  private onWinMaxToggle(): void {
    toggleMaximiseWindow();
    // 原生切换是异步的:等一拍再读真实状态(不依赖任何平台事件名)。
    window.setTimeout(this.syncMaximised, 60);
  }

  // ---------- 对外 API(宿主编程控制) ----------

  /** 切换到某个导航条目(不可见条目忽略)。 */
  navTo(id: string): void {
    const def = registry.nav.get(id);
    if (!def) return;
    if (!(def.visible?.(this.renderCtx()) ?? true)) return;
    this.activeNavId = id;
    this.filesView = null; // 下钻视图随导航切换退出
  }

  /** 从当前导航返回(经 grf-nav-back 或内置返回键)。 */
  navBack(): void {
    const def = registry.nav.get(this.activeNavId);
    this.navTo(def?.exitTo ?? this.firstNavId());
  }

  /** 打开右栏 tab(单例已开则激活;多实例按 key 去重)。 */
  openSideTab(tab: SideTabInstance): void {
    const def = registry.side.get(tab.defId);
    if (!def) return;
    const id = sideTabId(tab);
    const exists = this.sideTabs.some((t) => sideTabId(t) === id);
    if (!exists) this.sideTabs = [...this.sideTabs, tab];
    this.activeSideTab = id;
    this.showSidebar = true;
  }

  /** 当前激活导航条目 id。 */
  get activeNav(): string {
    return this.activeNavId;
  }

  private firstNavId(): string {
    return registry.nav.visible(this.renderCtx())[0]?.id ?? 'sessions';
  }

  /** 渲染上下文(懒建;scope/store 变化或每次渲染时刷新易变字段)。 */
  private _ctx?: PanelContext;

  private renderCtx(): PanelContext {
    if (!this._ctx || this._ctx.scope !== this.scope || this._ctx.store !== this.store) {
      this._ctx = {
        scope: this.scope,
        store: this.store,
        sessionId: this.store?.activeSessionId,
        desktop: inWails(),
        shell: {
          leftOn: this.showSessions,
          desktopLights: this.nativeLights,
          desktopWinControls: this.nativeWinControls,
          toggleLeft: () => (this.showSessions = !this.showSessions),
        },
      };
    }
    const ctx = this._ctx;
    // sessionId 随会话选择变化(store 订阅驱动重渲染,这里带出最新值)
    ctx.sessionId = this.store?.activeSessionId;
    if (ctx.shell) {
      ctx.shell.leftOn = this.showSessions;
      ctx.shell.desktopLights = this.nativeLights;
      ctx.shell.desktopWinControls = this.nativeWinControls;
    }
    return ctx;
  }

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

  // ---------- 右栏 tab 状态(chat 面板经事件上抛,这里受控维护) ----------

  private closeSideTab(id: string): void {
    const next = this.sideTabs.filter((t) => sideTabId(t) !== id);
    this.sideTabs = next;
    if (this.activeSideTab === id) {
      this.activeSideTab = next.length ? sideTabId(next[next.length - 1]) : '';
    }
  }

  render() {
    const hasSessions = this.panelOn('sessions');
    const hasChat = this.panelOn('chat');
    const hasSidebar = this.panelOn('sidebar');
    const hasConsole = this.panelOn('console');
    const ctx = this.renderCtx();
    const navDef = registry.nav.get(this.activeNavId);
    const navState = this.navStates.get(this.activeNavId);

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
                    <button class="on" title="收起侧栏" @click=${() => (this.showSessions = false)}>${unsafeHTML(icon.panelLeft)}</button>
                  </span>
                </div>
                ${this.filesView && this.activeNavId === 'sessions'
                  ? html`<grf-file-list
                      scope=${this.scope}
                      root=${this.filesView.path}
                      projName=${this.filesView.name}
                    ></grf-file-list>`
                  : (navDef?.view(ctx, navState) ?? nothing)}
              </div>
              <div class="gutter-v" style="left:${this.leftWidth}px" @pointerdown=${this.onGutterStart}></div>
            `
          : nothing}
        <div class="center">
          ${navDef?.center
            ? (navDef.center(ctx, navState) as ReturnType<typeof html>)
            : hasChat
              ? html`<grf-chat
                  scope=${this.scope}
                  .bottomToggle=${hasConsole}
                  .sidebarToggle=${hasSidebar}
                  .bottomOn=${this.showBottom}
                  .sidebarOn=${this.showSidebar}
                  .sideTabs=${this.sideTabs}
                  .activeSideTab=${this.activeSideTab}
                  .leftToggle=${hasSessions}
                  .leftOn=${this.showSessions}
                  .leftLights=${this.nativeLights}
                  .winControls=${this.nativeWinControls}
                  @grf-toggle-bottom=${() => (this.showBottom = !this.showBottom)}
                  @grf-toggle-sidebar=${() => (this.showSidebar = !this.showSidebar)}
                  @grf-toggle-sessions=${() => (this.showSessions = !this.showSessions)}
                  @grf-side-tab-open=${(e: Event) => this.openSideTab((e as CustomEvent<SideTabInstance>).detail)}
                  @grf-side-tab-close=${(e: Event) => this.closeSideTab((e as CustomEvent<string>).detail)}
                  @grf-side-tab-activate=${(e: Event) => (this.activeSideTab = (e as CustomEvent<string>).detail)}
                ></grf-chat>`
              : nothing}
        </div>
      </div>
      ${this.nativeWinControls
        ? html`<div class="winctl">
            <button class="min" title="最小化" @click=${() => minimiseWindow()}>${unsafeHTML(icon.winMin)}</button>
            <button
              class="max"
              title=${this.winMaximised ? '还原' : '最大化'}
              @click=${() => this.onWinMaxToggle()}
            >
              ${unsafeHTML(this.winMaximised ? icon.winRestore : icon.winMax)}
            </button>
            <button class="close" title="关闭" @click=${() => closeWindow()}>${unsafeHTML(icon.winClose)}</button>
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-app-shell': GrfAppShell;
  }
}
