// app-shell.ts — <grf-app-shell>:ZCode 风格桌面布局(左导航 + 黑色圆角
// 工作卡)。布局骨架固定,内容全部经 registry(registry/registry.ts)装配:
// 左栏 = 当前导航视图(nav),中央 = 导航的 center(缺省聊天),右栏/底栏
// tab 由 chat 面板按 registry.side/bottom 渲染 —— 内置与三方自定义条目
// 走同一条注册路径,宿主可 hide/show/add/remove 任意定制。
// 视觉:工作卡拉通到窗口顶部(无独立标题栏,标题栏角色由左栏顶行/工作卡
// 头部承担);macOS 红绿灯悬浮其左。文件树(filesView)是会话导航的下钻
// 子视图(非独立导航条目)。
import { css, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, panelRegistered } from '../ui/panel';
import { icon } from '../util/icons';
import { inWails } from '../host/bridge';
import { isMacDesktop } from '../host/platform';
import { closeWindow, isWindowMaximised, isFramelessDesktop, minimiseWindow, toggleMaximiseWindow } from '../host/winctl';
import { makeTitleDrag, type TitleDrag } from '../util/titledrag';
import { registry, sideTabId, getModelGuard, onModelGuardChange, getSideTop, onSideTopChange, getFileOpen, getUiEventHandler, type PanelContext, type SideTabInstance, type UiEvent } from '../registry/registry';
import { initConsoleUi, reportConsoleUi, visibleTermIds } from './console-ui';
import { settingsStore } from '../core/settings/settings-store';
import '../panels/files/file-list';
import '../panels/chat/chat-panel';
import './side-dock';
import './bottom-dock';

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

  /** macOS 桌面态(检测见 host/platform.ts):左栏顶行左侧为红绿灯
   * (关/最小/最大化)预留悬浮位,最大化按钮之后仅放左边栏开关。 */
  private readonly nativeLights = isMacDesktop();

  /** 无边框桌面平台(Windows/Linux):窗口整窗无边框(原生标题栏与最小化/
   * 最大化/关闭都已移除),右上角由壳自绘 .winctl;顶排头部右侧让位(见 .win)。 */
  private readonly nativeWinControls = isFramelessDesktop();

  /** 窗口当前是否最大化(切换 .winctl 的最大化/还原图标) */
  @state() private winMaximised = false;

  /** 左栏顶行即窗口标题栏:空白区拖拽移动 / 双击缩放(非桌面态静默) */
  private tdrag: TitleDrag | null = null;
  /** 嵌入态启动模型守卫:是否已检查过(只生效一次)与 registry 订阅句柄 */
  private modelGuardDone = false;
  private modelGuardOff: (() => void) | undefined;
  private dragging: 'left' | null = null;
  private regUnsub?: () => void;
  /** 左栏顶行注入(embed.configure 的 sideTop):订阅句柄 + 元素缓存
   * (跨重渲保活,配置变更时丢弃重建) */
  private sideTopOff?: () => void;
  private sideTopEls = new Map<'leading' | 'trailing', HTMLElement>();

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
      /* 工作卡(黑色圆角卡片;原属 chat 面板,dock 剥离后上移壳层,
       * 使「自定义中央内容 + 右栏/底栏」与聊天同享卡片视觉) */
      .workcard {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        background: var(--grf-card);
        border-radius: 12px 12px 0 0;
        overflow: hidden;
      }
      .workcard .cols {
        flex: 1;
        min-height: 0;
        display: flex;
      }
      .workcard .col-main {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .workcard .col-main > * {
        flex: 1;
        min-height: 0;
      }
      .hidden {
        display: none !important;
      }
      /* 无边框桌面平台(Windows/Linux)窗口控制:右上角自绘最小化/最大化/关闭,与顶排同高
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
    else this.activeNavId = this.firstNavId();
    this.tdrag = makeTitleDrag('button, grf-update-chip');
    // registry 变更(三方增删条目)即时反映到装配
    this.regUnsub = registry.subscribe(() => this.requestUpdate());
    // 嵌入态启动模型守卫(宿主经 embed.configure 的 modelGuard 开启;桌面/
    // 纯 web 由各自入口 GrfDesktop 守卫,不重复):gh 侧没有任何可用模型
    // 时自动进入设置的模型分区引导完成配置。configure 可能晚于本壳连接
    // (静态声明的壳元素在嵌入库加载瞬间升级),registry 通知兜底唤醒;
    // 守卫只生效一次,用户关掉设置页返回后不再强拉。宿主下发过 model 的
    // scope 不适用;gh 配置读取失败(modelCfg 为 null)视为未知、不误判。
    this.modelGuardOff = onModelGuardChange(() => this.tryModelGuard());
    this.tryModelGuard();
    // 宿主左栏顶行注入(见 registry.SideTopConfig):变更时丢弃缓存重建
    this.sideTopOff = onSideTopChange(() => {
      this.sideTopEls.clear();
      this.requestUpdate();
    });
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
    // 内置设置导航的分区切换事件(字符串载荷)映射为 nav state;经 UI
    // 事件总线先问集成方(接管则不变更)
    this.addEventListener('grf-settings-section', (e: Event) => {
      if (this.uiGate({ type: 'settings-section', section: (e as CustomEvent).detail })) return;
      this.navStates = new Map(this.navStates).set('settings', (e as CustomEvent).detail);
    });
    // 会话导航的下钻:项目文件树(session-list「查看文件」进入 / 返回退出)
    this.addEventListener('grf-open-files', (e: Event) => {
      const view = (e as CustomEvent).detail;
      if (this.uiGate({ type: 'files-view', view })) return;
      this.navTo('sessions'); // navTo 会清空 filesView(下钻随导航切换退出),须先切再设
      this.filesView = view;
    });
    this.addEventListener('grf-close-files', () => {
      if (this.uiGate({ type: 'files-view', view: null })) return;
      this.filesView = null;
    });
    // 右栏确保展开(file-view html 眼睛开浏览器 tab 时;已开则无变化)
    this.addEventListener('grf-show-sidebar', () => this.setSidebar(true));
    // 左栏文件树点文件:右栏为该文件开一个独立 tab 预览(已开则激活)。
    // 宿主 fileOpen 钩子优先(embed.configure 的 fileOpen 落点):返回 true
    // = 嵌入方已接管(路由到自己的面板),不再打开内置「文件」tab。
    this.addEventListener('grf-open-file', (e: Event) => {
      const f = (e as CustomEvent).detail as { path: string; name: string; rel?: string };
      this.hostOpenFile(f);
    });
    window.addEventListener('pointermove', this.onDrag);
    window.addEventListener('pointerup', this.stopDrag);
    // goder-console 智能体接线(goder_ui_do / goder_terminal_new 的前端
    // 落点;纯 web 态内部 no-op)。操作面与用户手动操作同一入口。
    initConsoleUi({
      navTo: (id) => this.navTo(id),
      openSideTab: (t) => this.openSideTab(t),
      activateSideTab: (id) => this.activateSideTab(id),
      setSidebar: (on) => this.setSidebar(on),
      setBottom: (on) => this.setBottom(on),
      setSessions: (on) => this.setSessions(on),
      openFile: (f) => this.hostOpenFile(f),
      focusSession: (id) => this.store?.selectSession(id),
      openBrowser: (url) => this.consoleOpenBrowser(url),
    },
    () => this.consoleSnapshot());
    // 无边框桌面平台:最大化状态只有自绘按钮要知道(切换图标)。窗口尺寸
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
    this.modelGuardOff?.();
    this.modelGuardOff = undefined;
    this.sideTopOff?.();
    this.sideTopOff = undefined;
    window.removeEventListener('pointermove', this.onDrag);
    window.removeEventListener('pointerup', this.stopDrag);
    window.removeEventListener('resize', this.syncMaximised);
    super.disconnectedCallback();
  }

  /** UI 事件总线闸门:壳层页面变更执行前派发给集成方(uiEvents 钩子),
   *  返回 true = 已接管,本次变更不再执行;未配置/返回 false = 放行。 */
  private uiGate(e: UiEvent): boolean {
    const h = getUiEventHandler(this.scope);
    return h ? h(e) === true : false;
  }

  /** 「点文件 → 右栏」统一路由:UI 事件总线优先,宿主 fileOpen 钩子
   *  次之(均返回 true = 已接管),否则走内置「文件」tab(console 来源
   *  缺 name 时 title 退全路径)。 */
  private hostOpenFile(f: { path: string; name?: string; rel?: string }): void {
    if (this.uiGate({ type: 'file-open', file: f })) return;
    const hook = getFileOpen(this.scope);
    if (hook?.(f)) return;
    this.openSideTab({ defId: 'file', key: f.path, title: f.rel ?? f.name ?? f.path });
  }

  /** 嵌入态启动模型守卫本体(见 connectedCallback 处注释;连接时与
   * configure 后的 registry 通知都会尝试,幂等只检查一次)。 */
  private tryModelGuard(): void {
    if (this.modelGuardDone || inWails() || !getModelGuard(this.scope) || this.store?.model) return;
    this.modelGuardDone = true;
    void settingsStore.loadModelCfg().then(() => {
      const mc = settingsStore.modelCfg;
      if (!mc) return; // 读取失败/不支持:未知不误判
      if ((mc.providers ?? []).some((p) => (p.models ?? []).length > 0)) return;
      this.navTo('settings');
      this.navStates = new Map(this.navStates).set('settings', 'models');
    });
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

  /** 切换到某个导航条目(不可见条目忽略;经 UI 事件总线,集成方可接管)。 */
  navTo(id: string): void {
    const def = registry.nav.get(id);
    if (!def) return;
    if (!(def.visible?.(this.renderCtx()) ?? true)) return;
    if (this.uiGate({ type: 'nav', id })) return;
    this.activeNavId = id;
    this.filesView = null; // 下钻视图随导航切换退出
  }

  /** 从当前导航返回(经 grf-nav-back 或内置返回键)。 */
  navBack(): void {
    const def = registry.nav.get(this.activeNavId);
    this.navTo(def?.exitTo ?? this.firstNavId());
  }

  /** 打开右栏 tab(单例已开则激活;多实例按 key 去重;经 UI 事件总线)。 */
  openSideTab(tab: SideTabInstance): void {
    const def = registry.side.get(tab.defId);
    if (!def) return;
    if (this.uiGate({ type: 'side-tab-open', tab })) return;
    const id = sideTabId(tab);
    const exists = this.sideTabs.some((t) => sideTabId(t) === id);
    if (!exists) this.sideTabs = [...this.sideTabs, tab];
    this.activeSideTab = id;
    this.showSidebar = true;
  }

  /** 激活已打开的右栏 tab(经 UI 事件总线,集成方可接管)。 */
  activateSideTab(id: string): void {
    if (this.uiGate({ type: 'side-tab-activate', id })) return;
    this.activeSideTab = id;
    this.showSidebar = true;
  }

  /** 三栏显隐(经 UI 事件总线,集成方可接管)。 */
  setSidebar(on: boolean): void {
    if (this.uiGate({ type: 'sidebar', on })) return;
    this.showSidebar = on;
  }

  setBottom(on: boolean): void {
    if (this.uiGate({ type: 'bottom', on })) return;
    this.showBottom = on;
  }

  setSessions(on: boolean): void {
    if (this.uiGate({ type: 'sessions', on })) return;
    this.showSessions = on;
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
          toggleLeft: () => this.setSessions(!this.showSessions),
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
    // 初始布局还原(boot 一次性),不经 UI 事件总线——总线面向「变更」,
    // 初始化时集成方尚未 configure 完成也无从拦截
    for (const kv of this.layout.split(',')) {
      const [k, v] = kv.split('=').map((x) => x?.trim());
      if (k === 'sidebar') this.showSidebar = v !== 'false';
      if (k === 'console' || k === 'bottom') this.showBottom = v !== 'false';
      if (k === 'sessions') this.showSessions = v !== 'false';
      if (k === 'leftWidth') this.leftWidth = Number(v) || this.leftWidth;
    }
  }

  protected updated(props: PropertyValues<this>): void {
    super.updated(props);
    reportConsoleUi(this.consoleSnapshot());
  }

  protected willUpdate(_props: PropertyValues<this>): void {
    // 激活导航不可见(初始默认值失效、被 hide/remove)时落到首个可见
    // 条目 —— 渲染取 def 用 get 不校验隐藏,不收敛会让被裁剪的视图
    // 残留在首屏(嵌入方 hide('sessions') 只留自家条目的场景)。
    if (!registry.nav.visible(this.renderCtx()).some((d) => d.id === this.activeNavId)) {
      const first = this.firstNavId();
      if (first) this.activeNavId = first;
    }
  }

  /** 打开右栏浏览器 tab 并导航(智能体 open_browser 与 file-view 的
   * html「眼睛」共用;导航经 side-dock 的公开元素访问,不再跨 shadow
   * 摸内部标签)。 */
  private openBrowserTab(url: string): void {
    this.openSideTab({ defId: 'browser' });
    if (!url) return;
    void this.updateComplete.then(() => {
      const dock = this.renderRoot.querySelector('grf-side-dock');
      const b = dock?.panelEl('browser') as { open?(u: string): void } | undefined;
      b?.open?.(url);
    });
  }

  private consoleOpenBrowser(url: string): void {
    this.openBrowserTab(url);
  }

  /** consoleSnapshot 界面状态快照(goder_ui_state 工具读;终端会话等
   * 跨模块状态由 console-ui 模块汇入)。 */
  private consoleSnapshot(): unknown {
    return {
      nav: this.activeNavId,
      sessions: this.showSessions,
      sidebar: this.showSidebar,
      bottom: this.showBottom,
      sideTabs: this.sideTabs.map((t) => ({ defId: t.defId, key: t.key ?? null, title: t.title ?? null })),
      activeSideTab: this.activeSideTab || null,
      activeSessionId: this.store?.activeSessionId ?? null,
      terminals: visibleTermIds(),
    };
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
    if (this.uiGate({ type: 'side-tab-close', id })) return;
    const next = this.sideTabs.filter((t) => sideTabId(t) !== id);
    this.sideTabs = next;
    if (this.activeSideTab === id) {
      this.activeSideTab = next.length ? sideTabId(next[next.length - 1]) : '';
    }
  }

  /** 取左栏顶行注入元素(缓存保活;配置变更时由订阅清空重建)。 */
  private sideTopEl(slot: 'leading' | 'trailing'): HTMLElement {
    let el = this.sideTopEls.get(slot);
    if (!el) {
      el = getSideTop(this.scope)?.[slot]?.() ?? document.createElement('div');
      this.sideTopEls.set(slot, el);
    }
    return el;
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
                  ${getSideTop(this.scope)?.leading ? html`${this.sideTopEl('leading')}` : nothing}
                  <span class="toggler">
                    <button class="on" title="收起侧栏" @click=${() => this.setSessions(false)}>${unsafeHTML(icon.panelLeft)}</button>
                  </span>
                  ${ctx.desktop && panelRegistered('grf-update-chip')
                    ? html`<grf-update-chip></grf-update-chip>`
                    : nothing}
                  ${getSideTop(this.scope)?.trailing ? html`${this.sideTopEl('trailing')}` : nothing}
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
          <div
            class="workcard"
            @grf-toggle-bottom=${() => this.setBottom(!this.showBottom)}
            @grf-toggle-sidebar=${() => this.setSidebar(!this.showSidebar)}
            @grf-toggle-sessions=${() => this.setSessions(!this.showSessions)}
            @grf-side-tab-open=${(e: Event) => this.openSideTab((e as CustomEvent<SideTabInstance>).detail)}
            @grf-side-tab-close=${(e: Event) => this.closeSideTab((e as CustomEvent<string>).detail)}
            @grf-side-tab-activate=${(e: Event) => this.activateSideTab((e as CustomEvent<string>).detail)}
            @grf-open-browser-url=${(e: Event) => this.openBrowserTab((e as CustomEvent<{ url: string }>).detail.url)}
          >
            <div class="cols">
              <div class="col-main">
                ${navDef?.center
                  ? (navDef.center(ctx, navState) as ReturnType<typeof html>)
                  : hasChat
                    ? html`<grf-chat
                        scope=${this.scope}
                        flat
                        .bottomToggle=${hasConsole}
                        .sidebarToggle=${hasSidebar}
                        .bottomOn=${this.showBottom}
                        .sidebarOn=${this.showSidebar}
                        .sideTabs=${this.sideTabs}
                        .leftToggle=${hasSessions}
                        .leftOn=${this.showSessions}
                        .leftLights=${this.nativeLights}
                        .winControls=${this.nativeWinControls}
                      ></grf-chat>`
                    : nothing}
                ${hasConsole
                  ? html`<grf-bottom-dock scope=${this.scope} .on=${this.showBottom}></grf-bottom-dock>`
                  : nothing}
              </div>
              ${hasSidebar
                ? html`<grf-side-dock
                    scope=${this.scope}
                    .on=${this.showSidebar}
                    .tabs=${this.sideTabs}
                    .activeTab=${this.activeSideTab}
                  ></grf-side-dock>`
                : nothing}
            </div>
          </div>
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
