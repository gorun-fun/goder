// chat-panel.ts — <grf-chat>:主体工作面板(黑色圆角卡片)。
// 消息流(用户/助手/思考/工具/通知/交互卡片)+ composer;右栏(tab 化:
// 详情/审查/终端/浏览器,由头部开关控制显隐)直通卡片底部;底部内嵌
// 终端(多终端 tab,标题行右侧提供添加/关闭)只占聊天列宽度,不与右栏
// 重叠。头部空白区为窗口拖拽区。可独立嵌入,也可放进 <grf-app-shell>
// 组成完整桌面布局。右栏 tab 状态由 app-shell 受控下发(经
// grf-side-tab-open/close/activate 事件)。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls, panelRegistered } from '../../ui/base';
import { renderMarkdown } from '../../util/markdown';
import { truncate, fmtTokens } from '../../util/fmt';
import { icon } from '../../util/icons';
import { makeTitleDrag, type TitleDrag } from '../../util/titledrag';
import { inWails, gitStatus, type GitStatusDTO } from '../../host/bridge';
import type { AskItem, ChatItem } from '../../state/chat-model';
import './tool-card';
import './ask-form';
import './approval-card';
import './composer';
import '../sidebar';
import '../review';
import '../browser';
import '../file-view';

/** 右栏 tab 类型:面板类型 tab + 逐文件 tab(file:<绝对路径>) */
export type SidePanelTab = 'detail' | 'review' | 'terminal' | 'browser' | `file:${string}`;

/** 面板类型 tab(文件 tab 之外的固定类型) */
export type SidePanelKind = 'detail' | 'review' | 'terminal' | 'browser' | 'file';

/** 右栏 tab 元数据:展示名/图标/默认宽度(用户拖拽后覆盖) */
const SIDE_TAB_META: Record<SidePanelKind, { label: string; icon: string; width: number }> = {
  detail: { label: '详情', icon: icon.info, width: 300 },
  review: { label: '审查', icon: icon.gitBranch, width: 380 },
  terminal: { label: '终端', icon: icon.terminal, width: 460 },
  browser: { label: '浏览器', icon: icon.globe, width: 560 },
  file: { label: '文件', icon: icon.file, width: 520 },
};

/** 右栏文件 tab 对应的已打开文件(app-shell 受控下发) */
export interface FileTab {
  path: string;
  name: string;
  /** 项目内相对路径(tab/标题展示) */
  rel: string;
}

@customElement('grf-chat')
export class GrfChat extends GrfPanel {
  /** 隐藏头部(嵌入态由宿主自绘头部时) */
  @property({ type: Boolean, attribute: 'no-header' }) noHeader = false;
  /** 隐藏 composer(纯展示态) */
  @property({ type: Boolean, attribute: 'no-composer' }) noComposer = false;
  /** 头部右侧显示底栏(终端)开关(app-shell 装配且终端面板可用时开启) */
  @property({ type: Boolean, attribute: 'bottom-toggle' }) bottomToggle = false;
  /** 头部右侧显示右栏开关(app-shell 装配时开启) */
  @property({ type: Boolean, attribute: 'sidebar-toggle' }) sidebarToggle = false;
  /** 底栏当前展开态(仅开关着色与底栏显隐用;终端会话保活,不销毁) */
  @property({ type: Boolean }) bottomOn = false;
  /** 右栏当前展开态(收起时右栏隐藏,内部 tab 会话保活) */
  @property({ type: Boolean }) sidebarOn = false;
  /** 右栏已打开的 tab(有序;空 = 显示类型入口页) */
  @property({ type: Array }) sideTabs: SidePanelTab[] = [];
  /** 右栏当前激活的 tab */
  @property({ type: String }) activeSideTab: SidePanelTab = 'detail';
  /** 左栏收起时头部左上角显示左边栏开关(展开时开关在左栏顶行) */
  @property({ type: Boolean, attribute: 'left-toggle' }) leftToggle = false;
  /** 左栏当前展开态 */
  @property({ type: Boolean }) leftOn = true;
  /** macOS 桌面态:左栏收起时头部为红绿灯保留悬浮位 */
  @property({ type: Boolean, attribute: 'left-lights' }) leftLights = false;
  /** 右栏已打开的文件(每个文件一个 tab;app-shell 受控下发) */
  @property({ type: Array }) fileTabs: FileTab[] = [];

