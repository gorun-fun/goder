// chat-panel.ts — <grf-chat>:主体工作面板(黑色圆角卡片)。
// 消息流(经 messages.ts 渲染)+ composer;右栏 tab 与底栏 tab 的条目
// 全部来自 registry(registry/registry.ts)—— 内置(详情/审查/终端/浏览
// 器/文件/事件台)与三方自定义条目走同一条渲染路径,宿主可自由增删。
// 右栏直通卡片底部;底栏(多 tab,常驻保活)只占聊天列宽度。头部空白
// 区为窗口拖拽区。可独立嵌入,也可放进 <grf-app-shell> 组成完整布局;
// 右栏 tab 状态由 app-shell 受控下发(经 grf-side-tab-open/close/activate
// 事件,载荷为 SideTabInstance)。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { modelContextWindow } from '../../util/modelctx';
import { icon } from '../../util/icons';
import { makeTitleDrag, type TitleDrag } from '../../util/titledrag';
import { inWails, gitStatus, type GitStatusDTO } from '../../host/bridge';
import type { AskItem } from '../../core/model/chat-model';
import { settingsStore } from '../../core/settings/settings-store';
import { registry, sideTabId, type PanelContext, type SideTabDef, type SideTabInstance, type BottomTabDef } from '../../registry/registry';
import './composer';
import './status-pop';
import { renderItem, renderChatNav, cnavWave, cnavReset, type MessageViewProps } from './messages';

/** 底栏 tab 实例(每个 tab 一个独立元素,按会话分组常驻保活) */
interface BottomTabInstance {
  uid: string;
  defId: string;
  el: HTMLElement;
}

/** 被模型守卫拦截的输入(模块级:跳设置-模型页会卸载 composer 甚至本
 * 面板,视图切回、面板重连时恢复,用户配完模型回来输入不丢)。 */
let guardDraft: { text: string; images?: string[] } | null = null;

@customElement('grf-chat')
export class GrfChat extends GrfPanel {
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
  /** 右栏当前激活的 tab id */
  @property({ type: String }) activeSideTab = '';
  /** 左栏收起时头部左上角显示左边栏开关(展开时开关在左栏顶行) */
  @property({ type: Boolean, attribute: 'left-toggle' }) leftToggle = false;
  /** 左栏当前展开态 */
  @property({ type: Boolean }) leftOn = true;
  /** macOS 桌面态:左栏收起时头部为红绿灯保留悬浮位 */
  @property({ type: Boolean, attribute: 'left-lights' }) leftLights = false;
  /** 无边框桌面平台(Windows/Linux):头部右上为壳自绘的窗口控制
   * (最小化/最大化/关闭)留位 */
  @property({ type: Boolean, attribute: 'win-controls' }) winControls = false;

  @state() private stickBottom = true;
  /** 聊天列过窄(右栏/窗口挤压):状态浮窗自动收成单行,避免盖住对话内容 */
  @state() private colNarrow = false;
  /** 聊天列窄阈值(px):低于即自动收缩浮窗 */
  private static readonly NARROW_AT = 560;
  /** 聊天列宽度观察(浮窗自动收缩用) */
  private colRo: ResizeObserver | null = null;
  /** 当前项目 git 状态(状态浮窗用;null = 未取到/不适用) */
  @state() private git: GitStatusDTO | null = null;
  /** 内嵌底栏高度(可拖) */
  @state() private bottomHeight = 220;
  /** 右栏宽度(用户拖拽后固定;null = 按 tab 默认宽) */
  @state() private sideWidth: number | null = null;
  /** 右栏 "+" 类型菜单展开态 */
  @state() private sideMenuOpen = false;
  /** "+" 菜单定位:菜单左上角对齐加号左缘(距 .tabs-head 左侧的像素数) */
  @state() private sideMenuLeft = 0;
  /** 底栏 "+" 类型菜单展开态(可用底栏条目 >1 时) */
  @state() private bottomMenuOpen = false;
  /** 底栏当前会话的 tab 实例列表(激活切换保活) */
  @state() private bottomTabs: BottomTabInstance[] = [];
  /** 底栏当前激活的 tab uid */
  @state() private bottomActiveId = '';
  /** 编辑中的用户消息 id 与草稿(编辑后重新发送) */
  @state() private editingId?: string;
  @state() private editDraft = '';
  /** 刚复制成功的消息 id(图标短暂变为 ✓) */
  @state() private copiedId?: string;
  private copiedTimer = 0;
  /** 显式展开过的思考块 id */
  private reasoningOpen = new Set<string>();
  /** 设置页模型配置订阅(模型下拉数据源) */
  private settingsUnsub?: () => void;
  /** registry 变更(三方增删条目)即时反映 */
  private regUnsub?: () => void;

