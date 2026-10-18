// update-chip.ts — <goder-update-chip>:左栏顶行的「更新」按钮(有可用更新
// 时出现)与更新对话框(展示更新内容 → 确认 → 自动下载并重启)。
// 检查节奏:桌面态首个实例挂载即启动 —— 打开即查、每小时复查;状态放
// 模块级单例,左栏收起导致元素卸载不中断轮询。
// 仅桌面入口引入(shell/builtin-desktop);app-shell 按 custom element
// 是否注册决定渲染,纯 web/嵌入形态模块不加载、不出现。
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { theme, controls } from '../../ui/panel';
import { markdownCss } from '../../ui/markdown-css';
import { renderMarkdown } from '../../util/markdown';
import {
  inWails,
  checkUpdate,
  applyUpdate,
  onUpdateProgress,
  type UpdateInfoDTO,
  type UpdateProgressDTO,
} from '../../host/bridge';

// ---------- 检查循环(模块级单例;与元素生命周期解耦) ----------

let info: UpdateInfoDTO | null = null;
let started = false;
const subs = new Set<() => void>();

function hasUpdate(i: UpdateInfoDTO | null): boolean {
  return !!i && (i.goder.update || i.gh.update);
}

async function refresh(): Promise<void> {
  const r = await checkUpdate();
  if (r) {
    info = r;
    subs.forEach((f) => f());
  }
}

