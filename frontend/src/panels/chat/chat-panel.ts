// chat-panel.ts — <goder-chat>:主体聊天面板(消息流 + composer + 头部)。
// 右栏/底栏 dock 已剥离到壳层(<goder-side-dock>/<goder-bottom-dock>,
// shell/side-dock.ts、bottom-dock.ts):dock 是通用布局容器,与聊天内容
// 无关,剥离后「无聊天但保留右栏」的装配(panels="sessions,sidebar")
// 成立;三栏开关按钮的属性委托与 goder-toggle-* 事件不变(shell 受控)。
// 可独立嵌入(独立态默认无 dock);头部空白区为窗口拖拽区。
import { css, html, nothing , type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GoderPanel, theme, controls } from '../../ui/panel';
import { modelContextWindow } from '../../util/modelctx';
import { icon } from '../../util/icons';
import { makeTitleDrag, type TitleDrag } from '../../util/titledrag';
import { inWails, gitStatus, saveSkill, type GitStatusDTO } from '../../host/bridge';
import { usageTotals, type AskItem } from '../../core/model/chat-model';
import { settingsStore, displayFullModel } from '../../core/settings/settings-store';
import { registry, getStatusPop, onStatusPopChange, type PanelContext, type SideTabInstance } from '../../registry/registry';
import './composer';
import './status-pop';
import { renderItem, renderChatNav, cnavWave, cnavReset, type MessageViewProps } from './messages';

/** 被模型守卫拦截的输入(模块级:跳设置-模型页会卸载 composer 甚至本
 * 面板,视图切回、面板重连时恢复,用户配完模型回来输入不丢)。 */
let guardDraft: { text: string; images?: string[] } | null = null;

@customElement('goder-chat')
export class GoderChat extends GoderPanel {
  /** 隐藏头部(嵌入态由宿主自绘头部时) */
  @property({ type: Boolean, attribute: 'no-header' }) noHeader = false;
  /** 隐藏 composer(纯展示态) */
  @property({ type: Boolean, attribute: 'no-composer' }) noComposer = false;
  /** 头部右侧显示底栏开关(app-shell 装配时开启;无可用底栏条目时自动隐藏) */
  @property({ type: Boolean, attribute: 'bottom-toggle' }) bottomToggle = false;
  /** 头部右侧显示右栏开关(app-shell 装配时开启;无可用右栏条目时自动隐藏) */
  @property({ type: Boolean, attribute: 'sidebar-toggle' }) sidebarToggle = false;
  /** 底栏当前展开态(仅开关着色与底栏显隐用;tab 会话保活,不销毁) */
  @property({ type: Boolean }) bottomOn = false;
  /** 右栏当前展开态(收起时右栏隐藏,内部 tab 会话保活) */
  @property({ type: Boolean }) sidebarOn = false;
  /** 右栏已打开的 tab 实例(有序;空 = 显示类型入口页) */
  @property({ type: Array }) sideTabs: SideTabInstance[] = [];
  /** 左栏收起时头部左上角显示左边栏开关(展开时开关在左栏顶行) */
  @property({ type: Boolean, attribute: 'left-toggle' }) leftToggle = false;
  /** 左栏当前展开态 */
  @property({ type: Boolean }) leftOn = true;
  /** macOS 桌面态:左栏收起时头部为红绿灯保留悬浮位 */
  @property({ type: Boolean, attribute: 'left-lights' }) leftLights = false;
  /** 无边框桌面平台(Windows/Linux):头部右上为壳自绘的窗口控制
   * (最小化/最大化/关闭)留位 */
  @property({ type: Boolean, attribute: 'win-controls' }) winControls = false;
  /** 壳层装配标记:去掉本面板自身的卡片视觉(黑底/圆角上移到壳层
   * workcard 容器,避免双层卡片);独立嵌入不传,保留卡片感。 */
  @property({ type: Boolean }) flat = false;

  @state() private stickBottom = true;
  /** 聊天列过窄(右栏/窗口挤压):状态浮窗自动收成单行,避免盖住对话内容 */
  @state() private colNarrow = false;
  /** 聊天列窄阈值(px):低于即自动收缩浮窗 */
  private static readonly NARROW_AT = 560;
  /** 聊天列宽度观察(浮窗自动收缩用) */
  private colRo: ResizeObserver | null = null;
  /** 当前项目 git 状态(状态浮窗用;null = 未取到/不适用) */
  @state() private git: GitStatusDTO | null = null;
  /** 编辑中的用户消息 id 与草稿(编辑后重新发送) */
  @state() private editingId?: string;
  @state() private editDraft = '';
  /** 刚复制成功的消息 id(图标短暂变为 ✓) */
  @state() private copiedId?: string;
  private copiedTimer = 0;
  /** 显式展开过的思考块 id */
  private reasoningOpen = new Set<string>();
  /** 本组件生命周期内已保存的技能目录名(技能卡已保存标记) */
  private savedSkills = new Set<string>();
  /** 设置页模型配置订阅(模型下拉数据源) */
  private settingsUnsub?: () => void;
  /** registry 变更(三方增删条目)即时反映 */
  private regUnsub?: () => void;
  /** 状态浮窗配置变更(嵌入方 configure({statusPop:false})) */
  private statusPopOff?: () => void;

