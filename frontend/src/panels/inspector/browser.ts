// browser.ts — <grf-browser>:右栏内嵌浏览器(地址栏 + 页面区)。
// 两种实现,同一组件内自动选择:
//   - 桌面态(wails):原生 webview 子视图(同 g-term 的实现方式)——
//     macOS 上是 Go 侧自建并嵌入主窗口 contentView 的 WKWebView,
//     无 X-Frame-Options/COOP 限制,Cookie 登录态持久化。本组件只负责
//     导航(bridge BrowserManager)与上报页面区 rect(视口相对 CSS
//     像素),原生视图由 Go 侧覆盖布局。
//   - 纯 web/嵌入态:iframe 回退,部分站点禁止内嵌属站点安全策略。
// 上次访问地址按 scope 记忆在 localStorage。
import { css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import {
  inWails,
  browserNavigate,
  browserShow,
  browserHide,
  browserSetRect,
  browserSetBackground,
  browserBack,
  browserForward,
  browserReload,
} from '../../host/bridge';

/** 看起来像域名的输入自动补 https://;本地绝对路径转同源文件服务 */
function normalizeUrl(v: string): string {
  const t = v.trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data):/i.test(t)) return t;
  // 本地绝对路径:走桌面态同源文件服务(file:// 会被 webview 源隔离拦截)
  if (t.startsWith('/')) return localFileUrl(t);
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?|#)/i.test(t)) return `https://${t}`;
  return t;
}

/** 本地文件 → 同源只读服务地址 */
function localFileUrl(path: string): string {
  return `/grf-api/local-file?path=${encodeURIComponent(path)}`;
}

/** 原生 webview 需要绝对 URL:相对地址(/grf-api/...)按当前 origin 补全 */
function absolutize(u: string): string {
  if (!u || /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data):/i.test(u)) return u;
  try {
    return new URL(u, location.href).href;
  } catch {
    return u;
  }
}

/** 地址栏显示值:本地文件服务地址还原为可读的文件路径 */
function displayUrl(u: string): string {
  if (u.startsWith('/grf-api/local-file?path=') || u.includes('/grf-api/local-file?path=')) {
    try {
      const q = u.slice(u.indexOf('?path=') + '?path='.length);
      return decodeURIComponent(q);
    } catch {
      return u;
    }
  }
  return u;
}

