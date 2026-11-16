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
import { markdownCss } from '../../ui/markdown-css';
import { icon } from '../../util/icons';
import { makeTitleDrag, type TitleDrag } from '../../util/titledrag';
import { inWails, saveSkill, speechRelayBase } from '../../host/bridge';
import { usageTotals, type AskItem, type AssistantItem } from '../../core/model/chat-model';
import { settingsStore, displayFullModel } from '../../core/settings/settings-store';
import { isSpeaking, onSpeakStateChange, speak, stopSpeak } from '../../core/speech/tts';
import { modelMenuOf, contextWindowDenominator } from '../../util/model-menu';
import { registry, getStatusPop, onStatusPopChange, type PanelContext } from '../../registry/registry';
import { getLocalProject } from '../../core/store/host-config';
import './composer';
import './model-sheet';
import './status-pop';
import { renderItem, renderChatNav, cnavWave, cnavReset, type MessageViewProps } from './messages';
import { shortModel } from './model-sheet';

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
   *  workcard 容器,避免双层卡片);独立嵌入不传,保留卡片感。 */
  @property({ type: Boolean }) flat = false;
  /** 移动模式(移动端宿主声明):微信式移动布局 —— 头部变
   *  [返回|标题|模型|新会话](返回/新会话 fire goder-back/goder-new-session
   *  由宿主接线,模型 chip 开底部弹层)、消息双方头像气泡、composer 单行
   *  输入条(长按按住说话);左侧消息导航条不渲染(与边缘滑动手势冲突)。 */
  @property({ type: Boolean }) mobile = false;
  /** 头部模型弹层(移动模式;桌面模型入口在 composer 工具栏) */
  @state() private modelSheet = false;

  /** 底部吸附态:用户在消息区最底(距底容差内)时新内容自动滚到最底;
   * 向上滚看历史即脱离,滚回最底恢复(见 onScroll/STICK_AT)。 */
  @state() private stickBottom = true;
  /** 距底多少像素内仍视为吸附中(容差:流式重排的微小抖动不算离底) */
  private static readonly STICK_AT = 60;
  /** 消息内容/滚动视口尺寸观察(底部吸附:吸附态下内容增高或视口变化
   * 即回最底;观察 .inner 覆盖流式增量、图片异步加载等一切高度变化) */
  private stickRo: ResizeObserver | null = null;
  /** 上次渲染的会话 id(切会话重置吸附并滚到最新) */
  private lastSid?: string;
  /** 聊天列过窄(右栏/窗口挤压/移动端全屏):状态浮窗抑制自动展开(手动展开不受限) */
  @state() private colNarrow = false;
  /** 聊天列窄阈值(px):低于即通知浮窗抑制自动展开 */
  private static readonly NARROW_AT = 560;
  /** 聊天列宽度观察(浮窗自动收缩用) */
  private colRo: ResizeObserver | null = null;
  /** 编辑中的用户消息 id 与草稿(编辑后重新发送) */
  @state() private editingId?: string;
  @state() private editDraft = '';
  /** 刚复制成功的消息 id(图标短暂变为 ✓) */
  @state() private copiedId?: string;
  private copiedTimer = 0;
  /** 正在朗读(加载音频/播放中)的助手消息 id(语音输出) */
  @state() private speakingId?: string;
  /** 朗读状态订阅(tts 引擎单例广播,多面板实例同屏同步) */
  private speakUnsub?: () => void;
  /** 朗读失败/自动播放被拦的提示文案(数秒自动清除) */
  @state() private speakMsg = '';
  private speakMsgTimer = 0;
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

  static styles = [
    theme,
    controls,
    // markdown 输出元素样式走 ui/markdown-css.ts 的单一维护点(full 档,
    // 作用域默认 .md 与原手工副本的选择器一致);.msg-assistant .md 容器
    // 行为(行高/断词/首尾去距)仍是本文件局部规则。
    markdownCss('full'),
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
      /* 回到底部:脱离吸附(用户在上方看历史)时浮现于消息区右下角 */
      .to-bottom {
        position: absolute;
        right: 20px;
        bottom: 14px;
        z-index: 25;
        width: 32px;
        height: 32px;
        padding: 0;
        border-radius: 50%;
        border: 1px solid var(--goder-border);
        background: var(--goder-bg-raise);
        color: var(--goder-text-dim);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--goder-shadow);
        animation: tb-in 0.15s ease;
      }
      .to-bottom:hover {
        color: var(--goder-text);
        border-color: var(--goder-border-hover);
      }
      .to-bottom svg {
        width: 15px;
        height: 15px;
      }
      @keyframes tb-in {
        from {
          opacity: 0;
          transform: translateY(4px);
        }
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
      /* 朗读失败/自动播放被拦的提示行(消息区顶部,数秒自动清除) */
      .speak-msg {
        flex: none;
        padding: 4px 14px;
        font-size: 12px;
        color: var(--goder-text-faint);
        background: var(--goder-bg-raise);
        border-bottom: 1px solid var(--goder-border);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .msg-user:hover .bops,
      .msg-assistant:hover .bops {
        opacity: 1;
      }
      /* 播放/加载中的朗读按钮常显(正在播 = 用户需要看到停止入口) */
      .bops.on {
        opacity: 1;
      }
      .bop.speaking {
        color: var(--goder-accent);
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
      /* ---------- 移动模式(mobile):微信式头部与聊天气泡 ---------- */
      header.mobile {
        height: 44px;
        padding: 0 6px;
        gap: 6px;
      }
      /* 返回/新会话:38px 方形命中区 */
      header.mobile .mact {
        flex: none;
        width: 38px;
        height: 38px;
        padding: 0;
        justify-content: center;
      }
      header.mobile .mact svg {
        width: 18px;
        height: 18px;
      }
      /* 模型 chip:胶囊按钮显示当前模型短名,点击开底部弹层 */
      header.mobile .mbtn {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 1px solid var(--goder-border);
        border-radius: 99px;
        background: transparent;
        color: var(--goder-text-dim);
        font-size: var(--goder-font-size-xs);
        font-family: var(--goder-font);
        padding: 8px 10px;
        max-width: 38vw;
        min-width: 0;
        cursor: pointer;
      }
      header.mobile .mbtn .cur {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      header.mobile .mbtn svg {
        width: 1em;
        height: 1em;
        flex: none;
      }
      /* 消息区:去 860px 上限收紧留白,纵向滚动优先(压制 WebView 嵌套滚动手感问题) */
      .msgs-wrap.mob .msgs {
        padding: 12px 12px 8px;
        touch-action: pan-y;
      }
      .msgs-wrap.mob .inner {
        max-width: none;
        gap: 12px;
      }
      .composer-area.mob {
        padding: 8px 10px calc(10px + var(--safe-inset-bottom, 0px));
      }
      .composer-area.mob .inner {
        max-width: none;
      }
      /* 头像:双方消息各带 28px 圆角方头像(assistant 强调色底/user 中性底) */
      .ava {
        flex: none;
        width: 28px;
        height: 28px;
        border-radius: 7px;
        border: 1px solid var(--goder-border-soft);
        background: var(--goder-bg-raise);
        color: var(--goder-text-dim);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .ava svg {
        width: 16px;
        height: 16px;
      }
      .msg-assistant .ava {
        background: var(--goder-accent-soft);
        border-color: transparent;
        color: var(--goder-accent-text);
      }
      /* 用户消息:右侧头像 + 右气泡(微信式,一侧小角) */
      .msg-user.mob {
        flex-direction: row;
        align-items: flex-start;
        justify-content: flex-end;
        gap: 8px;
      }
      .msg-user .side {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        max-width: 100%;
        min-width: 0;
      }
      .msg-user.mob .side {
        max-width: calc(100% - 36px);
      }
      .msg-user.mob .body {
        border-radius: 12px 4px 4px 12px;
        max-width: 100%;
      }
      /* 助手消息:左侧头像 + 左气泡;桌面态 .bub display:contents 不参与布局 */
      .msg-assistant.mob {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .msg-assistant .col {
        display: block;
        min-width: 0;
        max-width: 100%;
      }
      .msg-assistant.mob .col {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        max-width: calc(100% - 36px);
      }
      .msg-assistant .bub {
        display: contents;
      }
      .msg-assistant.mob .bub {
        display: block;
        background: var(--goder-bg-raise);
        border: 1px solid var(--goder-border-soft);
        border-radius: 4px 12px 12px 12px;
        padding: 9px 12px;
        min-width: 0;
        max-width: 100%;
        overflow-x: auto;
      }
      /* 触屏(无 hover):用户消息复制/编辑常显,回到底部加大命中区 */
      @media (hover: none) {
        .bops {
          opacity: 1;
        }
        .bop {
          padding: 7px;
        }
        .bop svg {
          width: 16px;
          height: 16px;
        }
        .to-bottom {
          width: 44px;
          height: 44px;
        }
        .to-bottom svg {
          width: 18px;
          height: 18px;
        }
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
    // 模型选择下拉的数据源(桌面态 gh settings.json;幂等,已加载则跳过)
    this.settingsUnsub = settingsStore.subscribe(() => this.requestUpdate());
    void settingsStore.loadModelCfg();
    // registry 变更即时反映(三方增删右栏/底栏条目)
    this.regUnsub = registry.subscribe(() => this.requestUpdate());
    // 状态浮窗配置变更即时反映(configure({ statusPop: false }) 裁剪)
    this.statusPopOff = onStatusPopChange(() => this.requestUpdate());
    // 语音输出:朗读状态订阅(tts 引擎单例广播,多面板实例同屏同步
    // 「正在朗读哪条」);回合完成事件 = 自动朗读触发点(ok 且开启时)
    this.speakUnsub = onSpeakStateChange((st, err) => {
      this.speakingId = st.key ?? undefined;
      if (err) this.flashSpeakMsg(err);
      this.requestUpdate();
    });
    window.addEventListener('goder:round-completed', this.onRoundCompleted);
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
    // 底部吸附:观察消息内容 .inner 与滚动视口 .msgs —— 流式增量、图片
    // 异步加载、窗口/面板伸缩都会改变二者尺寸,吸附态下即滚回最底;
    // 相比在 updated 里滚,RO 能覆盖不经 Lit 渲染的高度变化。
    const msgs = this.renderRoot.querySelector('.msgs');
    const inner = this.renderRoot.querySelector('.msgs .inner');
    if (msgs && inner) {
      this.stickRo = new ResizeObserver(() => this.maybeScroll());
      this.stickRo.observe(inner);
      this.stickRo.observe(msgs);
    }
  }

  protected updated(props: PropertyValues<this>): void {
    super.updated(props);
    // 切会话:重置吸附并滚到最新消息(此时 DOM 已更新,直接到位;历史
    // 若稍后异步到达,增高由 stickRo 兜底回底)
    if (this.sid !== this.lastSid) {
      this.lastSid = this.sid;
      this.stickBottom = true;
      this.maybeScroll();
    }
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    this.colRo?.disconnect();
    this.colRo = null;
    this.stickRo?.disconnect();
    this.stickRo = null;
    this.settingsUnsub?.();
    this.settingsUnsub = undefined;
    this.regUnsub?.();
    this.regUnsub = undefined;
    this.statusPopOff?.();
    this.statusPopOff = undefined;
    this.speakUnsub?.();
    this.speakUnsub = undefined;
    // 朗读不因面板卸载而停(用户切面板,音频继续;组件重连重新订阅状态)
    window.removeEventListener('goder:round-completed', this.onRoundCompleted);
    super.disconnectedCallback();
  }

  /** 底部吸附滚动:仅吸附态执行;流式高频调用必须用即时滚动(instant),
   * smooth 会堆叠动画跟不上内容增长。 */
  private maybeScroll(): void {
    if (!this.stickBottom) return;
    const el = this.renderRoot.querySelector('.msgs');
    if (el) el.scrollTop = el.scrollHeight;
  }

  private onScroll(e: Event): void {
    const el = e.target as HTMLElement;
    // 向上滚看历史即脱离吸附;滚回距底容差内恢复。程序设置的 scrollTop
    // 也会触发本事件,但落点在最底 → 仍判定吸附,自洽。
    this.stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < GoderChat.STICK_AT;
  }

  /** 「回到底部」按钮:恢复吸附并滚到最新消息。 */
  private toBottom(): void {
    this.stickBottom = true;
    this.maybeScroll();
  }

  /** 头部修饰类:macOS 红绿灯悬浮位(左栏收起时)/ 无边框桌面平台窗口控制让位 */
  private get headerClass(): string {
    return [this.leftLights && !this.leftOn ? 'lights' : '', this.winControls ? 'win' : ''].filter(Boolean).join(' ');
  }

  /** 移动头部:[返回 | 标题 | 等待 chip | 模型 chip | 新会话]。返回/新会话
   *  fire 事件由宿主接线(goder-back / goder-new-session,embed 哲学:
   *  导航动作宿主编排);模型 chip 开底部弹层(选择即时生效)。
   *  curFull 为「下一回合将使用的模型」全名(与 composer 桌面按钮同一数据)。 */
  private renderMobileHeader(title: string, waiting: boolean, curFull: string) {
    return html`
      <header class="mobile">
        <button class="ghost mact back" title=${this.t('返回')} aria-label=${this.t('返回')} @click=${() => this.fire('goder-back')}>
          ${unsafeHTML(icon.arrowLeft)}
        </button>
        <span class="title" title=${title}>${title || this.t('未选择会话')}</span>
        ${waiting ? html`<span class="chip waiting"><span class="dot"></span>${this.t('等待输入')}</span>` : nothing}
        <button
          class="mbtn"
          title=${curFull || this.t('选择模型')}
          @click=${() => this.openModelPicker()}
        >
          <span class="cur">${shortModel(curFull) || this.t('模型')}</span>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button class="ghost mact" title=${this.t('新会话')} aria-label=${this.t('新会话')} @click=${() => this.fire('goder-new-session')}>
          ${unsafeHTML(icon.plus)}
        </button>
      </header>
    `;
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
    // default 兜底 —— 未选择时按钮显示「选择模型」并由发送守卫拦截)。
    // 菜单分组与圆环分母的推导在 util/model-menu.ts(纯函数,含
    // provider/ 前缀与 models 判空的踩坑说明)。
    const curModel = s?.model || rt?.model || '';
    const activeModel = curModel;
    const providers = modelMenuOf(curModel);
    // 服务端回报的 model 是裸名(含九天式自带 / 的裸名),统一补 provider
    // 前缀对齐菜单项(勾选态匹配);表未加载/未命中原样保留
    const curFull = displayFullModel(curModel);
    const activeFull = displayFullModel(activeModel);
    // 上下文窗口取会话实际模型(圆环分母):优先供应商 /models 接口回报的
    // 真实值;查不到暂用按名估算并后台探测一次,成功后 store bump 触发
    // 重渲染换上真实值
    const ctxModel = rt?.model || curModel || '';
    const { exact: ctxExact, value: contextWindow } = contextWindowDenominator(ctxModel);
    if (ctxExact == null) settingsStore.probeProviderCtx(ctxModel);
    // 头部开关:装配开启且确有可用条目才显示
    const bottomDefs = registry.bottom.visible(ctx);
    const showBottomToggle = this.bottomToggle && bottomDefs.length > 0;
    const showSidebarToggle = this.sidebarToggle && registry.side.visible(ctx).length > 0;

    return html`
      ${this.noHeader
        ? nothing
        : this.mobile
          ? this.renderMobileHeader(title, waiting, curFull)
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
      ${this.modelSheet
        ? html`<goder-model-sheet
            scope=${this.scope}
            .providers=${providers}
            .model=${curFull}
            .activeModel=${activeFull}
            .effort=${s!.reasoningEffort ?? ''}
            @select=${(e: CustomEvent<string>) => this.onModelChange(e)}
            @effort-change=${(e: CustomEvent<string>) => s!.setReasoningEffort(e.detail)}
            @manage=${() => this.goModelSettings()}
            @close=${() => (this.modelSheet = false)}
          ></goder-model-sheet>`
        : nothing}
      <div class="msgs-wrap ${this.mobile ? 'mob' : ''}">
            ${this.speakMsg ? html`<div class="speak-msg">${this.speakMsg}</div>` : nothing}
            ${getStatusPop(this.scope)
              ? html`<goder-status-pop scope=${this.scope} .narrow=${this.colNarrow}></goder-status-pop>`
              : nothing}
            <div class="msgs" @scroll=${this.onScroll}>
              <div class="inner">
                ${!sid || sid.startsWith('draft:')
                  ? this.renderEmpty()
                  : (rt?.items ?? []).map((it) => renderItem(it, this.msgProps, rt?.items))}
                ${running ? html`<div class="run-ring" title="会话运行中"></div>` : nothing}
              </div>
            </div>
            ${this.mobile ? nothing : renderChatNav(rt?.items ?? [], cnavWave, cnavReset, (id) => this.scrollToMsg(id))}
            ${!this.stickBottom
              ? html`<button class="to-bottom" title=${this.t('回到底部')} @click=${this.toBottom}>
                  ${unsafeHTML(icon.arrowDown)}
                </button>`
              : nothing}
          </div>
          ${this.noComposer
            ? nothing
            : html`
                <div class="composer-area ${this.mobile ? 'mob' : ''}">
                  <div class="inner">
                    <goder-composer
                      scope=${this.scope}
                      .mobile=${this.mobile}
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
      mobile: this.mobile,
      t: (key: string) => this.t(key),
      editingId: this.editingId,
      editDraft: this.editDraft,
      copiedId: this.copiedId,
      ttsReady: this.ttsReady,
      speakingId: this.speakingId,
      reasoningOpen: this.reasoningOpen,
      onEditDraft: (v) => (this.editDraft = v),
      onCommitEdit: () => this.commitEdit(),
      onCancelEdit: () => this.cancelEdit(),
      onStartEdit: (it) => this.startEdit(it),
      onCopy: (id, text) => void this.copyText(id, text),
      onSpeak: (id, text) => {
        // 播放中再点同条 = 停止(朗读按钮的第二态)
        if (isSpeaking(id)) stopSpeak();
        else void this.speakMessage(id, text);
      },
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
    // 单项目模式(移动端宿主):项目概念对使用者不可见,空态文案不再提及。
    const noProjects = !!getLocalProject(s.name);
    if (this.sid?.startsWith('draft:')) {
      return html`<div class="empty">
        <div class="big">${unsafeHTML(icon.chat)}</div>
        <h3>${this.t('新会话')}</h3>
        <p>${noProjects
          ? this.t('发第一条消息开始对话,首条消息将决定会话标题。')
          : this.t('发第一条消息开始对话。首条消息将决定会话标题;项目默认策略(policy / system_prompt 等)随首条消息生效。')}</p>
      </div>`;
    }
    return html`<div class="empty">
      <div class="big">${unsafeHTML(icon.chat)}</div>
      <h3>${s.connState === 'error' ? this.t('无法连接 gh server') : this.t('选择或新建一个会话')}</h3>
      <p>
        ${s.connState === 'error'
          ? html`${this.t('连接失败:{err}。请检查服务配置或登录状态。', { err: s.connError ?? this.t('未知错误') })}`
          : noProjects
            ? this.t('点击 + 新建会话,或直接在下方输入发送。')
            : this.t('在左侧选择一个项目的会话,或点击项目上的 + 新建;也可以直接在下方输入发送,自动开始一个新会话(未选项目时归入「未分组会话」)。')}
      </p>
    </div>`;
  }

  // ---------- composer 事件 ----------

  private onSend(e: CustomEvent<{ text: string; images?: string[] }>): void {
    const payload = e.detail;
    // 用户主动发言即想看最新回合:恢复吸附(即便刚才在上面翻历史)
    this.stickBottom = true;
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
    s?.log('warn', '尚未选择模型:请在「模型」菜单中选择后再发送');
    this.openModelPicker();
    return false;
  }

  /** 模型选择入口:移动模式开头部模型弹层,桌面开 composer 浮层。
   *  打开即强刷模型配置(嵌入平台的套餐模型热下发,见 composer 同款)。 */
  private openModelPicker(): void {
    if (this.mobile) {
      this.modelSheet = true;
      void settingsStore.loadModelCfg(true);
      return;
    }
    const c = this.renderRoot.querySelector('goder-composer') as { openModelPicker?(): void } | null;
    c?.openModelPicker?.();
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
      this.stickBottom = true; // 同 onSend:用户主动发起回合,恢复吸附
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

  // ---------- 语音输出(朗读助手回复) ----------

  /** 语音输出就绪:设置启用且接口地址可用(合成地址留空 = 复用转写地址)。 */
  private get ttsReady(): boolean {
    const sp = settingsStore.speech;
    return sp.tts.enabled && !!(sp.tts.apiBaseUrl.trim() || sp.apiBaseUrl.trim());
  }

  /** 朗读一条助手消息(tts.ts 单例:新朗读打断旧的;地址/Key 合成侧
   *  留空时回落转写侧配置 —— 常见同一网关同时提供两接口)。 */
  private async speakMessage(id: string, text: string): Promise<void> {
    const sp = settingsStore.speech;
    const tts = sp.tts;
    try {
      await speak(id, text, {
        apiBaseUrl: tts.apiBaseUrl.trim() || sp.apiBaseUrl.trim(),
        apiKey: tts.apiKey.trim() || sp.apiKey.trim(),
        apiModel: tts.apiModel,
        voice: tts.voice,
        speed: tts.speed,
        relayBase: speechRelayBase(),
      });
    } catch (e) {
      this.flashSpeakMsg(e instanceof Error ? e.message : '朗读失败');
    }
  }

  /** 朗读提示(失败/自动播放被拦):消息区顶部一行,5 秒自动清除。 */
  private flashSpeakMsg(msg: string): void {
    this.speakMsg = msg;
    if (this.speakMsgTimer) clearTimeout(this.speakMsgTimer);
    this.speakMsgTimer = window.setTimeout(() => (this.speakMsg = ''), 5000);
  }

  /** 回合完成事件:设置开启自动朗读时,朗读本回合最后一条非空助手文本
   *  (通常是最终答复;工具调用回合的过渡性中间文本不读)。多面板实例
   *  各自命中 —— speak 以消息 id 幂等,重复触发只发一次请求。 */
  private onRoundCompleted = (ev: Event) => {
    const detail = (ev as CustomEvent<{ sessionId: string; ok: boolean }>).detail;
    if (!detail?.ok || !this.ttsReady || !this.sid || detail.sessionId !== this.sid) return;
    const sp = settingsStore.speech;
    if (!sp.tts.autoSpeak) return;
    const rt = this.store?.runtimes.get(detail.sessionId);
    if (!rt) return;
    const assistants = rt.items.filter((i): i is AssistantItem => i.kind === 'assistant' && !!i.text.trim());
    // 本回合助手条目 id 前缀 = response id(无 lastResponseId 时退全量取末条)
    const rid = rt.lastResponseId ?? '';
    const scoped = rid ? assistants.filter((i) => i.id.startsWith(`${rid}\u0000`)) : assistants;
    const last = scoped[scoped.length - 1];
    if (last) void this.speakMessage(last.id, last.text);
  };

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