  @state() private stickBottom = true;
  /** 状态浮窗收缩态(单行只显示 git 行级变更);浮窗本身自动显示:
   * 有 git/todo 内容才渲染,无内容不出现(无手动开关) */
  @state() private statusCollapsed = false;
  /** 当前项目 git 状态(状态浮窗用;null = 未取到/不适用) */
  @state() private git: GitStatusDTO | null = null;
  @state() private gitErr = '';
  /** 内嵌底栏终端高度(可拖) */
  @state() private bottomHeight = 220;
  /** 右栏宽度(用户拖拽后固定;null = 按 tab 默认宽) */
  @state() private sideWidth: number | null = null;
  /** 右栏 "+" 类型菜单展开态 */
  @state() private sideMenuOpen = false;
  /** 底栏终端 tab 列表(多终端;元素常驻,激活切换保活) */
  @state() private bottomTerms: Array<{ id: string; el: HTMLElement }> = [];
  /** 底栏当前激活的终端 tab */
  @state() private bottomActiveId = '';
  /** 编辑中的用户消息 id 与草稿(编辑后重新发送) */
  @state() private editingId?: string;
  @state() private editDraft = '';
  /** 刚复制成功的消息 id(图标短暂变为 ✓) */
  @state() private copiedId?: string;
  private copiedTimer = 0;

