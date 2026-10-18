// util/armed.ts — 两段式行内确认(armed delete)公共件。
// 语义:首击进入待确认态(删除按钮变红色「确认」文字,3 秒未跟击自动
// 退出),再击才真正执行删除。不用 window.confirm —— wails 桌面的
// WKWebView 未实现 JS 弹窗宿主委托,confirm() 恒为 false,删除会静默失效。
// 同一 controller 实例支持任意多个 key(会话 id / 项目 id / 任务 id…),
// 但同屏同时只保留一个待确认态:布防新 key 自动解除旧 key(session-list
// 的项目删除原本就要先 disarm 会话删除,收敛后天然成立)。
// 断开清理:经 Lit ReactiveController 的 hostDisconnected 钩子清计时器与
// 布防态,消费方不必再在 disconnectedCallback 里手工清。
// 消费方:panels/sessions/session-list.ts、panels/chat/status-pop.ts、
// panels/settings/sections/shared.ts(设置分区基类)。
import { css } from 'lit';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

/** 待确认态自动退出时长(ms) */
const ARMED_TIMEOUT_MS = 3000;

/** 两段式行内确认 controller(经 useArmedConfirm 挂接,勿直接 new)。 */
export class ArmedConfirm implements ReactiveController {
  private host: ReactiveControllerHost;
  /** 当前待确认的 key(undefined = 无) */
  private armedKey?: string;
  private timer?: number;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  /** key 是否处于待确认态(渲染侧据此切换「确认」视觉)。 */
  isArmed(key: string): boolean {
    return this.armedKey === key;
  }

  /** 当前待确认的 key(无则 undefined)。 */
  get key(): string | undefined {
    return this.armedKey;
  }

  /** 两段式点击入口:首击布防返回 false(仅重渲染),再击解除并返回
   * true(调用方执行删除)。 */
  click(key: string): boolean {
    if (this.armedKey === key) {
      this.disarm();
      return true;
    }
    this.arm(key);
    return false;
  }

  /** 布防 key(重置 3s 计时;自动解除此前布防的其他 key)。 */
  arm(key: string): void {
    this.clearTimer();
    this.armedKey = key;
    this.timer = window.setTimeout(() => this.disarm(), ARMED_TIMEOUT_MS);
    this.host.requestUpdate();
  }

  /** 手动解除当前待确认态(条目消失 / 改名等场景)。 */
  disarm(): void {
    this.clearTimer();
    if (this.armedKey === undefined) return;
    this.armedKey = undefined;
    this.host.requestUpdate();
  }

  /** 元素断开:清计时器与布防态(防重挂后残留僵尸「确认」)。 */
  hostDisconnected(): void {
    this.clearTimer();
    this.armedKey = undefined;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** 挂接两段式确认 controller(消费方字段初始化:
 * `private armed = useArmedConfirm(this)`)。 */
export function useArmedConfirm(host: ReactiveControllerHost): ArmedConfirm {
  return new ArmedConfirm(host);
}

/** 待确认态按钮共用样式:垃圾桶图标换为红色「确认」文字。选择器双写
 * `.armed.armed` 抬高特异性,压过各组件两类名的基态规则(如
 * `.sess .del`);消费方把本块放在 styles 数组末尾,悬停底色由各组件
 * 已有的 :hover 规则给出(与会话删除原实现一致)。设置分区的删除按钮
 * 是文字钮(.ghost.danger「确认删除」),形态不同,不消费本样式。 */
export const armedBtnCss = css`
  .armed.armed {
    color: var(--goder-error);
    font-size: var(--goder-font-size-xs);
    font-weight: 650;
    line-height: 1;
  }
  .armed.armed:hover {
    color: var(--goder-error);
  }
`;