  /** 头部空白区为窗口拖拽区(移动/双击缩放;非桌面态静默) */
  private tdrag: TitleDrag | null = null;
  /** git 状态轮询计时器;仅桌面态请求 */
  private gitTimer?: number;
  /** 上次取 git 状态的项目目录(cwd 变化即重取) */
  private gitCwd = '';

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        /* 黑色圆角主面板(浅色主题经 --goder-card 覆写);底部拉通到窗口
         * 底,只保留上侧圆角。壳层装配(flat)时卡片视觉上移到壳层
         * workcard 容器,本面板透明融入。 */
        background: var(--goder-card);
        border-radius: 12px 12px 0 0;
        overflow: hidden;
        font-family: var(--goder-font);
        font-size: var(--goder-font-size);
        color: var(--goder-text);
        height: 100%;
      }
      :host(.flat) {
        background: transparent;
        border-radius: 0;
      }
      header {
        display: flex;
        align-items: center;
        gap: 10px;
        /* 固定与左栏顶行同高(40px),分隔线对齐;内容垂直居中 */
        height: 40px;
        padding: 0 14px;
        box-sizing: border-box;
        border-bottom: 1px solid var(--goder-border);
        flex: none;
        min-width: 0;
        user-select: none;
      }
      /* macOS 左栏收起时:窗口红绿灯悬浮于卡片左上,头部左侧让位 */
      header.lights {
        padding-left: 80px;
      }
      /* 无边框桌面平台(Windows/Linux):壳右上角自绘的窗口控制(3×30 + 间隙
       * 悬浮于卡片右上,头部右侧让位 */
      header.win {
        padding-right: 106px;
      }
      .title {
        font-weight: 600;
        font-size: var(--goder-font-size);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: 1;
      }
      .chip {
        flex: none;
        font-size: var(--goder-font-size-xs);
        padding: 2px 9px;
        border-radius: 99px;
        border: 1px solid var(--goder-border);
        color: var(--goder-text-dim);
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .chip.waiting {
        color: var(--goder-warn);
        border-color: var(--goder-warn);
        background: var(--goder-warn-soft);
      }
      .chip .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      @keyframes pulse {
        50% {
          opacity: 0.3;
        }
      }
      .actions {
        flex: none;
        display: flex;
        gap: 4px;
      }
      .actions svg {
        width: 14px;
        height: 14px;
      }
      .toggler {
        flex: none;
        display: flex;
      }
      /* 激活态:不显示强调色,仅淡背景提示开/关 */
      .tg.on {
        color: var(--goder-text);
        background: var(--goder-bg-active);
      }
      /* 消息区容器:定位基准,承载状态浮窗(锚在 header 之下的聊天列
       * 右上,不遮头部右侧的三栏开关按钮)、左侧导航小横线与运行圆环 */
      .msgs-wrap {
        flex: 1;
        min-height: 0;
        display: flex;
        position: relative;
      }
      /* 聊天列保底宽度:避免壳层宽 tab 把聊天列与底部输入框挤成一条缝 */
      .msgs-wrap,
      .composer-area {
        min-width: min(340px, 45%);
      }
      .msgs {
        flex: 1;
        min-width: 0;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 16px 18px 10px;
        min-height: 0;
      }
      /* 左侧消息导航:悬停时横线呈波浪伸缩 */
      .cnav {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 22px;
        padding-left: 3px;
        box-sizing: border-box;
        z-index: 20;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: flex-start;
        gap: 7px;
      }
      .cnav .tick {
        position: relative;
        width: 12px;
        height: 2px;
        flex: none;
        border-radius: 1px;
        background: var(--goder-border-hover);
        cursor: pointer;
        transition:
          width 0.12s ease,
          background-color 0.12s ease;
      }
      .cnav .tick::before {
        content: '';
        position: absolute;
        top: -4px;
        bottom: -4px;
        left: -4px;
        right: -4px;
      }
      .cnav .tick.peak {
        background: var(--goder-text);
      }
      .cnav .tick:hover {
        background: var(--goder-text-dim);
      }
      .cnav .tick .tip {
        display: none;
        position: absolute;
        left: 44px;
        top: 50%;
        transform: translateY(-50%);
        width: 250px;
        box-sizing: border-box;
        background: var(--goder-bg-raise);
        border: 1px solid var(--goder-border);
        border-radius: var(--goder-radius);
        box-shadow: var(--goder-shadow);
        padding: 7px 10px;
        font-size: var(--goder-font-size-xs);
        line-height: 1.5;
        color: var(--goder-text-dim);
        white-space: normal;
        pointer-events: none;
      }
      .cnav .tick:hover .tip {
        display: block;
      }
      .cnav .tip .u {
        color: var(--goder-text);
        font-weight: 600;
        margin-bottom: 3px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .cnav .tip .a {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      /* 会话运行中:加载圆环跟在最后一条消息之后 */
      .run-ring {
        display: inline-block;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid var(--goder-border-hover);
        border-top-color: var(--goder-text-dim);
        box-sizing: border-box;
        animation: run-spin 0.8s linear infinite;
        margin: 8px 0 4px;
      }
      @keyframes run-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .inner {
        max-width: 860px;
        margin: 0 auto;
        display: grid;
        gap: 14px;
      }
      .inner > * {
        min-width: 0;
      }
      .empty {
        padding: 60px 20px;
        text-align: center;
        color: var(--goder-text-faint);
        display: grid;
        gap: 8px;
        justify-items: center;
      }
      .empty .big {
        width: 44px;
        height: 44px;
        opacity: 0.5;
      }
      .empty h3 {
        margin: 0;
        font-size: 15px;
        color: var(--goder-text-dim);
        font-weight: 600;
      }
      .empty p {
        margin: 0;
        font-size: var(--goder-font-size-sm);
        max-width: 420px;
        line-height: 1.7;
      }
      /* 用户消息:气泡靠右,复制/编辑悬停露出 */
      .msg-user {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }
      .msg-user .body {
        max-width: 80%;
        background: var(--goder-user-bubble);
        border: 1px solid var(--goder-border-soft);
        border-radius: 12px;
        padding: 9px 13px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .bops {
        display: flex;
        gap: 2px;
        flex: none;
        opacity: 0;
        margin-top: 4px;
        transition: opacity 0.12s;
      }
      .msg-user:hover .bops {
        opacity: 1;
      }
      .bop {
        border: none;
        background: transparent;
        color: var(--goder-text-faint);
        padding: 3px;
        border-radius: 5px;
        cursor: pointer;
        display: inline-flex;
      }
      .bop:hover {
        color: var(--goder-text);
        background: var(--goder-bg-hover);
      }
      .bop svg {
        width: 13px;
        height: 13px;
      }
      /* 编辑态:原位输入框 + 操作行 */
      .edit-box {
        width: 100%;
        display: grid;
        gap: 7px;
      }
      .edit-box textarea {
        width: 100%;
        min-height: 72px;
        resize: vertical;
        font-family: var(--goder-font);
        font-size: var(--goder-font-size);
        line-height: 1.6;
        color: var(--goder-text);
        background: var(--goder-bg-raise);
        border: 1px solid var(--goder-border);
        border-radius: 12px;
        padding: 8px 11px;
        outline: none;
        box-sizing: border-box;
      }
      .edit-box textarea:focus {
        border-color: var(--goder-accent);
      }
      .edit-ops {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
        align-items: center;
      }
      .edit-ops .hint {
        margin-right: auto;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
      }
      .msg-user .imgs {
        display: flex;
        gap: 6px;
        margin-top: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .msg-user .imgs img {
        max-width: 180px;
        max-height: 140px;
        border-radius: var(--goder-radius-sm);
        border: 1px solid var(--goder-border);
      }
      .msg-assistant .md {
        line-height: 1.72;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .msg-assistant .md > :first-child {
        margin-top: 0;
      }
      .msg-assistant .md > :last-child {
        margin-bottom: 0;
      }
      .md .md-p {
        margin: 0 0 8px;
      }
      .md .md-h {
        margin: 14px 0 7px;
        font-weight: 650;
        line-height: 1.4;
      }
      .md h1.md-h, .md h2.md-h {
        font-size: 16px;
        border-bottom: 1px solid var(--goder-border-soft);
        padding-bottom: 4px;
      }
      .md h3.md-h { font-size: 14.5px; }
      .md h4.md-h, .md h5.md-h, .md h6.md-h { font-size: 13.5px; }
      .md code {
        font-family: var(--goder-mono);
        font-size: 0.9em;
        background: var(--goder-bg-hover);
        border-radius: 4px;
        padding: 1px 5px;
      }
      .md pre.md-code {
        background: #131418;
        border: 1px solid var(--goder-border-soft);
        border-radius: var(--goder-radius-sm);
        padding: 10px 12px;
        overflow: auto;
        margin: 0 0 8px;
      }
      .md pre.md-code code {
        background: none;
        padding: 0;
        font-size: var(--goder-font-size-xs);
        line-height: 1.6;
        color: #c6cad2;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .md ul, .md ol {
        margin: 0 0 8px;
        padding-left: 22px;
      }
      .md li {
        margin: 2px 0;
      }
      .md a {
        color: var(--goder-accent-text);
      }
      .md blockquote.md-quote {
        margin: 0 0 8px;
        padding: 2px 12px;
        border-left: 3px solid var(--goder-border);
        color: var(--goder-text-dim);
      }
      .md hr.md-hr {
        border: none;
        border-top: 1px solid var(--goder-border);
        margin: 12px 0;
      }
      .md table.md-table {
        display: block;
        overflow-x: auto;
        max-width: 100%;
        border-collapse: collapse;
        margin: 0 0 8px;
      }
      .md table.md-table th,
      .md table.md-table td {
        border: 1px solid var(--goder-border);
        padding: 4px 10px;
        font-size: var(--goder-font-size-sm);
        vertical-align: top;
        text-align: left;
      }
      .md table.md-table th {
        background: var(--goder-bg-hover);
        font-weight: 650;
        white-space: nowrap;
      }
      .cursor {
        display: inline-block;
        width: 7px;
        height: 15px;
        background: var(--goder-accent);
        vertical-align: text-bottom;
        margin-left: 2px;
        animation: pulse 0.9s step-end infinite;
      }
      /* 思考块:无背景,仅左侧细线标识 */
      .reasoning {
        border-left: 2px solid var(--goder-border);
        padding: 6px 11px;
        font-size: var(--goder-font-size-sm);
        color: var(--goder-text-dim);
      }
      .reasoning .rhead {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        color: var(--goder-text-dim);
        font-size: var(--goder-font-size-xs);
        font-weight: 600;
      }
      .reasoning .rhead svg {
        width: 13px;
        height: 13px;
      }
      .reasoning .rhead .chev {
        width: 12px;
        height: 12px;
        flex: none;
        color: var(--goder-text-faint);
        transition: transform 0.15s;
      }
      .reasoning .rhead .chev.open {
        transform: rotate(90deg);
      }
      .reasoning pre {
        margin: 6px 0 0;
        font-family: var(--goder-font);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 180px;
        overflow: auto;
        line-height: 1.6;
      }
      /* 流式思考中:单行高亮,内容从左向右循环滚动;跟随外观强调色 */
      .reasoning.live {
        display: flex;
        align-items: center;
        gap: 7px;
        cursor: pointer;
        color: var(--goder-accent-text);
        background: var(--goder-accent-soft);
        border-radius: var(--goder-radius-sm);
        padding: 4px 10px;
        font-size: var(--goder-font-size-sm);
        white-space: nowrap;
      }
      .reasoning.live svg {
        width: 13px;
        height: 13px;
        flex: none;
      }
      .reasoning.live .rlabel {
        flex: none;
        font-weight: 600;
      }
      .reasoning.live .rscroll {
        flex: 1;
        min-width: 0;
        height: 1.5em;
        line-height: 1.5em;
        overflow: hidden;
      }
      .reasoning.live .rtext {
        display: inline-block;
        white-space: nowrap;
      }
      /* 通知/状态 */
      .notice {
        display: flex;
        align-items: baseline;
        gap: 8px;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-dim);
        padding: 2px 2px;
      }
      .notice .k {
        color: var(--goder-text-faint);
        font-family: var(--goder-mono);
        flex: none;
      }
      .notice.goal .k { color: var(--goder-success); }
      .notice.plan .k { color: var(--goder-reasoning); }
      .status {
        text-align: center;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
      }
      .err {
        border: 1px solid var(--goder-error);
        background: var(--goder-error-soft);
        color: var(--goder-error);
        border-radius: var(--goder-radius-sm);
        padding: 8px 12px;
        font-size: var(--goder-font-size-sm);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .composer-area {
        flex: none;
        max-height: 60%;
        overflow-y: auto;
        padding: 10px 18px 14px;
        background: linear-gradient(to top, var(--goder-card) 65%, transparent);
      }
      .composer-area .inner {
        max-width: 860px;
        margin: 0 auto;
      }
    `,
  ];

  private get sid(): string | undefined {
    return this.store?.activeSessionId;
  }

  /** 面板渲染上下文(registry 条目渲染用;每次渲染前刷新)。 */
  private _ctx?: PanelContext;

  private refreshCtx(): PanelContext {
    this._ctx = {
      scope: this.scope,
      store: this.store,
      sessionId: this.store?.activeSessionId,
      desktop: inWails(),
      shell: {
        leftOn: this.leftOn,
        desktopLights: this.leftLights,
        desktopWinControls: this.winControls,
        toggleLeft: () => this.fire('goder-toggle-sessions'),
      },
    };
    return this._ctx;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.tdrag = makeTitleDrag('button');
    // 守卫草稿恢复:模型守卫带去设置页时记下的输入,面板重连(视图切回)
    // 后回填 composer;恢复即清,后续重连不再覆盖新输入。
    if (guardDraft) {
      const d = guardDraft;
      guardDraft = null;
      void this.updateComplete.then(() => this.restoreDraft(d));
    }
    this.gitTimer = window.setInterval(() => void this.pollGit(), 8000);
    // 模型选择下拉的数据源(桌面态 gh settings.json;幂等,已加载则跳过)
    this.settingsUnsub = settingsStore.subscribe(() => this.requestUpdate());
    void settingsStore.loadModelCfg();
    // registry 变更即时反映(三方增删右栏/底栏条目)
    this.regUnsub = registry.subscribe(() => this.requestUpdate());
    // 状态浮窗配置变更即时反映(configure({ statusPop: false }) 裁剪)
    this.statusPopOff = onStatusPopChange(() => this.requestUpdate());
    // 聊天列宽度观察:窄于阈值自动把状态浮窗收成单行(不遮对话内容)
    this.colRo = new ResizeObserver((es) => {
      const w = es[0]?.contentRect.width ?? 0;
      const narrow = w > 0 && w < GoderChat.NARROW_AT;
      if (narrow !== this.colNarrow) this.colNarrow = narrow;
    });
  }

  protected firstUpdated(): void {
    // 观察 .msgs-wrap(本组件内的聊天列;dock 重构后 .col-main 在壳层,
    // 此前查不到导致窄列收缩检测一直失效)
    const el = this.renderRoot.querySelector('.msgs-wrap');
    if (el && this.colRo) this.colRo.observe(el);
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    this.colRo?.disconnect();
    this.colRo = null;
    if (this.gitTimer) window.clearInterval(this.gitTimer);
    this.gitTimer = undefined;
    this.settingsUnsub?.();
    this.settingsUnsub = undefined;
    this.regUnsub?.();
    this.regUnsub = undefined;
    this.statusPopOff?.();
    this.statusPopOff = undefined;
    super.disconnectedCallback();
  }

  // pollGit 状态浮窗的 git 区块:桌面态轮询当前项目仓库状态(浮窗自动
  // 显示,不依赖任何开关;无项目目录时清空)。
  private async pollGit(): Promise<void> {
    if (!inWails()) return;
    const cwd = this.store?.activeProjectPath();
    if (!cwd) {
      this.git = null;
      return;
    }
    try {
      this.git = await gitStatus(cwd);
    } catch {
      this.git = null;
    }
  }

  private maybeScroll(): void {
    if (!this.stickBottom) return;
    const el = this.renderRoot.querySelector('.msgs');
    if (el) el.scrollTop = el.scrollHeight;
  }

  private onScroll(e: Event): void {
    const el = e.target as HTMLElement;
    this.stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  /** 头部修饰类:macOS 红绿灯悬浮位(左栏收起时)/ 无边框桌面平台窗口控制让位 */
  private get headerClass(): string {
    return [this.leftLights && !this.leftOn ? 'lights' : '', this.winControls ? 'win' : ''].filter(Boolean).join(' ');
  }

  render() {
    const s = this.store;
    const ctx = this.refreshCtx();
    const sid = this.sid;
    const rt = sid ? s?.runtimes.get(sid) : undefined;
    const title = sid ? s!.sessionTitle(sid) : '';
    const running = (sid && s!.isRunning(sid)) ?? false;
    const waiting = !!rt && rt.pendingRequests.length > 0 && !running;
    // 待应答提问:交互控件渲染在底部输入框内(点击选项即确认)
    const pendingAsks = rt?.items.filter((i): i is AskItem => i.kind === 'ask' && i.state === 'pending') ?? [];
    // 访问策略:已有会话取服务器回报;草稿或未知回落 项目默认/本机偏好
    const projId = sid
      ? sid.startsWith('draft:')
        ? s?.drafts.get(sid)?.projectId
        : s?.index.sessions[sid]?.projectId
      : undefined;
    const projPolicy = s?.index.projects.find((p) => p.id === projId)?.defaults?.policy;
    const policySrc = rt?.policy ?? s?.draftPolicy ?? projPolicy ?? 'off';
    const policy: 'write-workspace' | 'off' = policySrc && policySrc !== 'off' ? 'write-workspace' : 'off';
    const policyImmediate = !!sid && !sid.startsWith('draft:');
    // 模型按钮显示"下一回合将使用的模型":本机选择优先(刚切换就能看到),
    // 会话尚未发过消息时回落服务端回报(goder 无默认模型概念,不从 gh
    // default 兜底 —— 未选择时按钮显示「选择模型」并由发送守卫拦截)
    const curModel = s?.model || rt?.model || '';
    const activeModel = curModel;
    const providers = (settingsStore.modelCfg?.providers ?? []).map((p) => ({
      name: p.name,
      // models 判空:Go 侧 nil 切片序列化为 null,直接展开会抛 TypeError
      // 冻结整个聊天面板(会话点不开/三栏开关失效)。
      // 菜单项必须带 provider/ 前缀:gh server 的 trySwitchModel 只认
      // "provider/model" 全名,裸模型名会被忽略(切换不生效)
      models: (p.models ?? []).map((m) => `${p.name}/${m}`),
    }));
    // 服务端回报的 model 是裸名(含九天式自带 / 的裸名),统一补 provider
    // 前缀对齐菜单项(勾选态匹配);表未加载/未命中原样保留
    const curFull = displayFullModel(curModel);
    const activeFull = displayFullModel(activeModel);
    if (curFull && !providers.some((g) => g.models.includes(curFull))) {
      providers.push({ name: '当前模型', models: [curFull] });
    }
    // 上下文窗口取会话实际模型(圆环分母):优先供应商 /models 接口回报的
    // 真实值(token-hub / OpenRouter 等网关);查不到暂用按名估算并后台
    // 探测一次,成功后 store bump 触发重渲染换上真实值
    const ctxModel = rt?.model || curModel || '';
    const ctxExact = settingsStore.providerCtxWindow(ctxModel);
    const contextWindow = ctxExact ?? modelContextWindow(ctxModel || undefined);
    if (ctxExact == null) settingsStore.probeProviderCtx(ctxModel);
    // 头部开关:装配开启且确有可用条目才显示
    const bottomDefs = registry.bottom.visible(ctx);
    const showBottomToggle = this.bottomToggle && bottomDefs.length > 0;
    const showSidebarToggle = this.sidebarToggle && registry.side.visible(ctx).length > 0;

    return html`
      ${this.noHeader
        ? nothing
        : html`
            <header
              class=${this.headerClass}
              @mousedown=${(e: MouseEvent) => this.tdrag?.onDown(e)}
              @dblclick=${(e: MouseEvent) => this.tdrag?.onDbl(e)}
            >
              ${this.leftToggle && !this.leftOn
                ? html`<span class="toggler">
                    <button class="ghost tg" title="展开侧栏" @click=${() => this.fire('goder-toggle-sessions')}>${unsafeHTML(icon.panelLeft)}</button>
                  </span>`
                : nothing}
              <span class="title" title=${title}>${title || '未选择会话'}</span>
              ${waiting ? html`<span class="chip waiting"><span class="dot"></span>等待输入</span>` : nothing}
              <span class="actions">
                ${showBottomToggle
                  ? html`<button
                      class="ghost tg ${this.bottomOn ? 'on' : ''}"
                      title=${bottomDefs[0].label}
                      @click=${() => this.fire('goder-toggle-bottom')}
                    >
                      ${unsafeHTML(bottomDefs[0].icon)}
                    </button>`
                  : nothing}
                ${showSidebarToggle
                  ? html`<button class="ghost tg ${this.sidebarOn ? 'on' : ''}" title="右栏面板" @click=${() => this.fire('goder-toggle-sidebar')}>${unsafeHTML(icon.panelRight)}</button>`
                  : nothing}
              </span>
            </header>
          `}
      <div class="msgs-wrap">
            ${getStatusPop(this.scope)
              ? html`<goder-status-pop scope=${this.scope} .git=${this.git} .narrow=${this.colNarrow}></goder-status-pop>`
              : nothing}
            <div class="msgs" @scroll=${this.onScroll}>
              <div class="inner">
                ${!sid || sid.startsWith('draft:')
                  ? this.renderEmpty()
                  : (rt?.items ?? []).map((it) => renderItem(it, this.msgProps, rt?.items))}
                ${running ? html`<div class="run-ring" title="会话运行中"></div>` : nothing}
              </div>
            </div>
            ${renderChatNav(rt?.items ?? [], cnavWave, cnavReset, (id) => this.scrollToMsg(id))}
          </div>
          ${this.noComposer
            ? nothing
            : html`
                <div class="composer-area">
                  <div class="inner">
                    <goder-composer
                      scope=${this.scope}
                      .running=${running}
                      .inputRequired=${waiting}
                      .asks=${pendingAsks}
                      .queue=${sid ? s!.queuedSends(sid) : []}
                      .policy=${policy}
                      .policyImmediate=${policyImmediate}
                      .policySelector=${s?.policySelector !== false}
                      .providers=${providers}
                      .model=${curFull}
                      .activeModel=${activeFull}
                      .effort=${s!.reasoningEffort ?? ''}
                      .usage=${rt?.usage ?? null}
                      .usageTotals=${rt ? usageTotals(rt) : null}
                      .usageModel=${displayFullModel(rt?.model ?? '')}
                      .stats=${rt?.stats ?? null}
                      .contextWindow=${contextWindow}
                      .ctxExact=${ctxExact != null}
                      @policy-change=${this.onPolicyChange}
                      @model-change=${this.onModelChange}
                      @effort-change=${(e: CustomEvent<string>) => s!.setReasoningEffort(e.detail)}
                      @send=${this.onSend}
                      @queue-remove=${(e: CustomEvent<{ index: number }>) => {
                        if (sid) s!.removeQueuedSend(sid, e.detail.index);
                      }}
                      @answer=${this.onAskAnswer}
                      @dismiss=${this.onAskDismiss}
                      @stop=${() => void s!.cancelActive()}
                    ></goder-composer>
                  </div>
                </div>
              `}
    `;
  }

  // ---------- 消息流渲染回调(messages.ts 的宿主实现) ----------

  private get msgProps(): MessageViewProps {
    return {
      scope: this.scope,
      store: this.store,
      sessionId: this.sid,
      t: (key: string) => this.t(key),
      editingId: this.editingId,
      editDraft: this.editDraft,
      copiedId: this.copiedId,
      reasoningOpen: this.reasoningOpen,
      onEditDraft: (v) => (this.editDraft = v),
      onCommitEdit: () => this.commitEdit(),
      onCancelEdit: () => this.cancelEdit(),
      onStartEdit: (it) => this.startEdit(it),
      onCopy: (id, text) => void this.copyText(id, text),
      onToggleReasoning: (id) => {
        if (this.reasoningOpen.has(id)) this.reasoningOpen.delete(id);
        else this.reasoningOpen.add(id);
        this.requestUpdate();
      },
      onAskAnswer: this.onAskAnswer,
      onAskDismiss: this.onAskDismiss,
      onApprove: this.onApprove,
      onSaveTask: (name, instructions) => this.saveTaskFromCard(name, instructions),
      isTaskSaved: (name, instructions) => this.isTaskSaved(name, instructions),
      onSaveSkill: (name, content) => void this.saveSkillFromCard(name, content),
      isSkillSaved: (name) => this.savedSkills.has(skillDirName(name)),
    };
  }

  /** 任务卡保存:落库到当前会话所属操作员名下(非操作员会话忽略)。 */
  private saveTaskFromCard(name: string, instructions: string): void {
    const s = this.store;
    const opId = s?.sessionOperatorId(this.sid);
    if (!s || !opId) return;
    s.saveAutomationTask(opId, name, instructions);
  }

  private isTaskSaved(name: string, instructions: string): boolean {
    const s = this.store;
    const opId = s?.sessionOperatorId(this.sid);
    if (!s || !opId) return false;
    const n = name.trim();
    const ins = instructions.trim();
    return s.automationTasksOf(opId).some((t) => t.name === n && t.instructions === ins);
  }

  /** 技能卡保存:技能名归一化为目录安全名,经桌面 bridge 落盘
   * ~/.grf/skills/<名>/SKILL.md(仅桌面态;保存成功后本会话内标记已保存)。 */
  private async saveSkillFromCard(name: string, content: string): Promise<void> {
    const s = this.store;
    const dir = skillDirName(name);
    const body = content.trim();
    if (!s || !dir || !body) return;
    const err = await saveSkill(dir, body);
    if (err) {
      s.log('warn', `技能保存失败:${err}`);
      return;
    }
    this.savedSkills.add(dir);
    s.log('info', `技能已保存:${dir}(设置-技能区可查看)`);
    this.requestUpdate();
  }

  private scrollToMsg(id: string): void {
    const el = this.renderRoot.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private renderEmpty() {
    const s = this.store!;
    if (this.sid?.startsWith('draft:')) {
      return html`<div class="empty">
        <div class="big">${unsafeHTML(icon.chat)}</div>
        <h3>${this.t('新会话')}</h3>
        <p>${this.t('发第一条消息开始对话。首条消息将决定会话标题;项目默认策略(policy / system_prompt 等)随首条消息生效。')}</p>
      </div>`;
    }
    return html`<div class="empty">
      <div class="big">${unsafeHTML(icon.chat)}</div>
      <h3>${s.connState === 'error' ? this.t('无法连接 gh server') : this.t('选择或新建一个会话')}</h3>
      <p>
        ${s.connState === 'error'
          ? html`${this.t('连接失败:{err}。请检查服务配置或登录状态。', { err: s.connError ?? this.t('未知错误') })}`
          : this.t('在左侧选择一个项目的会话,或点击项目上的 + 新建;也可以直接在下方输入发送,自动开始一个新会话(未选项目时归入「未分组会话」)。')}
      </p>
    </div>`;
  }

  // ---------- composer 事件 ----------

  private onSend(e: CustomEvent<{ text: string; images?: string[] }>): void {
    const payload = e.detail;
    void this.ensureModelReady(payload).then((ok) => {
      if (ok) void this.store!.send(payload.text, payload.images);
    });
  }

  /** 模型守卫(异步):本端已选模型或当前会话有实际模型时直接放行。
   * gh 侧没有任何可用模型 → 带用户去设置的模型页完成配置,输入记为守卫
   * 草稿(跳设置页会卸载 composer,本面板重连时恢复,防止输入丢失);
   * 有可用模型但本端未选 → 拦截发送并提示(goder 没有"默认模型"概念,
   * gh 的服务端默认不代填,须显式选择),同时打开模型菜单引导一步到位。
   * gh 配置读取失败(modelCfg 为 null)视为未知、不拦截,维持直接发送。 */
  private async ensureModelReady(payload: { text: string; images?: string[] }): Promise<boolean> {
    const s = this.store;
    if (s?.model || s?.activeRuntime?.model) return true;
    if (!settingsStore.modelCfg) await settingsStore.loadModelCfg();
    const mc = settingsStore.modelCfg;
    if (!mc) return true;
    const hasModel = (mc.providers ?? []).some((p) => (p.models ?? []).length > 0);
    if (!hasModel) {
      // 跳设置页会卸载 composer(视图切换重建),即时回填必丢 —— 记模块级
      // 守卫草稿,本面板重连(用户配完模型返回)时恢复。
      guardDraft = payload;
      this.goModelSettings();
      return false;
    }
    s?.log('warn', '尚未选择模型:请在输入框下方「模型」中选择后再发送');
    const c = this.renderRoot.querySelector('goder-composer') as { openModelPicker?(): void } | null;
    c?.openModelPicker?.();
    return false;
  }

  /** 把守卫草稿回填 composer(文本/图片),焦点回输入框。 */
  private restoreDraft(payload: { text: string; images?: string[] }): void {
    const c = this.renderRoot.querySelector('goder-composer') as { setDraft?(t: string, i?: string[]): void } | null;
    c?.setDraft?.(payload.text, payload.images);
  }

  /** 跳到设置的模型分区(先切到设置页再下发分区,两事件均由 app-shell 接)。 */
  private goModelSettings(): void {
    this.fire('goder-open-settings');
    this.fire('goder-settings-section', 'models');
  }

  // composer 策略选择:已有会话即时生效(服务端运行时变更);草稿则随首条消息
  private onPolicyChange(e: CustomEvent<string>): void {
    const sid = this.sid;
    if (sid && !sid.startsWith('draft:')) {
      void this.store!.setSessionPolicy(sid, e.detail);
    } else {
      this.store!.setDraftPolicy(e.detail);
    }
  }

  // composer 模型选择:作为之后回合的请求模型
  private onModelChange(e: CustomEvent<string>): void {
    this.store!.setModel(e.detail);
  }

  // ---------- 用户消息:复制 / 编辑后重新发送 ----------

  private startEdit(it: { kind: 'user'; id: string; text: string }): void {
    this.editingId = it.id;
    this.editDraft = it.text;
    this.updateComplete.then(() => {
      const ta = this.renderRoot.querySelector('.edit-box textarea') as HTMLTextAreaElement | null;
      ta?.focus();
      ta?.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  private cancelEdit(): void {
    this.editingId = undefined;
    this.editDraft = '';
  }

  private commitEdit(): void {
    const text = this.editDraft.trim();
    const editOf = this.editingId;
    this.cancelEdit();
    // 编辑重发:从被编辑消息处截断历史(grf:history),编辑文本作为该回合输入
    if (text) {
      void this.ensureModelReady({ text }).then((ok) => {
        if (ok) void this.store!.send(text, undefined, editOf ? { editOf } : undefined);
      });
    }
  }

  private async copyText(id: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // wails 自定义 scheme 可能非安全上下文:退回 execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        ta.remove();
      }
    }
    this.copiedId = id;
    window.clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => (this.copiedId = undefined), 1500);
  }

  private onAskAnswer(e: CustomEvent<{ callId: string; answers: Record<string, unknown> }>): void {
    void this.store!.answerAsk(e.detail.callId, e.detail.answers);
  }

  private onAskDismiss(e: CustomEvent<{ callId: string }>): void {
    void this.store!.dismissAsk(e.detail.callId);
  }

  private onApprove(e: CustomEvent<{ callId: string; approved: boolean; feedback?: string }>): void {
    void this.store!.answerApproval(e.detail.callId, e.detail.approved, e.detail.feedback);
  }
}

/** 技能名归一化为目录安全名:小写、空白与非法字符转连字符、去首尾连字符
 * (~/.grf/skills 下的技能目录名);归一后为空返回空串。 */
function skillDirName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-chat': GoderChat;
  }
}