@customElement('grf-browser')
export class GrfBrowser extends GrfPanel {
  /** 地址栏输入值 */
  @state() private input = '';
  /** 当前加载的地址(空 = 未导航) */
  @state() private url = '';
  /** 实际赋给 iframe 的 src(仅 iframe 模式;刷新时先置空再还原以强制重载) */
  @state() private frameSrc = '';
  private reloadTimer = 0;
  /** 桌面原生模式标记(connected 时定死:组件生命周期内形态不变) */
  private native = false;
  private ro?: ResizeObserver;
  private rectFrame = 0;
  /** 轮询兜底:窗口缩放/侧栏折叠等布局变化未必总能触发 resize 事件与
   * ResizeObserver(实测 wails webview 下会漏),定时重测保证 rect 收敛 */
  private rectPoll = 0;
  /** 上次上报的 rect(变化才再报) */
  private lastRect = '';
  /** 上次上报的原生底色(主题/换肤变化才再报) */
  private lastBg = '';

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: transparent;
      }
      .bar {
        flex: none;
        display: flex;
        gap: 5px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--grf-border-soft);
      }
      .bar input {
        flex: 1;
        min-width: 0;
        font-size: var(--grf-font-size-xs);
        font-family: var(--grf-mono);
        padding: 4px 8px;
      }
      .bar button.ghost {
        padding: 4px 6px;
      }
      .bar button.ghost.flip svg {
        transform: scaleX(-1);
      }
      .page {
        flex: 1;
        min-height: 0;
        position: relative;
        background: #fff;
      }
      iframe {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: none;
      }
      /* 原生模式:页面区由原生 webview 覆盖,DOM 侧不留白色底 —— 缝隙处
       * 应露出面板主题色,而不是 #fff 白条。 */
      :host(.native) .page {
        background: transparent;
      }
      .hint {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 10px;
        background: var(--grf-card);
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-sm);
        text-align: center;
        padding: 0 24px;
      }
      .hint svg {
        width: 30px;
        height: 30px;
        opacity: 0.5;
      }
      .hint .sub {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        line-height: 1.8;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.native = inWails();
    if (this.native) this.classList.add('native');
    try {
      const saved = localStorage.getItem(this.storeKey());
      if (saved) {
        this.url = saved;
        this.input = displayUrl(saved);
        this.frameSrc = saved;
      }
    } catch {
      /* 忽略 */
    }
    if (this.native) {
      // 原生模式:面板激活 → 展示原生视图并开始跟踪 rect。tab 关闭重开
      // (元素复用、重新插入 DOM)时 connectedCallback 会再次触发,
      // rect 跟随也要重建 —— 不能只依赖 firstUpdated(它只触发一次)。
      void browserShow();
      if (this.url) void browserNavigate(absolutize(this.url));
      window.addEventListener('resize', this.onWinChange);
      window.addEventListener('scroll', this.onWinChange, true);
      this.rectPoll = window.setInterval(() => this.scheduleRect(), 500);
      const page = this.renderRoot.querySelector('.page');
      if (page) {
        this.ro = new ResizeObserver(() => this.scheduleRect());
        this.ro.observe(page);
      }
      this.scheduleRect();
    }
  }

  protected firstUpdated(): void {
    // 首次连接时 renderRoot 尚未渲染,connectedCallback 里挂不到 .page,这里补上。
    if (!this.native || this.ro) return;
    this.ro = new ResizeObserver(() => this.scheduleRect());
    this.ro.observe(this.renderRoot.querySelector('.page') ?? this);
    this.scheduleRect();
  }

  disconnectedCallback(): void {
    window.clearTimeout(this.reloadTimer);
    if (this.rectFrame) cancelAnimationFrame(this.rectFrame);
    this.rectFrame = 0;
    window.clearInterval(this.rectPoll);
    this.ro?.disconnect();
    this.ro = undefined;
    window.removeEventListener('resize', this.onWinChange);
    window.removeEventListener('scroll', this.onWinChange, true);
    if (this.native) void browserHide(); // 面板切走:隐藏原生内容
    super.disconnectedCallback();
  }

  private onWinChange = (): void => this.scheduleRect();

  private storeKey(): string {
    return `grf-ui:${this.scope}:browser-url`;
  }

  /** 上报页面区 rect(视口相对 CSS 像素),Go 侧据此布局原生视图。
   * rAF 节流而非定时防抖:拖右栏分隔线时 rect 逐帧变化,防抖会把上报
   * 一直推迟到停顿后,原生 webview 追不上 DOM,视觉上一跳一跳。 */
  private scheduleRect(): void {
    if (this.rectFrame) return;
    this.rectFrame = requestAnimationFrame(() => {
      this.rectFrame = 0;
      const page = this.renderRoot.querySelector('.page') as HTMLElement | null;
      if (!page) return;
      const r = page.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        // 面板不可见(尺寸为 0):先隐藏,等可见再报。
        this.lastRect = '';
        void browserHide();
        return;
      }
      // 亚像素防缝:getBoundingClientRect 带小数,round 后原生视图与
      // DOM 页面区可能差半像素、露出底色白条 —— 左上向下、右下向上取整,
      // 让原生视图向外多盖出不足 1px,视觉无缝。
      const x = Math.floor(r.left);
      const y = Math.floor(r.top);
      const w = Math.ceil(r.left + r.width) - x;
      const h = Math.ceil(r.top + r.height) - y;
      const key = `${x},${y},${w},${h}`;
      if (key === this.lastRect) return; // 轮询未发现变化,免重复上报
      this.lastRect = key;
      // 面板重新可见(收起再展开,元素可能未卸载、connectedCallback 不再
      // 触发):每次都重新声明展示意图,Show 幂等。
      void browserShow();
      void browserSetRect(x, y, w, h);
      // 原生 webview 底色跟随主题:页面区自身已透明,取面板卡片色令牌
      // --grf-card(WebKit 默认白底,深色主题下边缘 1px 发丝缝会露白;
      // underPageBackgroundColor 置为主题色后不可见)。
      const cs = getComputedStyle(this);
      const bg = (cs.getPropertyValue('--grf-card') || '').trim();
      if (bg && bg !== this.lastBg) {
        this.lastBg = bg;
        void browserSetBackground(bg);
      }
    });
  }

  private go(): void {
    const u = normalizeUrl(this.input);
    if (!u) return;
    this.load(u);
  }

  /** open 外部导航入口(file-view 的 html 渲染眼睛):直接加载指定地址 */
  open(u: string): void {
    const n = normalizeUrl(u);
    if (!n) return;
    this.load(n);
  }

  private load(u: string): void {
    this.input = displayUrl(u);
    this.url = u;
    try {
      localStorage.setItem(this.storeKey(), u);
    } catch {
      /* 忽略 */
    }
    if (this.native) {
      void browserNavigate(absolutize(u));
      this.scheduleRect();
    } else {
      this.frameSrc = u;
    }
  }

  private reload(): void {
    if (!this.url) return;
    if (this.native) {
      void browserReload();
      return;
    }
    this.frameSrc = '';
    this.reloadTimer = window.setTimeout(() => {
      this.frameSrc = this.url;
    }, 0);
  }

  render() {
    const loaded = this.native ? this.url : this.frameSrc;
    return html`
      <div class="bar">
        <button class="ghost" title="后退" ?hidden=${!this.native} @click=${() => void browserBack()}>
          ${unsafeHTML(icon.arrowLeft)}
        </button>
        <button
          class="ghost flip"
          title="前进"
          ?hidden=${!this.native}
          @click=${() => void browserForward()}
        >
          ${unsafeHTML(icon.arrowLeft)}
        </button>
        <input
          type="text"
          placeholder="输入网址,如 example.com"
          .value=${this.input}
          spellcheck="false"
          @input=${(e: InputEvent) => (this.input = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.go()}
        />
        <button class="ghost" title="跳转" @click=${() => this.go()}>${unsafeHTML(icon.send)}</button>
        <button class="ghost" title="刷新" @click=${() => this.reload()}>${unsafeHTML(icon.refresh)}</button>
      </div>
      <div class="page">
        ${loaded
          ? this.native
            ? html`<!-- 原生 webview 由 Go 侧覆盖在本区域上 -->`
            : html`<iframe src=${this.frameSrc} referrerpolicy="no-referrer"></iframe>`
          : html`
              <div class="hint">
                ${unsafeHTML(icon.globe)}
                <div>输入网址开始浏览</div>
                <div class="sub">
                  ${this.native
                    ? '页面由系统浏览器内核渲染,登录状态与 Safari 独立且持久保存。'
                    : '部分站点(如 Google/银行)禁止被内嵌框架显示,属站点安全策略。'}
                </div>
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-browser': GrfBrowser;
  }
}
