// panel.ts — GrfPanel:全部 grf-* 面板的公共基类。
// - scope 属性选择共享数据域(嵌入态多实例互不干扰)
// - 订阅 scope 版本号驱动重渲染
// - server/token 属性可直接配置连接(不必走 JS API)
import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';
export { theme, controls } from './theme';
import { configureScope, getScope, type GrfScope } from '../core/store/scope';
import type { Unsubscribe } from '../core/store/emitter';

export class GrfPanel extends LitElement {
  @property({ reflect: true }) scope = 'default';
  /** 直连 gh server 地址(形如 http://127.0.0.1:7400),可选;网关模式下留空走同源 */
  @property({ attribute: 'server' }) serverAttr?: string;
  /** Bearer 令牌,可选;网关(服务端注入令牌)模式下可省 */
  @property({ attribute: 'token' }) tokenAttr?: string;

  protected store!: GrfScope;
  private unsub?: Unsubscribe;

  connectedCallback(): void {
    super.connectedCallback();
    this.attachScope();
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = undefined;
    super.disconnectedCallback();
  }

  protected updated(props: Map<string, unknown>): void {
    if (props.has('scope') || props.has('serverAttr') || props.has('tokenAttr')) {
      this.attachScope();
    }
  }

  private attachScope(): void {
    this.unsub?.();
    if (this.serverAttr || this.tokenAttr) {
      this.store = configureScope(this.scope, {
        ...(this.serverAttr ? { baseUrl: this.serverAttr } : {}),
        ...(this.tokenAttr ? { token: this.tokenAttr } : {}),
      });
    } else {
      this.store = getScope(this.scope);
    }
    this.unsub = this.store.subscribe(() => this.requestUpdate());
    this.requestUpdate();
  }

  protected fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

/** 面板元素是否已注册(如 grf-terminal 仅桌面入口注册;嵌入态据此降级隐藏)。 */
export function panelRegistered(tag: string): boolean {
  return typeof customElements !== 'undefined' && customElements.get(tag) != null;
}
