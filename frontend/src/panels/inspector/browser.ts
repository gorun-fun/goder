// browser.ts — <goder-browser>:右栏内嵌浏览器(地址栏 + 页面区)。
// 两种实现,同一组件内自动选择:
//   - 桌面态且平台支持内嵌(wails + Go 侧 Available):原生 webview ——
//     macOS 是自建并嵌入主窗口 contentView 的 WKWebView,Windows 是
//     Wails 窗口 HWND 重父级成 WS_CHILD 的子窗口;两者都不受
//     X-Frame-Options/COOP 限制。本组件只负责导航(bridge
//     BrowserManager)与上报页面区 rect(视口相对 CSS 像素),原生
//     视图由 Go 侧覆盖布局。
//   - 余下情况(Linux 等无原生内嵌、纯 web/嵌入态、原生创建失败):
//     iframe 回退,部分站点禁止内嵌属站点安全策略。
// 上次访问地址按 scope 记忆在键值存储(core/store/storage 统一通道,
// 嵌入方替换存储实现时同步生效)。
import { css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GoderPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { kvGet, kvSet } from '../../core/store/storage';
import {
  inWails,
  browserAvailable,
  browserNavigate,
  browserShow,
  browserHide,
  browserSetRect,
  browserSetBackground,
  browserReload,
} from '../../host/bridge';

/** 看起来像域名的输入自动补 https://;本地绝对路径桌面态直接 file://
 * (原生 webview 已升级为独立 WKWebView 子视图,不受主 webview 源隔离
 * 限制),非桌面形态仍走同源文件服务 */
function normalizeUrl(v: string, native: boolean): string {
  const t = v.trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data):/i.test(t)) return t;
  // 本地绝对路径:原生 webview 直接 file://;iframe 回退走同源文件服务
  if (t.startsWith('/')) return native ? `file://${t}` : localFileUrl(t);
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?|#)/i.test(t)) return `https://${t}`;
  return t;
}

/** 本地文件 → 同源只读服务地址 */
function localFileUrl(path: string): string {
  return `/goder-api/local-file?path=${encodeURIComponent(path)}`;
}

/** 原生 webview 需要绝对 URL:相对地址(/goder-api/...)按当前 origin 补全 */
function absolutize(u: string): string {
  if (!u || /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data):/i.test(u)) return u;
  try {
    return new URL(u, location.href).href;
  } catch {
    return u;
  }
}

/** 地址栏显示值:file:// 与本地文件服务地址均还原为可读的文件路径 */
function displayUrl(u: string): string {
  if (u.startsWith('file://')) return u.slice('file://'.length);
  if (u.startsWith('/goder-api/local-file?path=') || u.includes('/goder-api/local-file?path=')) {
    try {
      const q = u.slice(u.indexOf('?path=') + '?path='.length);
      return decodeURIComponent(q);
    } catch {
      return u;
    }
  }
  return u;
}

@customElement('goder-browser')
export class GoderBrowser extends GoderPanel {
  /** 地址栏输入值 */
  @state() private input = '';
  /** 当前加载的地址(空 = 未导航) */
  @state() private url = '';
  /** 实际赋给 iframe 的 src(仅 iframe 模式;刷新时先置空再还原以强制重载) */
  @state() private frameSrc = '';
  private reloadTimer = 0;
  /** 原生模式标记:桌面态先乐观置位,平台不支持(Go 侧 Available=false)
   * 或原生内容创建失败时降级 iframe(见 fallbackToFrame)。 */
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
        border-bottom: 1px solid var(--goder-border-soft);
      }
      .bar input {
        flex: 1;
        min-width: 0;
        font-size: var(--goder-font-size-xs);
        font-family: var(--goder-mono);
        padding: 4px 8px;
      }
      .bar button.ghost {
        padding: 4px 6px;
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
        background: var(--goder-card);
        color: var(--goder-text-faint);
        font-size: var(--goder-font-size-sm);
        text-align: center;
        padding: 0 24px;
      }
      .hint svg {
        width: 30px;
        height: 30px;
        opacity: 0.5;
      }
      .hint .sub {
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
        line-height: 1.8;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    try {
      const saved = kvGet<string>(this.storeKey());
      if (saved) {
        this.url = saved;
        this.input = displayUrl(saved);
        this.frameSrc = saved;
      }
    } catch {
      /* 忽略 */
    }
    void this.resolveMode();
  }

  /** 决定渲染模式:桌面态先乐观走原生(与旧行为一致,避免 iframe 闪一下),
   * 平台不支持内嵌(Linux 等)再降级 iframe。 */
  private async resolveMode(): Promise<void> {
    if (!inWails()) return;
    this.native = true;
    this.classList.add('native');
    this.attachNative();
    if (!(await browserAvailable()) && this.isConnected) this.fallbackToFrame();
  }

  /** 原生模式接线:面板激活 → 展示原生视图并开始跟踪 rect。tab 关闭重开
   * (元素复用、重新插入 DOM)时 connectedCallback 会再次触发,rect 跟随
   * 也要重建 —— 不能只依赖 firstUpdated(它只触发一次)。 */
  private attachNative(): void {
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

  /** 原生内容在运行期创建失败(如缺 WebView2 运行时):降级 iframe,
   * 不让面板停在空白态。 */
  private fallbackToFrame(): void {
    if (!this.native) return;
    this.native = false;
    this.classList.remove('native');
    this.frameSrc = this.url;
    window.clearInterval(this.rectPoll);
    this.rectPoll = 0;
    this.ro?.disconnect();
    this.ro = undefined;
    this.requestUpdate();
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
    return `goder:${this.scope}:browser-url`;
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
      // --goder-card(WebKit 默认白底,深色主题下边缘 1px 发丝缝会露白;
      // underPageBackgroundColor 置为主题色后不可见)。
      const cs = getComputedStyle(this);
      const bg = (cs.getPropertyValue('--goder-card') || '').trim();
      if (bg && bg !== this.lastBg) {
        this.lastBg = bg;
        void browserSetBackground(bg);
      }
    });
  }

  private go(): void {
    const u = normalizeUrl(this.input, this.native);
    if (!u) return;
    this.load(u);
  }

  /** open 外部导航入口(file-view 的 html 渲染眼睛):直接加载指定地址 */
  open(u: string): void {
    const n = normalizeUrl(u, this.native);
    if (!n) return;
    this.load(n);
  }

  private load(u: string): void {
    this.input = displayUrl(u);
    this.url = u;
    try {
      kvSet(this.storeKey(), u);
    } catch {
      /* 忽略 */
    }
    if (this.native) {
      void browserNavigate(absolutize(u)).then((ok) => {
        // 原生内容建不出来(平台/运行时缺失):就地降级 iframe
        if (!ok) {
          this.fallbackToFrame();
          return;
        }
        this.scheduleRect();
      });
    } else {
      this.frameSrc = u;
    }
  }

  private reload(): void {
    // 原生模式:重载原生视图「当前页」,不依赖前端 this.url —— 智能体经
    // goder-console 直连导航(goder_browser_navigate)或面板从未手动输入过
    // 地址时 this.url 可能为空/陈旧,此时静默 return 会让刷新按钮看起来
    // 完全失效(视图明明有页面可刷)。
    if (this.native) {
      void browserReload();
      return;
    }
    if (!this.url) return;
    this.frameSrc = '';
    this.reloadTimer = window.setTimeout(() => {
      this.frameSrc = this.url;
    }, 0);
  }

  render() {
    const loaded = this.native ? this.url : this.frameSrc;
    return html`
      <div class="bar">
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
    'goder-browser': GoderBrowser;
  }
}