  /** 头部空白区为窗口拖拽区(移动/双击缩放;非桌面态静默) */
  private tdrag: TitleDrag | null = null;
  private dragging: 'bottom' | 'side' | null = null;
  /** 右栏内嵌终端元素缓存(跨渲染复用,保持 PTY 会话存活) */
  private sideTermEl: HTMLElement | null = null;
  private bottomSeq = 0;
  /** git 状态轮询计时器;仅浮窗展开时真正请求 */
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
        /* 状态浮窗(position:absolute)的定位基准 */
        position: relative;
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
        /* 与面板同黑,仅一条灰色像素线与内容分隔 */
        border-bottom: 1px solid var(--grf-border);
        flex: none;
        min-width: 0;
        user-select: none;
      }
      /* macOS 左栏收起时:窗口红绿灯悬浮于卡片左上,头部左侧让位 */
      header.lights {
        padding-left: 80px;
      }
      .cols {
        flex: 1;
        min-height: 0;
        display: flex;
      }
      .col-main {
        flex: 1;
        /* 右栏打开时保底宽度:避免宽 tab(浏览器 560 / 终端 460)把聊天列
         * 与底部输入框挤成一条缝、内容溢出到右栏下面 */
        min-width: min(340px, 45%);
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      /* 右栏拖拽条:默认隐形,悬停亮出强调色;分界线由相邻元素承担,
       * 避免双线 */
      .gutter-side {
        flex: none;
        width: 4px;
        cursor: col-resize;
        position: relative;
      }
      .gutter-side::after {
        content: '';
        position: absolute;
        inset: 0 1.5px;
        background: transparent;
      }
      .gutter-side:hover::after {
        background: var(--grf-accent);
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
      .side-tabs {
        flex: none;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 5px 6px 0;
        border-bottom: 1px solid var(--grf-border);
        position: relative;
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
      .stab.on {
        color: var(--grf-accent-text);
        border-bottom-color: var(--grf-accent);
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
        right: 6px;
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
      .side grf-sidebar,
      .side grf-review,
      .side grf-browser {
        background: transparent;
        border-left: none;
      }
      /* 底栏拖拽条:常显一条横线作为与聊天区的分界,悬停亮出强调色 */
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
        background: var(--grf-accent);
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
      /* 底栏标题行:终端 tab 居左,添加/关闭操作居右;与内容的分隔线
       * 不画(tab 行与终端输出直接衔接,分界由上方拖拽条横线承担) */
      .bt-bar {
        flex: none;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 3px 6px 0;
        user-select: none;
        min-height: 30px;
        overflow-x: auto;
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
        color: var(--grf-accent-text);
        border-bottom-color: var(--grf-accent);
      }
      .bt-tab svg {
        width: 11px;
        height: 11px;
        flex: none;
      }
      /* tab 自带的关闭按钮:悬停显示(与右栏 tab 一致) */
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
      /* 内嵌终端透明融进黑卡 */
      .bt-pane grf-terminal {
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
      .chip.running {
        color: var(--grf-accent-text);
        border-color: var(--grf-accent);
        background: var(--grf-accent-soft);
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
      .chip.running .dot {
        animation: pulse 1.2s ease-in-out infinite;
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
      .tg.on {
        color: var(--grf-accent-text);
        background: var(--grf-accent-soft);
      }
      .msgs {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 16px 18px 10px;
        min-height: 0;
      }
      .inner {
        max-width: 860px;
        margin: 0 auto;
        display: grid;
        gap: 14px;
      }
      /* 消息条目允许收缩到容器宽度:否则长代码行/长串的 min-content
       * 会把整列撑宽,再被 .msgs 的 overflow-x:hidden 裁掉(看上去被截断) */
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

      /* 用户消息:气泡靠右,最大宽度 80%;复制/编辑悬停露出(气泡右下) */
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
        /* 长串(URL/hash/路径)也强制换行,保证多行展示不被撑出气泡 */
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
      /* 助手流式生成中的轻提示 */
      .msg-assistant .gen {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        margin-top: 2px;
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
        /* 代码块随窗口宽度换行,不做横向截断 */
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
      .cursor {
        display: inline-block;
        width: 7px;
        height: 15px;
        background: var(--grf-accent);
        vertical-align: text-bottom;
        margin-left: 2px;
        animation: pulse 0.9s step-end infinite;
      }

      /* 思考块:无背景,仅左侧细线标识(中性灰,不用紫色) */
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
      /* 展开指示:右向大于号,展开后转 90°(向下) */
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
        /* 可操作错误提示带换行,按原文展示 */
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      /* todo 面板(内嵌展示) */
      .todos {
        border: 1px solid var(--grf-border-soft);
        border-radius: var(--grf-radius);
        background: var(--grf-bg-raise);
        padding: 8px 12px;
        font-size: var(--grf-font-size-sm);
      }
      .todos .tt {
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
        margin-bottom: 5px;
        letter-spacing: 0.4px;
      }
      .todos .todo {
        display: flex;
        gap: 8px;
        align-items: baseline;
        padding: 2px 0;
      }
      .todos .todo .box {
        flex: none;
        width: 13px;
        height: 13px;
        border: 1px solid var(--grf-text-faint);
        border-radius: 3px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 2px;
      }
      .todos .todo.completed .box {
        background: var(--grf-success);
        border-color: var(--grf-success);
      }
      .todos .todo.completed .box svg {
        width: 9px;
        height: 9px;
        color: #0c2817;
      }
      .todos .todo.completed .tx {
        color: var(--grf-text-faint);
        text-decoration: line-through;
      }
      .todos .todo.in_progress .tx {
        color: var(--grf-text);
      }
      .todos .todo.in_progress .box {
        border-color: var(--grf-accent);
        box-shadow: 0 0 0 2px var(--grf-accent-soft);
      }

      .composer-area {
        flex: none;
        /* 输入区可随多行/内嵌提问变高,但不超过聊天列高度,超出滚动,
         * 避免长内容被卡片底边裁掉 */
        max-height: 60%;
        overflow-y: auto;
        padding: 10px 18px 14px;
        /* 底部渐隐遮罩与卡片同黑,保证输入区背景整块拉通 */
        background: linear-gradient(to top, var(--grf-card) 65%, transparent);
      }
      .composer-area .inner {
        max-width: 860px;
        margin: 0 auto;
      }
      .usage-line {
        max-width: 860px;
        margin: 0 auto;
        display: flex;
        gap: 12px;
        justify-content: flex-end;
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
        padding: 3px 2px 0;
      }

      /* ---------- 右上角状态浮窗 ---------- */
      .status-pop {
        position: absolute;
        top: 46px;
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
      /* 收缩态:单行,宽度自适应内容 */
      .status-pop.collapsed {
        width: auto;
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
      .status-pop .sp-fold {
        padding: 3px 6px;
        border: none;
        background: transparent;
        color: var(--grf-text-dim);
        cursor: pointer;
        border-radius: 5px;
        display: inline-flex;
      }
      .status-pop .sp-fold:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
      }
      .status-pop .sp-fold svg {
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

  private get sid(): string | undefined {
    return this.store?.activeSessionId;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.tdrag = makeTitleDrag('button');
    window.addEventListener('pointermove', this.onResizeDrag);
    window.addEventListener('pointerup', this.stopResizeDrag);
    window.addEventListener('pointerdown', this.onWinPointerDown);
    this.gitTimer = window.setInterval(() => void this.pollGit(), 8000);
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    window.removeEventListener('pointermove', this.onResizeDrag);
    window.removeEventListener('pointerup', this.stopResizeDrag);
    window.removeEventListener('pointerdown', this.onWinPointerDown);
    if (this.gitTimer) window.clearInterval(this.gitTimer);
    this.gitTimer = undefined;
    this.bottomTerms = [];
    this.bottomActiveId = '';
    this.sideTermEl = null;
    super.disconnectedCallback();
  }

  private onResizeDrag = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const rect = this.getBoundingClientRect();
    if (this.dragging === 'bottom') {
      this.bottomHeight = Math.min(Math.max(rect.bottom - e.clientY, 90), rect.height * 0.7);
    } else {
      this.sideWidth = Math.min(Math.max(rect.right - e.clientX, 260), Math.min(760, rect.width * 0.65));
    }
  };

  private stopResizeDrag = (): void => {
    this.dragging = null;
  };

  // 右栏 "+" 菜单:点击菜单外任意处关闭
  private onWinPointerDown = (e: PointerEvent): void => {
    if (!this.sideMenuOpen) return;
    const path = e.composedPath();
    const menu = this.renderRoot.querySelector('.side-menu');
    const add = this.renderRoot.querySelector('.stab.add');
    if (menu && !path.includes(menu) && add && !path.includes(add)) this.sideMenuOpen = false;
  };

  // pollGit 状态浮窗的 git 区块:桌面态轮询当前项目仓库状态(浮窗自动
  // 显示,不依赖任何开关;无项目目录时清空)。
  private async pollGit(): Promise<void> {
    if (!inWails()) return;
    const cwd = this.store?.activeProjectPath();
    if (!cwd) {
      this.git = null;
      this.gitErr = '';
      return;
    }
    try {
      this.git = await gitStatus(cwd);
      this.gitErr = '';
    } catch (e) {
      this.git = null;
      this.gitErr = (e as Error)?.message ?? String(e);
    }
  }

  protected updated(props: Map<string, unknown>): void {
    // 底栏展开且没有任何终端 tab:自动开一个
    if (props.has('bottomOn') && this.bottomOn && this.bottomTerms.length === 0) {
      this.addBottomTerm();
      return;
    }
    // 终端工作目录跟随当前项目(同值赋值为 no-op,不触发重启)
    const cwd = this.store?.activeProjectPath() ?? '';
    for (const t of this.bottomTerms) (t.el as unknown as { cwd: string }).cwd = cwd;
    if (this.sideTermEl) (this.sideTermEl as unknown as { cwd: string }).cwd = cwd;
    // 状态浮窗:项目目录就绪/切换即取 git 状态(浮窗自动显示)
    if (cwd && cwd !== this.gitCwd) {
      this.gitCwd = cwd;
      void this.pollGit();
    }
    this.maybeScroll();
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

  render() {
    const s = this.store;
    const sid = this.sid;
    const rt = sid ? s?.runtimes.get(sid) : undefined;
    const title = sid ? s!.sessionTitle(sid) : '';
    const running = (sid && s!.isRunning(sid)) ?? false;
    const waiting = !!rt && rt.pendingRequests.length > 0 && !running;
    // 待应答提问:交互控件渲染在底部输入框内(点击选项即确认)
    const pendingAsks = rt?.items.filter((i): i is AskItem => i.kind === 'ask' && i.state === 'pending') ?? [];

    return html`
      ${this.noHeader
        ? nothing
        : html`
            <header
              class=${this.leftLights && !this.leftOn ? 'lights' : ''}
              @mousedown=${(e: MouseEvent) => this.tdrag?.onDown(e)}
              @dblclick=${(e: MouseEvent) => this.tdrag?.onDbl(e)}
            >
              ${this.leftToggle && !this.leftOn
                ? html`<span class="toggler">
                    <button class="ghost tg" title="展开会话列表" @click=${() => this.fire('grf-toggle-sessions')}>${unsafeHTML(icon.panelLeft)}</button>
                  </span>`
                : nothing}
              <span class="title" title=${title}>${title || '未选择会话'}</span>
              ${running
                ? html`<span class="chip running"><span class="dot"></span>运行中</span>`
                : waiting
                  ? html`<span class="chip waiting"><span class="dot"></span>等待输入</span>`
                  : nothing}
              <span class="actions">
                ${this.bottomToggle
                  ? html`<button class="ghost tg ${this.bottomOn ? 'on' : ''}" title="终端(当前项目目录)" @click=${() => this.fire('grf-toggle-terminal')}>${unsafeHTML(icon.terminal)}</button>`
                  : nothing}
                ${this.sidebarToggle
                  ? html`<button class="ghost tg ${this.sidebarOn ? 'on' : ''}" title="右栏(详情/审查/终端/浏览器)" @click=${() => this.fire('grf-toggle-sidebar')}>${unsafeHTML(icon.panelRight)}</button>`
                  : nothing}
              </span>
            </header>
          `}
      ${this.renderStatusPop()}
      <div class="cols">
        <div class="col-main">
          <div class="msgs" @scroll=${this.onScroll}>
            <div class="inner">
              ${!sid || sid.startsWith('draft:')
                ? this.renderEmpty()
                : (rt?.items ?? []).map((it) => this.renderItem(it))}
            </div>
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
                      @send=${this.onSend}
                      @answer=${this.onAskAnswer}
                      @dismiss=${this.onAskDismiss}
                      @stop=${() => void s!.cancelActive()}
                    ></grf-composer>
                    ${rt?.usage
                      ? html`
                          <div class="usage-line">
                            <span>in ${fmtTokens(rt.usage.input_tokens)}</span>
                            <span>out ${fmtTokens(rt.usage.output_tokens)}</span>
                            ${rt.usage.input_tokens_details?.cached_tokens
                              ? html`<span>缓存 ${fmtTokens(rt.usage.input_tokens_details.cached_tokens)}</span>`
                              : nothing}
                            ${rt.model ? html`<span>${rt.model}</span>` : nothing}
                          </div>
                        `
                      : nothing}
                  </div>
                </div>
              `}
          ${this.renderBottom()}
        </div>
        ${this.sidebarToggle ? this.renderSide() : nothing}
      </div>
    `;
  }

  // ---------- 底栏(多终端 tab,仅占聊天列宽度;右栏独立通到底部) ----------

  private renderBottom() {
    if (!this.bottomToggle) return nothing;
    return html`
      <div class="gutter-h ${this.bottomOn ? '' : 'off'}" @pointerdown=${() => (this.dragging = 'bottom')}></div>
      <div class="bottom ${this.bottomOn ? '' : 'off'}" style="height:${this.bottomHeight}px">
        <div class="bt-bar">
          ${this.bottomTerms.map(
            (t, i) => html`
              <span
                class="bt-tab ${this.bottomActiveId === t.id ? 'on' : ''}"
                title=${`终端 ${i + 1}`}
                @click=${() => (this.bottomActiveId = t.id)}
              >
                ${unsafeHTML(icon.terminal)}<span>终端 ${i + 1}</span>
                <button
                  class="x"
                  title=${`关闭终端 ${i + 1}`}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.closeBottomTerm(t.id);
                  }}
                >
                  ${unsafeHTML(icon.close)}
                </button>
              </span>
            `,
          )}
          <span class="bt-ops">
            <button class="op" title="新建终端" @click=${() => this.addBottomTerm()}>${unsafeHTML(icon.plus)}</button>
            <button class="op" title="收起底栏" @click=${() => this.fire('grf-toggle-terminal')}>${unsafeHTML(icon.close)}</button>
          </span>
        </div>
        <div class="bt-body">
          ${this.bottomTerms.map(
            (t) => html`<div class="bt-pane ${this.bottomActiveId === t.id ? 'on' : ''}">${t.el}</div>`,
          )}
        </div>
      </div>
    `;
  }

  // ---------- 右栏 tab 系统 ----------

  /** 当前环境可用的右栏 tab 类型。 */
  /** 当前环境可用的右栏面板类型 tab。文件 tab(file:<path>)不在其列,
   * 由左栏文件树点击打开。 */
  private availableSideTabs(): Exclude<SidePanelKind, 'file'>[] {
    const tabs: Exclude<SidePanelKind, 'file'>[] = ['detail'];
    if (inWails()) tabs.push('review'); // git 能力仅桌面
    if (inWails() && panelRegistered('grf-terminal')) tabs.push('terminal'); // 终端面板仅桌面态可用
    tabs.push('browser');
    return tabs;
  }

  // ensureSideTerminal 取(懒建)右栏内嵌终端元素;跨渲染复用同一实例,
  // 避免重渲染销毁重建 PTY(与底栏各终端相互独立)。
  private ensureSideTerminal(): HTMLElement | typeof nothing {
    if (!panelRegistered('grf-terminal')) return nothing;
    if (!this.sideTermEl) {
      this.sideTermEl = document.createElement('grf-terminal');
      this.sideTermEl.setAttribute('scope', this.scope);
    }
    return this.sideTermEl;
  }

  // ---------- 底栏多终端 tab ----------

  // addBottomTerm 新开一个底栏终端 tab 并激活。
  private addBottomTerm(): void {
    if (!panelRegistered('grf-terminal')) return;
    const el = document.createElement('grf-terminal');
    el.setAttribute('scope', this.scope);
    (el as unknown as { cwd: string }).cwd = this.store?.activeProjectPath() ?? '';
    const id = `bt${++this.bottomSeq}`;
    this.bottomTerms = [...this.bottomTerms, { id, el }];
    this.bottomActiveId = id;
  }

  // closeBottomTerm 关闭指定终端 tab(移除即销毁其 PTY);关掉最后一个时
  // 收起底栏,重新展开会自动新开一个。
  private closeBottomTerm(id: string): void {
    const idx = this.bottomTerms.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = this.bottomTerms.filter((_, i) => i !== idx);
    this.bottomTerms = next;
    if (next.length === 0) {
      this.bottomActiveId = '';
      this.fire('grf-toggle-terminal'); // 最后一个关掉:整栏收起
      return;
    }
    if (this.bottomActiveId === id) {
      this.bottomActiveId = next[Math.min(idx, next.length - 1)].id;
    }
  }

  private renderSide() {
    const avail = this.availableSideTabs();
    // 类型 tab 按可用性过滤;文件 tab(file:<path>)仅桌面态存在
    const tabs = this.sideTabs.filter((t) =>
      t.startsWith('file:') ? inWails() : avail.includes(t as Exclude<SidePanelKind, 'file'>),
    );
    const activeKind = this.tabKind(this.activeSideTab);
    const width = this.sideWidth ?? SIDE_TAB_META[activeKind]?.width ?? 300;
    const on = this.activeSideTab;
    const cwd = this.store?.activeProjectPath() ?? '';

    return html`
      <div class="gutter-side ${this.sidebarOn ? '' : 'off'}" @pointerdown=${() => (this.dragging = 'side')}></div>
      <aside class="side ${this.sidebarOn ? '' : 'off'}" style="width:${width}px">
        ${this.renderSideBar(tabs, avail)}
        <div class="side-body">
          ${tabs.includes('detail')
            ? html`<div class="pane ${on === 'detail' ? 'on' : ''}">
                <grf-sidebar scope=${this.scope} server=${this.serverAttr ?? nothing} token=${this.tokenAttr ?? nothing}></grf-sidebar>
              </div>`
            : nothing}
          ${tabs.includes('review')
            ? html`<div class="pane ${on === 'review' ? 'on' : ''}">
                <grf-review .cwd=${cwd}></grf-review>
              </div>`
            : nothing}
          ${tabs.includes('terminal')
            ? html`<div class="pane ${on === 'terminal' ? 'on' : ''}">${this.ensureSideTerminal()}</div>`
            : nothing}
          ${tabs.includes('browser')
            ? html`<div class="pane ${on === 'browser' ? 'on' : ''}">
                <grf-browser scope=${this.scope}></grf-browser>
              </div>`
            : nothing}
          ${tabs
            .filter((t): t is `file:${string}` => t.startsWith('file:'))
            .map((t) => {
              const f = this.fileTabs.find((x) => `file:${x.path}` === t);
              if (!f) return nothing;
              return html`<div class="pane ${on === t ? 'on' : ''}">
                <grf-file-view .path=${f.path} .name=${f.name} .rel=${f.rel}></grf-file-view>
              </div>`;
            })}
        </div>
      </aside>
    `;
  }

  private tabKind(t: SidePanelTab): SidePanelKind {
    return t.startsWith('file:') ? 'file' : (t as SidePanelKind);
  }

  // tabLabel 类型 tab 用固定名;文件 tab 显示项目内相对路径。
  private tabLabel(t: SidePanelTab): string {
    if (t.startsWith('file:')) {
      const f = this.fileTabs.find((x) => `file:${x.path}` === t);
      return f?.rel || f?.name || t.slice(5).split('/').pop() || '文件';
    }
    return SIDE_TAB_META[this.tabKind(t)].label;
  }

  // renderSideBar 右栏顶部 tab 栏;无已开 tab 时显示居中类型入口。
  private renderSideBar(tabs: SidePanelTab[], avail: Exclude<SidePanelKind, 'file'>[]) {
    if (tabs.length === 0) {
      return html`
        <div class="side-empty">
          <div class="hint">选择要打开的面板</div>
          <div class="entries">
            ${avail.map(
              (t) => html`
                <button class="entry" title=${`打开${SIDE_TAB_META[t].label}`} @click=${() => this.fire('grf-side-tab-open', t)}>
                  ${unsafeHTML(SIDE_TAB_META[t].icon)}
                  <span>${SIDE_TAB_META[t].label}</span>
                </button>
              `,
            )}
          </div>
        </div>
      `;
    }
    return html`
      <div class="side-tabs">
        ${tabs.map(
          (t) => html`
            <span class="stab ${this.activeSideTab === t ? 'on' : ''}" title=${this.tabLabel(t)} @click=${() => this.fire('grf-side-tab-activate', t)}>
              ${unsafeHTML(SIDE_TAB_META[this.tabKind(t)].icon)}
              <span class="stab-t">${this.tabLabel(t)}</span>
              <button
                class="x"
                title=${`关闭${this.tabLabel(t)}`}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.fire('grf-side-tab-close', t);
                }}
              >
                ${unsafeHTML(icon.close)}
              </button>
            </span>
          `,
        )}
        <span class="stab add" title="打开其他面板" @click=${() => (this.sideMenuOpen = !this.sideMenuOpen)}>
          ${unsafeHTML(icon.plus)}
        </span>
        ${this.sideMenuOpen
          ? html`
              <div class="side-menu">
                ${avail.map(
                  (t) => html`
                    <div
                      class="mi"
                      @click=${() => {
                        this.sideMenuOpen = false;
                        this.fire('grf-side-tab-open', t);
                      }}
                    >
                      ${unsafeHTML(SIDE_TAB_META[this.tabKind(t)].icon)}
                      <span>${this.tabLabel(t)}</span>
                      ${tabs.includes(t) ? html`<span class="mitag">已打开</span>` : nothing}
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  // renderStatusPop 右上角状态浮窗(自动显示):当前项目 git 概览(置顶)
  // 与模型 todo 任务 —— 有内容才显示对应区块,都没有则整框不渲染。首个
  // 区块标题行右侧的收缩按钮可把浮窗收成单行(git 变更或任务完成度),
  // 再次点击展开。git 每 8 秒轮询(pollGit);todo 随 store 订阅实时刷新。
  private renderStatusPop() {
    const s = this.store;
    if (!s) return nothing;
    const todos = s.runtimes.get(this.sid ?? '')?.todos ?? null;
    const hasGit = !!this.git;
    const hasTodos = !!todos?.length;
    // 没有任何可显示的内容:整框隐藏
    if (!hasGit && !hasTodos) return nothing;

    // 收缩态:单行显示 git 行级变更或任务完成度(哪个有显示哪个),
    // 始终保留展开按钮 —— 不能整框消失,否则无法再展开
    if (this.statusCollapsed) {
      const doneCnt = todos?.filter((t) => t.status === 'completed').length ?? 0;
      return html`
        <div class="status-pop collapsed">
          <div class="sp-line">
            ${hasGit
              ? html`<span class="sp-diff">
                  更改 <span class="add">+${this.git!.additions}</span> <span class="del">-${this.git!.deletions}</span>
                </span>`
              : html`<span>任务 ${doneCnt}/${todos!.length} 完成</span>`}
            <button class="sp-fold" title="展开" @click=${() => (this.statusCollapsed = false)}>
              ${unsafeHTML(icon.chevron)}
            </button>
          </div>
        </div>
      `;
    }

    const doneCnt = todos?.filter((t) => t.status === 'completed').length ?? 0;
    // 缩放按钮不单独占行:跟随首个区块(Git 优先,否则任务)的标题行,靠右
    const foldBtn = html`<button class="sp-fold" title="收起为一行" @click=${() => (this.statusCollapsed = true)}>
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
          ? html`连接失败:${s.connError ?? '未知错误'}。请在左侧底部检查服务配置。`
          : '在左侧选择一个项目的会话,或点击项目上的 + 新建。'}
      </p>
    </div>`;
  }

  private renderItem(it: ChatItem) {
    switch (it.kind) {
      case 'user': {
        // 编辑态:气泡原位变输入框,改完作为新消息重新发送
        if (this.editingId === it.id) {
          return html`
            <div class="msg-user">
              <div class="edit-box">
                <textarea
                  .value=${this.editDraft}
                  @input=${(e: InputEvent) => (this.editDraft = (e.target as HTMLTextAreaElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.commitEdit();
                    else if (e.key === 'Escape') this.cancelEdit();
                  }}
                ></textarea>
                <div class="edit-ops">
                  <span class="hint">⌘/Ctrl+Enter 重新发送 · Esc 取消</span>
                  <button class="primary" @click=${this.commitEdit}>重新发送</button>
                  <button @click=${this.cancelEdit}>取消</button>
                </div>
              </div>
            </div>
          `;
        }
        return html`
          <div class="msg-user">
            <div class="body">${it.text}</div>
            <div class="bops">
              <button class="bop" title="复制" @click=${() => void this.copyText(it.id, it.text)}>
                ${unsafeHTML(this.copiedId === it.id ? icon.check : icon.copy)}
              </button>
              <button class="bop" title="编辑后重新发送" @click=${() => this.startEdit(it)}>
                ${unsafeHTML(icon.edit)}
              </button>
            </div>
            ${it.images?.length
              ? html`<div class="imgs">${it.images.map((u) => html`<img src=${u} alt="图片" />`)}</div>`
              : nothing}
          </div>
        `;
      }
      case 'assistant':
        return html`
          <div class="msg-assistant">
            <div class="md">
              ${unsafeHTML(renderMarkdown(it.text))}
              ${it.streaming && !it.text ? html`<span class="cursor"></span>` : nothing}
            </div>
            ${it.streaming && it.text ? html`<div class="gen">生成中…</div>` : nothing}
          </div>
        `;
      case 'reasoning':
        return this.renderReasoning(it);
      case 'tool':
        // ask_user_question 单独成提问卡片,工具行无信息量,不展示
        return it.name === 'ask_user_question'
          ? nothing
          : html`<grf-tool-card .item=${it}></grf-tool-card>`;
      case 'notice':
        return html`
          <div class="notice ${it.noticeKind}">
            <span class="k">${it.noticeKind}</span><span>${truncate(it.detail, 300)}</span>
          </div>
        `;
      case 'ask':
        // 待答提问的交互控件在底部输入框内(点击选项即提交);
        // 消息流只保留已应答/已取消的记录卡。
        if (it.state === 'pending') return nothing;
        return html`<grf-ask-form
          .item=${it}
          @answer=${this.onAskAnswer}
          @dismiss=${this.onAskDismiss}
        ></grf-ask-form>`;
      case 'approval':
        return html`<grf-approval-card .item=${it} @approve=${this.onApprove}></grf-approval-card>`;
      case 'error':
        return html`<div class="err">${it.text}</div>`;
      case 'status':
        return html`<div class="status">— ${it.text} —</div>`;
      default:
        return nothing;
    }
  }

  private reasoningOpen = new Set<string>();
  private renderReasoning(it: { kind: 'reasoning'; id: string; text: string; streaming: boolean }) {
    // 默认折叠,流式时展开。显式点过的记在 reasoningOpen。
    const open = this.reasoningOpen.has(it.id) || it.streaming;
    const toggle = () => {
      if (this.reasoningOpen.has(it.id)) this.reasoningOpen.delete(it.id);
      else this.reasoningOpen.add(it.id);
      this.requestUpdate();
    };
    return html`
      <div class="reasoning">
        <div class="rhead" @click=${toggle}>
          ${unsafeHTML(icon.brain)}
          <span>思考</span>
          <svg
            class="chev ${open ? 'open' : ''}"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          >
            <path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        ${open ? html`<pre>${it.text}</pre>` : nothing}
      </div>
    `;
  }

  private onSend(e: CustomEvent<{ text: string; images?: string[] }>): void {
    void this.store!.send(e.detail.text, e.detail.images);
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
    if (text) void this.store!.send(text, undefined, editOf ? { editOf } : undefined);
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
