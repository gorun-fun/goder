// terminal.ts — <goder-terminal>:内嵌交互终端(xterm.js + 桌面 PTY)。
// 仅桌面形态使用(main.ts import 注册);嵌入产物不含本模块与 xterm 依赖,
// 嵌入态经 panelRegistered('goder-terminal') 探测并隐藏入口。
// PTY 会话随组件生命周期:挂载即启动、卸载即终止;cwd 变化时自动重启。
import { unsafeCSS , type PropertyValues } from 'lit';
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import { GoderPanel, theme } from '../../ui/panel';
import { inWails, startTerm, writeTerm, resizeTerm, killTerm, readTerm, onTermEvent } from '../../host/bridge';
import { consumePendingTerm, onConsoleTerm, registerVisibleTerm, unregisterVisibleTerm } from '../../shell/console-ui';

/** base64 → 字节(xterm.write 接受 Uint8Array,可正确处理跨块的 UTF-8)。 */
function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

@customElement('goder-terminal')
export class GoderTerminal extends GoderPanel {
  /** 终端工作目录(当前项目本地路径) */
  @property({ type: String }) cwd = '';

  @state() private status: 'boot' | 'running' | 'exited' | 'error' = 'boot';
  @state() private message = '';

  private term?: Terminal;
  private fit?: FitAddon;
  private sessionId?: string;
  private offs: Array<() => void> = [];
  private ro?: ResizeObserver;
  private fitTimer = 0;
  private booting = false;
  /** boot 期间又收到启动请求(cwd 快速变化):boot 结束后再补一轮 */
  private pendingBoot = false;
  /** 曾启动过(用于 tab 关闭重开后重新拉起会话) */
  private everBooted = false;
  /** 智能体接管的会话 id(goder_terminal_new 创建的 PTY;boot 时优先) */
  private forcedAdopt?: string;
  /** 智能体新建终端事件订阅 */
  private consoleTermOff?: () => void;