  /** 头部空白区为窗口拖拽区(移动/双击缩放;非桌面态静默) */
  private tdrag: TitleDrag | null = null;
  private dragging: 'bottom' | 'side' | null = null;
  /** 返回 HTMLElement 的右栏条目(终端等有状态内容)按 (tab id, 会话)
   * 池化保活:跨 tab 开关与会话切换不销毁元素 */
  private sideElPool = new Map<string, Map<string, HTMLElement>>();
  /** sid → 底栏 tab 组(各会话独立,常驻 DOM 保活) */
  private bottomTabsBySid = new Map<string, BottomTabInstance[]>();
  /** sid → 底栏当前激活的 tab uid */
  private bottomActiveBySid = new Map<string, string>();
  /** 底/右栏内容当前归属的会话('' = 尚未绑定;检测 sid 切换) */
  private poolSid = '';
  private bottomSeq = 0;
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
        /* 黑色圆角主面板(浅色主题经 --grf-card 覆写);底部拉通到窗口
         * 底,只保留上侧圆角 */
        background: var(--grf-card);
        border-radius: 12px 12px 0 0;
        overflow: hidden;
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        color: var(--grf-text);
        height: 100%;
      }
      header {
        display: flex;
        align-items: center;
        gap: 10px;
        /* 固定与左栏顶行同高(40px),分隔线对齐;内容垂直居中 */
        height: 40px;
        padding: 0 14px;
        box-sizing: border-box;
        border-bottom: 1px solid var(--grf-border);
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
      .cols {
        flex: 1;
        min-height: 0;
        display: flex;
      }
      .col-main {
        flex: 1;
        /* 状态浮窗(position:absolute)的定位基准:锚在聊天列右上 */
        position: relative;
        /* 右栏打开时保底宽度:避免宽 tab 把聊天列与底部输入框挤成一条缝 */
        min-width: min(340px, 45%);
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      /* 右栏拖拽条:常显一条灰线作为与聊天区的分界,悬停提亮一档 */
      .gutter-side {
        flex: none;
        width: 4px;
        cursor: col-resize;
        position: relative;
      }
      /* 命中区左右各扩 5px:4px 线太细,浏览器 iframe 贴线时几乎点不中 */
      .gutter-side::before {
        content: '';
        position: absolute;
        inset: 0 -5px;
      }
      .gutter-side::after {
        content: '';
        position: absolute;
        inset: 0 1.5px;
        background: var(--grf-border-soft);
      }
      /* 拖拽中:禁用右栏内嵌元素的指针事件(尤其浏览器 iframe) */
      :host(.dragging) .side,
      :host(.dragging) .bt-pane {
        pointer-events: none;
      }
      :host(.dragging) {
        cursor: col-resize;
      }
      .gutter-side:hover::after {
        background: var(--grf-border-hover);
      }
      .gutter-side.off {
        display: none;
      }
      .side {
        flex: 0 1 auto;
        min-width: 0;
        max-width: 65%;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .side.off {
        display: none;
      }
      /* tab 行外包一层定位容器:下拉菜单不能放在 .side-tabs 内 ——
       * 该行横向滚动会把 absolute 子元素裁掉 */
      .tabs-head {
        flex: none;
        position: relative;
      }
      .side-tabs {
        flex: none;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 5px 6px 0;
        border-bottom: 1px solid var(--grf-border);
        user-select: none;
        min-height: 32px;
        /* 文件 tab(相对路径标题)可能很多/很长:tab 行横向滚动 */
        overflow-x: auto;
        overflow-y: hidden;
      }
      .stab .stab-t {
        max-width: 170px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stab {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 8px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        border-bottom: 2px solid transparent;
        cursor: pointer;
        border-radius: 4px 4px 0 0;
      }
      .stab:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
      }
      /* 激活 tab:白字白下划线,不用强调色 */
      .stab.on {
        color: var(--grf-text);
        border-bottom-color: var(--grf-text);
      }
      .stab svg {
        width: 12px;
        height: 12px;
        flex: none;
      }
      .stab .x {
        display: none;
        border: none;
        background: transparent;
        padding: 0 0 0 2px;
        color: var(--grf-text-faint);
        cursor: pointer;
      }
      .stab .x svg {
        width: 10px;
        height: 10px;
      }
      .stab:hover .x {
        display: inline-flex;
      }
      .stab .x:hover {
        color: var(--grf-error);
      }
      .stab.add {
        color: var(--grf-text-faint);
        border-bottom-color: transparent;
      }
      .side-menu {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 30;
        background: var(--grf-bg-raise);
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        box-shadow: var(--grf-shadow);
        padding: 4px;
        min-width: 160px;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .side-menu .mi {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        user-select: none;
      }
      .side-menu .mi:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .side-menu .mi svg {
        width: 12px;
        height: 12px;
        flex: none;
      }
      .side-menu .mitag {
        margin-left: auto;
        color: var(--grf-text-faint);
        font-size: 10px;
      }
      /* 右栏空态:居中类型入口 */
      .side-empty {
        flex: 1;
        min-height: 0;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 12px;
        padding: 20px;
      }
      .side-empty .hint {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .side-empty .entries {
        display: grid;
        gap: 8px;
      }
      .side-empty .entry {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 8px 14px;
        background: var(--grf-bg-raise);
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-sm);
        cursor: pointer;
        min-width: 176px;
        justify-content: flex-start;
      }
      .side-empty .entry:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
        border-color: var(--grf-border-hover);
      }
      .side-empty .entry svg {
        width: 14px;
        height: 14px;
        flex: none;
      }
      .side-body {
        flex: 1;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .side-body .pane {
        display: none;
      }
      .side-body .pane.on {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        min-width: 0;
      }
      .side-body .pane > * {
        flex: 1;
        min-height: 0;
        min-width: 0;
      }
      /* 内嵌面板融入黑底 */
      .side .pane > grf-session-detail,
      .side .pane > grf-review,
      .side .pane > grf-browser,
      .side .pane > grf-console {
        background: transparent;
        border-left: none;
      }
      /* 底栏拖拽条:常显一条横线作为与聊天区的分界 */
      .gutter-h {
        flex: none;
        height: 4px;
        cursor: row-resize;
        position: relative;
      }
      .gutter-h::after {
        content: '';
        position: absolute;
        inset: 1.5px 0;
        background: var(--grf-border-soft);
      }
      .gutter-h:hover::after {
        background: var(--grf-border-hover);
      }
      .gutter-h.off {
        display: none;
      }
      .bottom {
        flex: none;
        min-height: 90px;
        display: flex;
        flex-direction: column;
      }
      .bottom.off {
        display: none;
      }
      /* 底栏标题行:tab 居左,添加/关闭操作居右 */
      .bt-bar {
        flex: none;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 3px 6px 0;
        user-select: none;
        min-height: 30px;
        overflow-x: auto;
        position: relative;
      }
      .bt-tab {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 9px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        border-bottom: 2px solid transparent;
        cursor: pointer;
        white-space: nowrap;
      }
      .bt-tab:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
      }
      .bt-tab.on {
        color: var(--grf-text);
        border-bottom-color: var(--grf-text);
      }
      .bt-tab svg {
        width: 11px;
        height: 11px;
        flex: none;
      }
      .bt-tab .x {
        display: none;
        border: none;
        background: transparent;
        padding: 0 0 0 2px;
        color: var(--grf-text-faint);
        cursor: pointer;
      }
      .bt-tab .x svg {
        width: 10px;
        height: 10px;
      }
      .bt-tab:hover .x {
        display: inline-flex;
      }
      .bt-tab .x:hover {
        color: var(--grf-error);
      }
      .bt-ops {
        margin-left: auto;
        display: flex;
        gap: 2px;
        flex: none;
        position: sticky;
        right: 0;
      }
      .bt-ops .op {
        padding: 3px 5px;
        border: none;
        background: transparent;
        color: var(--grf-text-faint);
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        display: inline-flex;
      }
      .bt-ops .op:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
      }
      .bt-ops .op svg {
        width: 12px;
        height: 12px;
      }
      /* 底栏 "+" 菜单(可用条目 >1 时):复用右栏菜单样式,锚定 ops 行 */
      .bt-menu {
        position: absolute;
        top: 100%;
        right: 6px;
        z-index: 30;
        background: var(--grf-bg-raise);
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        box-shadow: var(--grf-shadow);
        padding: 4px;
        min-width: 140px;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .bt-menu .mi {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        user-select: none;
      }
      .bt-menu .mi:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .bt-menu .mi svg {
        width: 12px;
        height: 12px;
        flex: none;
      }
      .bt-body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .bt-pane {
        display: none;
      }
      .bt-pane.on {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .bt-pane > * {
        flex: 1;
        min-height: 0;
        background: transparent;
      }
      .title {
        font-weight: 600;
        font-size: var(--grf-font-size);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: 1;
      }
      .chip {
        flex: none;
        font-size: var(--grf-font-size-xs);
        padding: 2px 9px;
        border-radius: 99px;
        border: 1px solid var(--grf-border);
        color: var(--grf-text-dim);
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .chip.waiting {
        color: var(--grf-warn);
        border-color: var(--grf-warn);
        background: var(--grf-warn-soft);
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
        color: var(--grf-text);
        background: var(--grf-bg-active);
      }
      /* 消息区容器:定位基准,承载左侧导航小横线与运行圆环 */
      .msgs-wrap {
        flex: 1;
        min-height: 0;
        display: flex;
        position: relative;
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
        background: var(--grf-border-hover);
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
        background: var(--grf-text);
      }
      .cnav .tick:hover {
        background: var(--grf-text-dim);
      }
      .cnav .tick .tip {
        display: none;
        position: absolute;
        left: 44px;
        top: 50%;
        transform: translateY(-50%);
        width: 250px;
        box-sizing: border-box;
        background: var(--grf-bg-raise);
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        box-shadow: var(--grf-shadow);
        padding: 7px 10px;
        font-size: var(--grf-font-size-xs);
        line-height: 1.5;
        color: var(--grf-text-dim);
        white-space: normal;
        pointer-events: none;
      }
      .cnav .tick:hover .tip {
        display: block;
      }
      .cnav .tip .u {
        color: var(--grf-text);
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
        border: 2px solid var(--grf-border-hover);
        border-top-color: var(--grf-text-dim);
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
        color: var(--grf-text-faint);
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
        color: var(--grf-text-dim);
        font-weight: 600;
      }
      .empty p {
        margin: 0;
        font-size: var(--grf-font-size-sm);
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
        background: var(--grf-user-bubble);
        border: 1px solid var(--grf-border-soft);
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
        color: var(--grf-text-faint);
        padding: 3px;
        border-radius: 5px;
        cursor: pointer;
        display: inline-flex;
      }
      .bop:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
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
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        line-height: 1.6;
        color: var(--grf-text);
        background: var(--grf-bg-raise);
        border: 1px solid var(--grf-border);
        border-radius: 12px;
        padding: 8px 11px;
        outline: none;
        box-sizing: border-box;
      }
      .edit-box textarea:focus {
        border-color: var(--grf-accent);
      }
      .edit-ops {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
        align-items: center;
      }
      .edit-ops .hint {
        margin-right: auto;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
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
        border-radius: var(--grf-radius-sm);
        border: 1px solid var(--grf-border);
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
        border-bottom: 1px solid var(--grf-border-soft);
        padding-bottom: 4px;
      }
      .md h3.md-h { font-size: 14.5px; }
      .md h4.md-h, .md h5.md-h, .md h6.md-h { font-size: 13.5px; }
      .md code {
        font-family: var(--grf-mono);
        font-size: 0.9em;
        background: var(--grf-bg-hover);
        border-radius: 4px;
        padding: 1px 5px;
      }
      .md pre.md-code {
        background: #131418;
        border: 1px solid var(--grf-border-soft);
        border-radius: var(--grf-radius-sm);
        padding: 10px 12px;
        overflow: auto;
        margin: 0 0 8px;
      }
      .md pre.md-code code {
        background: none;
        padding: 0;
        font-size: var(--grf-font-size-xs);
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
        color: var(--grf-accent-text);
      }
      .md blockquote.md-quote {
        margin: 0 0 8px;
        padding: 2px 12px;
        border-left: 3px solid var(--grf-border);
        color: var(--grf-text-dim);
      }
      .md hr.md-hr {
        border: none;
        border-top: 1px solid var(--grf-border);
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
        border: 1px solid var(--grf-border);
        padding: 4px 10px;
        font-size: var(--grf-font-size-sm);
        vertical-align: top;
        text-align: left;
      }
      .md table.md-table th {
        background: var(--grf-bg-hover);
        font-weight: 650;
        white-space: nowrap;
      }
      .cursor {
        display: inline-block;
        width: 7px;
        height: 15px;
        background: var(--grf-accent);
        vertical-align: text-bottom;
        margin-left: 2px;
        animation: pulse 0.9s step-end infinite;
      }
      /* 思考块:无背景,仅左侧细线标识 */
      .reasoning {
        border-left: 2px solid var(--grf-border);
        padding: 6px 11px;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
      }
      .reasoning .rhead {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-xs);
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
        color: var(--grf-text-faint);
        transition: transform 0.15s;
      }
      .reasoning .rhead .chev.open {
        transform: rotate(90deg);
      }
      .reasoning pre {
        margin: 6px 0 0;
        font-family: var(--grf-font);
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
        color: var(--grf-accent-text);
        background: var(--grf-accent-soft);
        border-radius: var(--grf-radius-sm);
        padding: 4px 10px;
        font-size: var(--grf-font-size-sm);
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
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        padding: 2px 2px;
      }
      .notice .k {
        color: var(--grf-text-faint);
        font-family: var(--grf-mono);
        flex: none;
      }
      .notice.goal .k { color: var(--grf-success); }
      .notice.plan .k { color: var(--grf-reasoning); }
      .status {
        text-align: center;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .err {
        border: 1px solid var(--grf-error);
        background: var(--grf-error-soft);
        color: var(--grf-error);
        border-radius: var(--grf-radius-sm);
        padding: 8px 12px;
        font-size: var(--grf-font-size-sm);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .composer-area {
        flex: none;
        max-height: 60%;
        overflow-y: auto;
        padding: 10px 18px 14px;
        background: linear-gradient(to top, var(--grf-card) 65%, transparent);
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
        toggleLeft: () => this.fire('grf-toggle-sessions'),
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
    window.addEventListener('pointermove', this.onResizeDrag);
    window.addEventListener('pointerup', this.stopResizeDrag);
    window.addEventListener('pointerdown', this.onWinPointerDown);
    this.gitTimer = window.setInterval(() => void this.pollGit(), 8000);
    // 模型选择下拉的数据源(桌面态 gh settings.json;幂等,已加载则跳过)
    this.settingsUnsub = settingsStore.subscribe(() => this.requestUpdate());
    void settingsStore.loadModelCfg();
    // registry 变更即时反映(三方增删右栏/底栏条目)
    this.regUnsub = registry.subscribe(() => this.requestUpdate());
    // file-view 的 html「眼睛」:右栏开浏览器 tab 并导航渲染 data URL。
    this.addEventListener('grf-open-browser-url', (e: Event) => {
      const { url } = (e as CustomEvent<{ url: string }>).detail;
      this.fire('grf-side-tab-open', { defId: 'browser' } satisfies SideTabInstance);
      this.fire('grf-show-sidebar');
      void this.updateComplete.then(() => {
        void this.updateComplete.then(() => {
          const b = this.renderRoot.querySelector('grf-browser') as { open?(u: string): void } | null;
          b?.open?.(url);
        });
      });
    });
    // 聊天列宽度观察:窄于阈值自动把状态浮窗收成单行(不遮对话内容)
    this.colRo = new ResizeObserver((es) => {
      const w = es[0]?.contentRect.width ?? 0;
      const narrow = w > 0 && w < GrfChat.NARROW_AT;
      if (narrow !== this.colNarrow) this.colNarrow = narrow;
    });
  }

  protected firstUpdated(): void {
    const el = this.renderRoot.querySelector('.col-main');
    if (el && this.colRo) this.colRo.observe(el);
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    this.colRo?.disconnect();
    this.colRo = null;
    window.removeEventListener('pointermove', this.onResizeDrag);
    window.removeEventListener('pointerup', this.stopResizeDrag);
    window.removeEventListener('pointerdown', this.onWinPointerDown);
    if (this.gitTimer) window.clearInterval(this.gitTimer);
    this.gitTimer = undefined;
    this.settingsUnsub?.();
    this.settingsUnsub = undefined;
    this.regUnsub?.();
    this.regUnsub = undefined;
    this.bottomTabs = [];
    this.bottomActiveId = '';
    this.bottomTabsBySid.clear();
    this.bottomActiveBySid.clear();
    this.sideElPool.clear();
    this.poolSid = '';
    super.disconnectedCallback();
  }

  private onResizeDrag = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const rect = this.getBoundingClientRect();
    if (this.dragging === 'bottom') {
      this.bottomHeight = Math.min(Math.max(rect.bottom - e.clientY, 90), rect.height * 0.7);
    } else {
      // 右栏拖宽:下限 260(右栏自身可用),上限仅保留聊天列最小宽度 300
      // (不再设固定最大宽度)
      this.sideWidth = Math.min(Math.max(rect.right - e.clientX, 260), Math.max(rect.width - 300, 260));
    }
  };

  private stopResizeDrag = (): void => {
    this.dragging = null;
    this.classList.remove('dragging');
  };

  private startResizeDrag(dir: 'bottom' | 'side'): void {
    this.dragging = dir;
    this.classList.add('dragging');
  }

  // "+" 菜单:点击菜单外任意处关闭
  private onWinPointerDown = (e: PointerEvent): void => {
    if (!this.sideMenuOpen && !this.bottomMenuOpen) return;
    const path = e.composedPath();
    const inMenu = [...this.renderRoot.querySelectorAll('.side-menu, .bt-menu')].some((m) => path.includes(m));
    const inAdd = [...this.renderRoot.querySelectorAll('.stab.add, .bt-ops .op')].some((m) => path.includes(m));
    if (!inMenu && !inAdd) {
      this.sideMenuOpen = false;
      this.bottomMenuOpen = false;
    }
  };

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

  // ---------- 会话隔离的元素池(右栏 HTMLElement 条目 + 底栏 tab 组) ----------

  // prunePools 清理已不存在的会话(归档/服务器删除/草稿废弃)的池化内容:
  // 从 map 移除后元素不再渲染,断开即销毁(如 PTY)。
  private prunePools(): void {
    const s = this.store;
    if (!s) return;
    const alive = (sid: string) =>
      sid.startsWith('draft:') ? s.drafts.has(sid) : !!s.index.sessions[sid];
    for (const sid of new Set([...this.bottomTabsBySid.keys(), ...this.sideElPool.keys()])) {
      if (alive(sid) || sid === this.poolSid) continue;
      this.bottomTabsBySid.delete(sid);
      this.bottomActiveBySid.delete(sid);
      this.sideElPool.delete(sid);
    }
  }

  // syncPools 会话切换:换入对应会话的底栏 tab 组。各会话的内容常驻 DOM
  // (隐藏保活),切换会话不中断(如 PTY);底栏展开而新会话还没有 tab
  // 时自动开一个。在 willUpdate 里先于渲染执行,保证渲染取到换入后的组。
  private syncPools(): void {
    this.prunePools();
    const sid = this.sid ?? '';
    if (sid === this.poolSid) return;
    if (this.poolSid) this.bottomActiveBySid.set(this.poolSid, this.bottomActiveId);
    this.poolSid = sid;
    this.bottomTabs = this.bottomTabsBySid.get(sid) ?? [];
    this.bottomActiveId = this.bottomActiveBySid.get(sid) ?? '';
    this.stickBottom = true; // 切换会话:重新吸附底部
    if (this.bottomOn && this.bottomTabs.length === 0) this.addBottomTab();
  }

  protected willUpdate(props: Map<string, unknown>): void {
    super.willUpdate(props);
    this.syncPools();
  }

  protected updated(_props: Map<string, unknown>): void {
    // 底栏展开且没有任何 tab:自动开一个
    if (this.bottomOn && this.bottomTabs.length === 0) {
      this.addBottomTab();
      return;
    }
    // 内容工作目录跟随当前会话的项目(其他会话的 tab 保持各自目录,
    // 不因切换会话被重启;同值赋值为 no-op)
    const cwd = this.store?.activeProjectPath() ?? '';
    this.setCwd(this.sideElPool.get(this.poolSid), cwd);
    for (const t of this.bottomTabs) this.setCwd(t.el, cwd);
    // 流式思考行:内容增长时把滚动位置推到末尾
    for (const el of this.renderRoot.querySelectorAll<HTMLElement>('.reasoning.live .rscroll')) {
      el.scrollLeft = el.scrollWidth;
    }
    // 状态浮窗:项目目录就绪/切换即取 git 状态
    if (cwd && cwd !== this.gitCwd) {
      this.gitCwd = cwd;
      void this.pollGit();
    }
    this.maybeScroll();
  }

  /** 有 cwd 属性的池化元素(终端)同步工作目录。 */
  private setCwd(target: Map<string, HTMLElement> | HTMLElement | undefined, cwd: string): void {
    const targets = target instanceof Map ? [...target.values()] : target ? [target] : [];
    for (const el of targets) {
      if (el && 'cwd' in el) (el as unknown as { cwd: string }).cwd = cwd;
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
    // 会话尚未发过消息时回落服务端回报/默认值
    const curModel = s?.model || rt?.model || settingsStore.modelCfg?.default || '';
    const activeModel = s?.model || rt?.model || '';
    const providers = (settingsStore.modelCfg?.providers ?? []).map((p) => ({
      name: p.name,
      // models 判空:Go 侧 nil 切片序列化为 null,直接展开会抛 TypeError
      // 冻结整个聊天面板(会话点不开/三栏开关失效)。
      // 菜单项必须带 provider/ 前缀:gh server 的 trySwitchModel 只认
      // "provider/model" 全名,裸模型名会被忽略(切换不生效)
      models: (p.models ?? []).map((m) => `${p.name}/${m}`),
    }));
    // 服务端回报的 model 是裸名,补 provider 前缀对齐菜单项(勾选态匹配)
    const toFull = (m: string): string =>
      m && !m.includes('/') ? (providers.flatMap((g) => g.models).find((x) => x.endsWith(`/${m}`)) ?? m) : m;
    const curFull = toFull(curModel);
    const activeFull = toFull(activeModel);
    if (curFull && !providers.some((g) => g.models.includes(curFull))) {
      providers.push({ name: '当前模型', models: [curFull] });
    }
    // 上下文窗口按会话实际模型估算(圆环分母)
    const contextWindow = modelContextWindow(rt?.model || curModel || undefined);
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
                    <button class="ghost tg" title="展开侧栏" @click=${() => this.fire('grf-toggle-sessions')}>${unsafeHTML(icon.panelLeft)}</button>
                  </span>`
                : nothing}
              <span class="title" title=${title}>${title || '未选择会话'}</span>
              ${waiting ? html`<span class="chip waiting"><span class="dot"></span>等待输入</span>` : nothing}
              <span class="actions">
                ${showBottomToggle
                  ? html`<button
                      class="ghost tg ${this.bottomOn ? 'on' : ''}"
                      title=${bottomDefs[0].label}
                      @click=${() => this.fire('grf-toggle-bottom')}
                    >
                      ${unsafeHTML(bottomDefs[0].icon)}
                    </button>`
                  : nothing}
                ${showSidebarToggle
                  ? html`<button class="ghost tg ${this.sidebarOn ? 'on' : ''}" title="右栏面板" @click=${() => this.fire('grf-toggle-sidebar')}>${unsafeHTML(icon.panelRight)}</button>`
                  : nothing}
              </span>
            </header>
          `}
      <div class="cols">
        <div class="col-main">
          <grf-status-pop scope=${this.scope} .git=${this.git} .narrow=${this.colNarrow}></grf-status-pop>
          <div class="msgs-wrap">
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
                    <grf-composer
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
                      .usageModel=${rt?.model ?? ''}
                      .stats=${rt?.stats ?? null}
                      .contextWindow=${contextWindow}
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
                    ></grf-composer>
                  </div>
                </div>
              `}
          ${this.renderBottom(bottomDefs)}
        </div>
        ${showSidebarToggle ? this.renderSide() : nothing}
      </div>
    `;
  }

  // ---------- 消息流渲染回调(messages.ts 的宿主实现) ----------

  private get msgProps(): MessageViewProps {
    return {
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
    };
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
        <h3>新会话</h3>
        <p>发第一条消息开始对话。首条消息将决定会话标题;项目默认策略(policy / system_prompt 等)随首条消息生效。</p>
      </div>`;
    }
    return html`<div class="empty">
      <div class="big">${unsafeHTML(icon.chat)}</div>
      <h3>${s.connState === 'error' ? '无法连接 gh server' : '选择或新建一个会话'}</h3>
      <p>
        ${s.connState === 'error'
          ? html`连接失败:${s.connError ?? '未知错误'}。请检查服务配置或登录状态。`
          : '在左侧选择一个项目的会话,或点击项目上的 + 新建。'}
      </p>
    </div>`;
  }

  // ---------- 底栏(多 tab,仅占聊天列宽度;右栏独立通到底部) ----------

  private activateBottomTab(uid: string): void {
    this.bottomActiveId = uid;
    this.bottomActiveBySid.set(this.poolSid, uid);
  }

  private renderBottom(bottomDefs: BottomTabDef[]) {
    if (!this.bottomToggle || bottomDefs.length === 0) return nothing;
    return html`
      <div class="gutter-h ${this.bottomOn ? '' : 'off'}" @pointerdown=${() => this.startResizeDrag('bottom')}></div>
      <div class="bottom ${this.bottomOn ? '' : 'off'}" style="height:${this.bottomHeight}px">
        <div class="bt-bar">
          ${this.bottomTabs.map((t) => {
            const def = registry.bottom.get(t.defId);
            if (!def) return nothing;
            const n = this.bottomTabs.filter((x) => x.defId === t.defId).indexOf(t) + 1;
            const label = def.titleFor?.(n) ?? `${def.label} ${n}`;
            return html`
              <span
                class="bt-tab ${this.bottomActiveId === t.uid ? 'on' : ''}"
                title=${label}
                @click=${() => this.activateBottomTab(t.uid)}
              >
                ${unsafeHTML(def.icon)}<span>${label}</span>
                <button
                  class="x"
                  title=${`关闭 ${label}`}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.closeBottomTab(t.uid);
                  }}
                >
                  ${unsafeHTML(icon.close)}
                </button>
              </span>
            `;
          })}
          <span class="bt-ops">
            ${bottomDefs.length > 1
              ? html`<button class="op" title="新建底栏 tab" @click=${() => (this.bottomMenuOpen = !this.bottomMenuOpen)}>${unsafeHTML(icon.plus)}</button>`
              : html`<button class="op" title=${`新建${bottomDefs[0].label}`} @click=${() => this.addBottomTab()}>${unsafeHTML(icon.plus)}</button>`}
            <button class="op" title="收起底栏" @click=${() => this.fire('grf-toggle-bottom')}>${unsafeHTML(icon.close)}</button>
          </span>
          ${this.bottomMenuOpen
            ? html`
                <div class="bt-menu">
                  ${bottomDefs.map(
                    (d) => html`
                      <div
                        class="mi"
                        @click=${() => {
                          this.bottomMenuOpen = false;
                          this.addBottomTab(d.id);
                        }}
                      >
                        ${unsafeHTML(d.icon)}
                        <span>${d.label}</span>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}
        </div>
        <div class="bt-body">
          <!-- 所有会话的 tab pane 常驻 DOM 保活(隐藏),仅当前会话的激活
               tab 可见;tab 行只展示当前会话的 tab -->
          ${[...this.bottomTabsBySid.entries()].map(([sid, tabs]) =>
            tabs.map(
              (t) =>
                html`<div class="bt-pane ${sid === this.poolSid && this.bottomActiveId === t.uid ? 'on' : ''}">${t.el}</div>`,
            ),
          )}
        </div>
      </div>
    `;
  }

  /** addBottomTab 新开一个底栏 tab 并激活(归入当前会话的 tab 组)。 */
  private addBottomTab(defId?: string): void {
    const ctx = this.refreshCtx();
    const defs = registry.bottom.visible(ctx);
    const def = (defId ? defs.find((d) => d.id === defId) : undefined) ?? defs[0];
    if (!def) return;
    const el = def.create(ctx);
    const uid = `bt${++this.bottomSeq}`;
    this.bottomTabs = [...this.bottomTabs, { uid, defId: def.id, el }];
    this.bottomTabsBySid.set(this.poolSid, this.bottomTabs);
    this.bottomActiveId = uid;
    this.bottomActiveBySid.set(this.poolSid, uid);
  }

  /** closeBottomTab 关闭指定 tab(移除即销毁其内容);关掉最后一个时
   * 收起底栏,重新展开会自动新开一个。 */
  private closeBottomTab(uid: string): void {
    const idx = this.bottomTabs.findIndex((t) => t.uid === uid);
    if (idx < 0) return;
    const next = this.bottomTabs.filter((_, i) => i !== idx);
    this.bottomTabs = next;
    this.bottomTabsBySid.set(this.poolSid, next);
    if (next.length === 0) {
      this.bottomActiveId = '';
      this.bottomActiveBySid.set(this.poolSid, '');
      this.fire('grf-toggle-bottom'); // 最后一个关掉:整栏收起
      return;
    }
    if (this.bottomActiveId === uid) {
      this.bottomActiveId = next[Math.min(idx, next.length - 1)].uid;
      this.bottomActiveBySid.set(this.poolSid, this.bottomActiveId);
    }
  }

  // ---------- 右栏 tab 系统(registry 驱动) ----------

  /** 当前环境可用的右栏条目。 */
  private sideDefs(): SideTabDef[] {
    return registry.side.visible(this.refreshCtx());
  }

  /** 取(懒建)某会话、某 tab 的保活元素;仅 render 返回 HTMLElement 的
   * 条目走池化(终端等有状态内容),模板条目返回 null。 */
  private pooledSideEl(def: SideTabDef, key: string | undefined, sid: string): HTMLElement | null {
    const tabId = key !== undefined ? `${def.id}:${key}` : def.id;
    let bySid = this.sideElPool.get(tabId);
    if (!bySid) {
      bySid = new Map();
      this.sideElPool.set(tabId, bySid);
    }
    let el = bySid.get(sid);
    if (!el) {
      const out = def.render(this.refreshCtx(), key);
      if (!(out instanceof HTMLElement)) return null; // 模板条目不走池化
      el = out;
      bySid.set(sid, el);
    }
    return el;
  }

  private renderSide() {
    const ctx = this.refreshCtx();
    const defs = this.sideDefs();
    // 打开的 tab 过滤到仍可用的条目(条目被 hide 后其 tab 不再渲染)
    const tabs = this.sideTabs.filter((t) => defs.some((d) => d.id === t.defId));
    const activeInst = tabs.find((t) => sideTabId(t) === this.activeSideTab);
    const activeDef = activeInst ? defs.find((d) => d.id === activeInst.defId) : undefined;
    const width = this.sideWidth ?? activeDef?.width ?? 300;
    const on = this.activeSideTab;
    const sid = this.poolSid || this.sid || '';

    return html`
      <div class="gutter-side ${this.sidebarOn ? '' : 'off'}" @pointerdown=${() => this.startResizeDrag('side')}></div>
      <aside class="side ${this.sidebarOn ? '' : 'off'}" style="width:${width}px">
        ${this.renderTabBar(tabs, defs)}
        <div class="side-body">
          ${tabs.map((t) => {
            const def = defs.find((d) => d.id === t.defId)!;
            const cls = on === sideTabId(t) ? 'on' : '';
            // 池化条目:所有会话的元素常驻 DOM(隐藏保活),仅当前会话可见;
            // 模板条目:每次渲染重建(轻量内容)
            const el = this.pooledSideEl(def, t.key, sid);
            return html`<div class="pane ${cls}">${el ?? def.render(ctx, t.key)}</div>`;
          })}
        </div>
      </aside>
    `;
  }

  // tabLabel 实例标题:显式 title > 条目 titleFor > 条目 label。
  private tabLabel(t: SideTabInstance, defs: SideTabDef[]): string {
    const def = defs.find((d) => d.id === t.defId);
    if (!def) return t.defId;
    return t.title ?? def.titleFor?.(t.key) ?? def.label;
  }

  // toggleSideMenu 开"+"菜单:打开时实测加号位置,菜单左上角对齐加号
  // 左缘(tab 行可横向滚动,加号位置不固定)。右侧空间不足时向左收。
  private toggleSideMenu(): void {
    if (this.sideMenuOpen) {
      this.sideMenuOpen = false;
      return;
    }
    const add = this.renderRoot.querySelector('.stab.add') as HTMLElement | null;
    if (add) {
      const head = this.renderRoot.querySelector('.tabs-head') as HTMLElement | null;
      const max = head ? head.clientWidth - 170 : add.offsetLeft;
      this.sideMenuLeft = Math.max(0, Math.min(add.offsetLeft, max));
    }
    this.sideMenuOpen = true;
  }

  // renderTabBar 右栏顶部 tab 栏;无已开 tab 时显示居中类型入口。
  private renderTabBar(tabs: SideTabInstance[], defs: SideTabDef[]) {
    if (tabs.length === 0) {
      return html`
        <div class="side-empty">
          <div class="hint">选择要打开的面板</div>
          <div class="entries">
            ${defs.map(
              (d) => html`
                <button class="entry" title=${`打开${d.label}`} @click=${() => this.fire('grf-side-tab-open', { defId: d.id } satisfies SideTabInstance)}>
                  ${unsafeHTML(d.icon)}
                  <span>${d.label}</span>
                </button>
              `,
            )}
          </div>
        </div>
      `;
    }
    return html`
      <div class="tabs-head">
        <div class="side-tabs">
          ${tabs.map((t) => {
            const def = defs.find((d) => d.id === t.defId)!;
            const tid = sideTabId(t);
            const label = this.tabLabel(t, defs);
            return html`
              <span class="stab ${this.activeSideTab === tid ? 'on' : ''}" title=${label} @click=${() => this.fire('grf-side-tab-activate', tid)}>
                ${unsafeHTML(def.icon)}
                <span class="stab-t">${label}</span>
                <button
                  class="x"
                  title=${`关闭${label}`}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.fire('grf-side-tab-close', tid);
                  }}
                >
                  ${unsafeHTML(icon.close)}
                </button>
              </span>
            `;
          })}
          <span class="stab add" title="打开其他面板" @click=${() => this.toggleSideMenu()}>${unsafeHTML(icon.plus)}</span>
        </div>
        ${this.sideMenuOpen
          ? html`
              <div class="side-menu" style=${`left:${this.sideMenuLeft}px`}>
                ${defs.map(
                  (d) => html`
                    <div
                      class="mi"
                      @click=${() => {
                        this.sideMenuOpen = false;
                        this.fire('grf-side-tab-open', { defId: d.id } satisfies SideTabInstance);
                      }}
                    >
                      ${unsafeHTML(d.icon)}
                      <span>${d.label}</span>
                      ${tabs.some((t) => t.defId === d.id && !d.multi) ? html`<span class="mitag">已打开</span>` : nothing}
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  // ---------- composer 事件 ----------

  private onSend(e: CustomEvent<{ text: string; images?: string[] }>): void {
    const payload = e.detail;
    void this.ensureModelReady(payload).then((ok) => {
      if (ok) void this.store!.send(payload.text, payload.images);
    });
  }

  /** 模型守卫(异步):本端已选模型或当前会话有实际模型时直接放行;
   * 否则确认 gh 侧还有可用模型 —— 全无可用模型时发送只会收到服务端报错,
   * 不如直接带用户去设置的模型页完成配置,并把输入记为守卫草稿(跳设置
   * 页会卸载 composer,本面板重连时恢复,防止输入丢失)。
   * 桌面判 gh 侧默认模型;网页/嵌入态判"有任何可用模型"(与启动守卫
   * guardModelSetup 同一判据,网页形态 gh 配置懒加载,守卫时补拉一次)。
   * gh 配置读取失败(modelCfg 为 null)视为未知、不拦截,维持直接发送。 */
  private async ensureModelReady(payload: { text: string; images?: string[] }): Promise<boolean> {
    const s = this.store;
    if (s?.model || s?.activeRuntime?.model) return true;
    if (inWails()) {
      return !!(settingsStore.cfg?.defaultModel || settingsStore.modelCfg?.default);
    }
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
    return true;
  }

  /** 把守卫草稿回填 composer(文本/图片),焦点回输入框。 */
  private restoreDraft(payload: { text: string; images?: string[] }): void {
    const c = this.renderRoot.querySelector('grf-composer') as { setDraft?(t: string, i?: string[]): void } | null;
    c?.setDraft?.(payload.text, payload.images);
  }

  /** 跳到设置的模型分区(先切到设置页再下发分区,两事件均由 app-shell 接)。 */
  private goModelSettings(): void {
    this.fire('grf-open-settings');
    this.fire('grf-settings-section', 'models');
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

declare global {
  interface HTMLElementTagNameMap {
    'grf-chat': GrfChat;
  }
}
