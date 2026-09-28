// panel.ts — GoderPanel:全部 goder-* 面板的公共基类。
// - scope 属性选择共享数据域(嵌入态多实例互不干扰)
// - 订阅 scope 版本号驱动重渲染
// - server/token 属性可直接配置连接(不必走 JS API)
// - t() 文案翻译(i18n:key 即中文默认文案,嵌入方可按 scope 覆盖)
import { LitElement, type PropertyValues } from 'lit';
import { property } from 'lit/decorators.js';
export { theme, controls } from './theme';
import { configureScope, acquireScope, releaseScope, type GoderScope } from '../core/store/scope';
import type { Unsubscribe } from '../core/store/emitter';
import { translate } from '../core/i18n';

export class GoderPanel extends LitElement {
  @property({ reflect: true }) scope = 'default';
  /** 直连 gh server 地址(形如 http://127.0.0.1:7400),可选;网关模式下留空走同源 */
  @property({ attribute: 'server' }) serverAttr?: string;
  /** Bearer 令牌,可选;网关(服务端注入令牌)模式下可省 */
  @property({ attribute: 'token' }) tokenAttr?: string;

  protected store!: GoderScope;
  private unsub?: Unsubscribe;
  private sessUnsub?: Unsubscribe;
  private watchSid?: string;

  connectedCallback(): void {
    super.connectedCallback();
    this.attachScope();
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.sessUnsub?.();
    this.sessUnsub = undefined;
    this.watchSid = undefined;
    this.releaseAttachedScope();
    super.disconnectedCallback();
  }

  protected updated(props: PropertyValues<this>): void {
    if (props.has('scope') || props.has('serverAttr') || props.has('tokenAttr')) {
      this.attachScope();
    }
    // 会话定向订阅跟随活动会话(切会话的重订;见 willUpdate 亦先行兜底)
    this.watchSession(this.store?.activeSessionId);
  }

  protected willUpdate(_props: PropertyValues<this>): void {
    // 渲染前先对齐定向订阅,保证本次渲染能收到后续该会话的流式通知
    this.watchSession(this.store?.activeSessionId);
  }

  private attachScope(): void {
    this.unsub?.();
    // scope 引用计数:换 scope 先释放旧的,断开由 disconnectedCallback 兜底
    this.releaseAttachedScope();
    if (this.serverAttr || this.tokenAttr) {
      this.store = configureScope(this.scope, {
        ...(this.serverAttr ? { baseUrl: this.serverAttr } : {}),
        ...(this.tokenAttr ? { token: this.tokenAttr } : {}),
      });
      this.attachedScope = this.scope;
      acquireScope(this.scope);
    } else {
      this.store = acquireScope(this.scope);
      this.attachedScope = this.scope;
    }
    this.unsub = this.store.subscribe(() => this.requestUpdate());
    this.watchSession(this.store.activeSessionId);
    this.requestUpdate();
  }

  /** 当前面板持有引用的 scope 名(acquire/release 配对;undefined = 未挂接)。 */
  private attachedScope?: string;

  private releaseAttachedScope(): void {
    if (this.attachedScope) {
      releaseScope(this.attachedScope);
      this.attachedScope = undefined;
    }
  }

  /** 会话定向订阅(高频流式 delta 只唤醒关注活动会话的面板;低频结构
   *  变化仍经全量订阅驱动)。子类置 sessionWatch = false 可关掉(纯全局
   *  内容的面板,如会话列表本身,不必订会话)。 */
  protected sessionWatch = true;

  private watchSession(sid: string | undefined): void {
    if (!this.sessionWatch || this.watchSid === sid) return;
    this.sessUnsub?.();
    this.sessUnsub = undefined;
    this.watchSid = sid;
    if (sid && this.store) this.sessUnsub = this.store.subscribeSession(sid, () => this.requestUpdate());
  }

  protected fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** 文案翻译(i18n):key 即中文默认文案,嵌入方 configure({messages})
   *  命中返回译文(支持 {x} 插值),未命中原样返回。 */
  protected t(key: string, params?: Record<string, string | number>): string {
    return translate(this.scope, key, params);
  }
}

/** 面板元素是否已注册(如 goder-terminal 仅桌面入口注册;嵌入态据此降级隐藏)。 */
export function panelRegistered(tag: string): boolean {
  return typeof customElements !== 'undefined' && customElements.get(tag) != null;
}