  static styles = [
    theme,
    unsafeCSS(xtermCss),
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        font-family: var(--goder-font);
      }
      .wrap {
        flex: 1;
        min-height: 0;
        position: relative;
        display: flex;
        flex-direction: column;
      }
      .term {
        flex: 1;
        min-height: 0;
        padding: 8px 10px 4px;
        overflow: hidden;
      }
      /* 覆盖 xterm 默认底色与滚动条,让终端透明融进黑卡、
       * 滚动条与聊天等面板一致(--goder-scroll-thumb 细圆角) */
      .term .xterm {
        background: transparent;
      }
      .term .xterm .xterm-viewport {
        background: transparent;
      }
      .term .xterm .xterm-viewport::-webkit-scrollbar {
        width: 9px;
        height: 9px;
        background: transparent;
      }
      .term .xterm .xterm-viewport::-webkit-scrollbar-thumb {
        background: var(--goder-scroll-thumb);
        border-radius: 5px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      .term .xterm .xterm-viewport::-webkit-scrollbar-track {
        background: transparent;
      }
      .veil {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: var(--goder-card);
        color: var(--goder-text-faint);
        font-size: var(--goder-font-size-sm);
        font-family: var(--goder-font);
        border: none;
        padding: 0;
        cursor: default;
        user-select: none;
      }
      .veil.err {
        color: var(--goder-text-dim);
        white-space: pre-wrap;
        text-align: center;
        padding: 0 24px;
      }
      .veil.exit {
        cursor: pointer;
        color: var(--goder-text-dim);
      }
      .veil.exit:hover {
        color: var(--goder-text);
        background: var(--goder-bg-hover);
      }
      .spin {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 1.5px solid var(--goder-border-hover);
        border-top-color: var(--goder-accent);
        animation: spin 0.8s linear infinite;
        flex: none;
        box-sizing: border-box;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ];

  protected firstUpdated(): void {
    void this.boot();
  }

  protected updated(props: PropertyValues<this>): void {
    super.updated(props);
    // cwd 变化(切换项目):重启终端
    if (props.has('cwd') && props.get('cwd') !== undefined) void this.boot();
  }

  disconnectedCallback(): void {
    this.consoleTermOff?.();
    this.consoleTermOff = undefined;
    this.teardown();
    super.disconnectedCallback();
  }

  connectedCallback(): void {
    super.connectedCallback();
    // tab 关闭重开(元素复用、重新插入 DOM):重新拉起 PTY 会话。
    if (this.everBooted && !this.term) void this.boot();
    // 智能体新建终端(goder_terminal_new):当前没有存活会话时接管显示
    // (用户正在跑的会话不打断;智能体会话仍可经 goder_terminal_* 驱动)。
    this.consoleTermOff = onConsoleTerm((id) => {
      if (this.status === 'running' || this.status === 'boot') return;
      this.forcedAdopt = id;
      void this.boot();
    });
  }

  // boot 启动(或重启)PTY 会话:加载 xterm → fit 初尺寸 → StartTerm →
  // 双向数据流(键盘写入 / 事件回显)。
  private async boot(): Promise<void> {
    const cwd = this.cwd;
    this.teardown();
    if (!inWails()) {
      this.status = 'error';
      this.message = '终端仅在桌面应用内可用';
      return;
    }
    // cwd 为空(未选工作区)不再拒绝:Go 侧 StartTerm 默认用户主目录。
    if (this.booting) {
      this.pendingBoot = true;
      return;
    }
    this.booting = true;
    this.everBooted = true;
    this.status = 'boot';
    this.message = '';
    try {
      const [{ Terminal: Term }, { FitAddon: Fit }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (this.cwd !== cwd || !this.isConnected) return; // cwd 已再变/已卸载
      const cs = getComputedStyle(this);
      const tok = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
      const term = new Term({
        fontFamily: tok('--goder-mono', 'ui-monospace, Menlo, monospace'),
        fontSize: 12.5,
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        theme: {
          background: 'rgba(0,0,0,0)',
          foreground: tok('--goder-text', '#d7dae0'),
          cursor: tok('--goder-accent', '#4c8dff'),
        },
      });
      const fit = new Fit();
      term.loadAddon(fit);
      const host = this.renderRoot.querySelector('.term') as HTMLElement | null;
      if (!host) throw new Error('终端容器未就绪');
      term.open(host);
      fit.fit();

      // 智能体接管的会话优先(goder_terminal_new 创建、待界面显示的 PTY):
      // 回放输出缓冲后接续事件流;否则正常新建会话。
      const adopt = this.forcedAdopt ?? consumePendingTerm();
      this.forcedAdopt = undefined;
      let sid = '';
      if (adopt) {
        sid = adopt;
        const back = await readTerm(adopt, 0);
        if (back?.data) term.write(decodeB64(back.data));
      } else {
        const s = await startTerm(cwd, term.cols, term.rows);
        if (!s) throw new Error('无法启动终端(非桌面态)');
        sid = s.id;
      }
      // adopt/readTerm/startTerm 都是 await,期间元素可能已卸载(tab 关
      // 闭/池化重建):此时绝不能再注册 visible —— 否则迟到的注册让会话
      // 永久挂在「界面可见」集合里(goder_terminal_new 会复用这个无面板
      // 的僵尸会话)。立即终止会话并放弃本次 boot。
      if (!this.isConnected) {
        void killTerm(sid);
        term.dispose();
        return;
      }
      this.sessionId = sid;
      this.term = term;
      this.fit = fit;
      registerVisibleTerm(sid);

      this.offs.push(
        onTermEvent(sid, 'data', (b64) => {
          if (b64) term.write(decodeB64(b64));
        }),
      );
      this.offs.push(
        onTermEvent(sid, 'exit', (code) => {
          this.status = 'exited';
          this.message = code;
          unregisterVisibleTerm(sid);
          term.write(`\r\n\x1b[90m[进程已退出${code ? ` (${code})` : ''}]\x1b[0m\r\n`);
        }),
      );
      term.onData((d) => void writeTerm(sid, d));

      this.ro = new ResizeObserver(() => this.scheduleFit());
      this.ro.observe(host);
      this.status = 'running';
    } catch (e) {
      this.status = 'error';
      this.message = e instanceof Error ? e.message : String(e);
    } finally {
      this.booting = false;
      if (this.pendingBoot) {
        this.pendingBoot = false;
        void this.boot();
      }
    }
  }

  // scheduleFit 防抖重算尺寸并同步 PTY(hidden 时尺寸为 0,跳过等可见)。
  private scheduleFit(): void {
    window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      const host = this.renderRoot.querySelector('.term') as HTMLElement | null;
      if (!this.term || !this.fit || !this.sessionId || !host || host.offsetWidth === 0) return;
      try {
        this.fit.fit();
      } catch {
        /* 布局未就绪,下次再试 */
      }
      void resizeTerm(this.sessionId, this.term.cols, this.term.rows);
    }, 60);
  }

  private teardown(): void {
    window.clearTimeout(this.fitTimer);
    this.ro?.disconnect();
    this.ro = undefined;
    for (const off of this.offs) off();
    this.offs = [];
    if (this.sessionId) {
      const id = this.sessionId;
      this.sessionId = undefined;
      unregisterVisibleTerm(id);
      void killTerm(id);
    }
    this.term?.dispose();
    this.term = undefined;
    this.fit = undefined;
  }

  render() {
    return html`
      <div class="wrap">
        <div class="term"></div>
        ${this.status === 'boot'
          ? html`<div class="veil"><span class="spin"></span><span>启动终端…</span></div>`
          : this.status === 'error'
            ? html`<div class="veil err">${this.message || '终端不可用'}</div>`
            : this.status === 'exited'
              ? html`<button class="veil exit" title="重新启动终端" @click=${() => void this.boot()}>
                  <span>终端进程已退出 · 点击重启</span>
                </button>`
              : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-terminal': GoderTerminal;
  }
}