function ensureStarted(): void {
  if (started || !inWails()) return;
  started = true;
  void refresh();
  window.setInterval(() => void refresh(), 60 * 60 * 1000);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/**
 * 左栏「更新」按钮 + 更新对话框(桌面专属)。
 */
@customElement('goder-update-chip')
export class GoderUpdateChip extends LitElement {
  @state() private info: UpdateInfoDTO | null = null;
  @state() private open = false;
  /** 应用中进度(null = 尚未开始应用) */
  @state() private prog: UpdateProgressDTO | null = null;
  @state() private error = '';
  private offSub?: () => void;
  private offProg?: () => void;
  /** 各组件完成回调(waitDone 的挂起点,进度事件路由进来) */
  private pending: Partial<Record<'goder' | 'gh', (phase: string) => void>> = {};

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: inline-flex;
        align-items: center;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-accent-text);
        background: var(--goder-accent-soft);
        border: 1px solid transparent;
        border-radius: 999px;
        padding: 2px 9px;
        line-height: 1.5;
      }
      .chip:hover:not(:disabled) {
        background: var(--goder-accent-soft);
        border-color: var(--goder-accent);
        filter: brightness(1.2);
      }
      .chip .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--goder-accent);
        flex: none;
      }
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 300;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .dlg {
        width: 430px;
        max-width: calc(100vw - 48px);
        display: flex;
        flex-direction: column;
        gap: 12px;
        background: var(--goder-bg-raise);
        border: 1px solid var(--goder-border);
        border-radius: var(--goder-radius);
        box-shadow: var(--goder-shadow);
        padding: 16px 18px;
      }
      .dlg h3 {
        margin: 0;
        font-size: var(--goder-font-size);
        font-weight: 600;
      }
      .comps {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .comp .row {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .comp .name {
        font-weight: 600;
        flex: none;
      }
      .comp .ver {
        font-family: var(--goder-mono);
        font-size: var(--goder-font-size-sm);
        color: var(--goder-text-dim);
        word-break: break-all;
      }
      .comp .arrow {
        color: var(--goder-accent-text);
      }
      .comp .note {
        margin-top: 6px;
        word-break: break-word;
        color: var(--goder-text-dim);
        font-size: var(--goder-font-size-sm);
        background: var(--goder-bg);
        border: 1px solid var(--goder-border-soft);
        border-radius: var(--goder-radius-sm);
        padding: 8px 10px;
        max-height: 170px;
        overflow: auto;
        line-height: 1.6;
        overflow-wrap: anywhere;
      }
      .hint {
        color: var(--goder-text-faint);
        font-size: var(--goder-font-size-xs);
      }
      .err {
        color: var(--goder-error);
        font-size: var(--goder-font-size-sm);
        word-break: break-all;
      }
      .progress {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .progress .line {
        display: flex;
        justify-content: space-between;
        font-size: var(--goder-font-size-sm);
        color: var(--goder-text-dim);
      }
      .progress .bar {
        height: 4px;
        border-radius: 2px;
        background: var(--goder-bg-active);
        overflow: hidden;
      }
      .progress .bar i {
        display: block;
        height: 100%;
        background: var(--goder-accent);
        transition: width 0.2s;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
    `,
    /* 说明框内 markdown 元素(紧凑版,适配弹窗小尺寸)——单一维护点 */
    markdownCss('compact', '.comp .note'),
  ];

  connectedCallback(): void {
    super.connectedCallback();
    ensureStarted();
    this.info = info;
    this.offSub = subscribe(() => {
      this.info = info;
    });
  }

  disconnectedCallback(): void {
    this.offSub?.();
    this.offSub = undefined;
    this.offProg?.();
    this.offProg = undefined;
    super.disconnectedCallback();
  }

  // ---------- 应用更新 ----------

  /** 进度事件:刷新展示,并把终态(done/error;goder 的 restart 视为完成
   * —— 之后进程即将退出)路由给 waitDone。 */
  private handleProgress = (p: UpdateProgressDTO): void => {
    this.prog = p;
    const res = this.pending[p.which];
    if (!res) return;
    const finished =
      p.phase === 'done' || p.phase === 'error' || (p.which === 'goder' && p.phase === 'restart');
    if (!finished) return;
    if (p.phase === 'error') this.error = p.msg || '更新失败';
    delete this.pending[p.which];
    res(p.phase);
  };

  /** 等某组件到终态;超时兜底(Go 侧崩溃时不至于永久挂起)。 */
  private waitDone(which: 'goder' | 'gh', timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        delete this.pending[which];
        resolve('timeout');
      }, timeoutMs);
      this.pending[which] = (phase) => {
        window.clearTimeout(timer);
        resolve(phase);
      };
    });
  }

  /** 确认更新:依次应用 gh(完成后服务自动重启)与 goder(下载 → 安装 →
   * 重启整个应用),全程进度条展示。 */
  private async startUpdate(): Promise<void> {
    this.error = '';
    this.offProg?.();
    this.offProg = onUpdateProgress(this.handleProgress);
    try {
      if (this.info?.gh.update) {
        const err = await applyUpdate('gh');
        if (err) {
          this.error = err;
          return;
        }
        if ((await this.waitDone('gh', 20 * 60_000)) === 'error') return;
      }
      if (this.info?.goder.update) {
        const err = await applyUpdate('goder');
        if (err) {
          this.error = err;
          return;
        }
        const phase = await this.waitDone('goder', 20 * 60_000);
        if (phase === 'timeout') this.error = '应用未能自动退出,请手动重启';
        return; // restart/done:进程即将被新版本接管
      }
    } finally {
      // gh-only 完成:重查刷新按钮状态,无待更新项则收起对话框
      void (async () => {
        await refresh();
        if (!this.info?.goder.update && !this.error) this.open = false;
      })();
    }
  }

  private get applying(): boolean {
    return !!this.prog && this.prog.phase !== 'done' && this.prog.phase !== 'error' && !this.error;
  }

  // ---------- 渲染 ----------

  render() {
    if (!hasUpdate(this.info)) return nothing;
    return html`
      <button class="chip" title="发现新版本" @click=${() => (this.open = true)}>
        <span class="dot"></span>更新
      </button>
      ${this.open ? this.renderDialog() : nothing}
    `;
  }

  private renderDialog() {
    const i = this.info;
    if (!i) return nothing;
    const applying = this.applying;
    return html`
      <div
        class="overlay"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget && !applying) this.open = false;
        }}
      >
        <div class="dlg" role="dialog" aria-label="软件更新">
          <h3>软件更新</h3>
          <div class="comps">
            ${i.goder.update ? this.renderComp('Goder', i.goder.current, i.goder.latest, i.goderNote) : nothing}
            ${i.gh.update ? this.renderComp('gh(grf-harness)', i.gh.current, i.gh.latest, i.ghNote) : nothing}
          </div>
          ${applying && this.prog ? this.renderProgress(this.prog) : nothing}
          ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
          ${!applying && !this.error ? html`<div class="hint">更新将自动下载并重启应用</div>` : nothing}
          <div class="actions">
            <button ?disabled=${applying} @click=${() => (this.open = false)}>稍后</button>
            <button class="primary" ?disabled=${applying} @click=${() => void this.startUpdate()}>
              更新并重启
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderComp(name: string, cur: string, latest: string, note: string) {
    return html`
      <div class="comp">
        <div class="row">
          <span class="name">${name}</span>
          <span class="ver">${cur || '?'} <span class="arrow">→</span> ${latest}</span>
        </div>
        ${note ? html`<div class="note">${unsafeHTML(renderMarkdown(note))}</div>` : nothing}
      </div>
    `;
  }

  private renderProgress(p: UpdateProgressDTO) {
    const pct = p.phase === 'download' ? Math.max(0, Math.min(100, p.pct)) : 100;
    const label =
      p.phase === 'download'
        ? `下载中${p.which === 'gh' ? ' gh' : ''}`
        : p.phase === 'install'
          ? '安装中'
          : '重启中';
    return html`
      <div class="progress">
        <div class="line"><span>${p.msg || label}</span><span>${p.phase === 'download' ? `${pct}%` : ''}</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-update-chip': GoderUpdateChip;
  }
}
