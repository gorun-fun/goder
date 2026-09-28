// bottom-dock.ts — <grf-bottom-dock>:底栏 dock(多 tab,按会话分组常驻
// 保活)。从 chat-panel 剥离的通用容器:每个 tab 一个独立实例元素
// (BottomTabDef.create),所有会话的 tab pane 常驻 DOM(隐藏保活),
// 仅「当前会话 + 激活 tab」可见;tab 行只展示当前会话的 tab。展开态由
// 壳层受控(grf-toggle-bottom 上抛),高度可拖。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme } from '../ui/panel';
import { icon } from '../util/icons';
import { registry, type PanelContext, type BottomTabDef } from '../registry/registry';

/** 底栏 tab 实例(每个 tab 一个独立元素,按会话分组常驻保活) */
interface BottomTabInstance {
  uid: string;
  defId: string;
  el: HTMLElement;
}

@customElement('grf-bottom-dock')
export class GrfBottomDock extends GrfPanel {
  /** 展开态(tab 会话保活,收起不销毁) */
  @property({ type: Boolean }) on = false;

  /** 内嵌高度(可拖) */
  @state() private height = 220;
  /** "+" 类型菜单展开态(可用条目 >1 时) */
  @state() private menuOpen = false;
  /** 底栏当前会话的 tab 实例列表(激活切换保活) */
  @state() private tabs: BottomTabInstance[] = [];
  /** 底栏当前激活的 tab uid */
  @state() private activeId = '';
  private dragging = false;
  private seq = 0;
  /** sid → 底栏 tab 组(各会话独立,常驻 DOM 保活) */
  private tabsBySid = new Map<string, BottomTabInstance[]>();
  /** sid → 底栏当前激活的 tab uid */
  private activeBySid = new Map<string, string>();
  /** tab 组当前归属的会话 */
  private poolSid = '';

  static styles = [
    theme,
    css`
      :host {
        display: flex;
        flex-direction: column;
        flex: none;
        min-height: 90px;
        background: transparent;
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        color: var(--grf-text);
      }
      :host(.off) {
        display: none;
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
      :host(.dragging) {
        cursor: row-resize;
      }
      :host(.dragging) .bt-body {
        pointer-events: none;
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
      /* 底栏 "+" 菜单(可用条目 >1 时) */
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
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('pointermove', this.onDrag);
    window.addEventListener('pointerup', this.stopDrag);
    window.addEventListener('pointerdown', this.onWinPointerDown);
  }

  disconnectedCallback(): void {
    window.removeEventListener('pointermove', this.onDrag);
    window.removeEventListener('pointerup', this.stopDrag);
    window.removeEventListener('pointerdown', this.onWinPointerDown);
    this.tabs = [];
    this.activeId = '';
    this.tabsBySid.clear();
    this.activeBySid.clear();
    this.poolSid = '';
    super.disconnectedCallback();
  }

  private onDrag = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const rect = this.getBoundingClientRect();
    // 上限:视口高度的 70%(原 chat-panel 同款约束)
    this.height = Math.min(Math.max(rect.bottom - e.clientY, 90), Math.max(window.innerHeight * 0.7, 90));
  };

  private stopDrag = (): void => {
    this.dragging = false;
    this.classList.remove('dragging');
  };

  private onWinPointerDown = (e: PointerEvent): void => {
    if (!this.menuOpen) return;
    const path = e.composedPath();
    const inMenu = [...this.renderRoot.querySelectorAll('.bt-menu')].some((m) => path.includes(m));
    const inAdd = [...this.renderRoot.querySelectorAll('.bt-ops .op')].some((m) => path.includes(m));
    if (!inMenu && !inAdd) this.menuOpen = false;
  };

  private _ctx?: PanelContext;

  private refreshCtx(): PanelContext {
    this._ctx = {
      scope: this.scope,
      store: this.store,
      sessionId: this.store?.activeSessionId,
      desktop: false,
    };
    return this._ctx;
  }

  protected willUpdate(props: PropertyValues<this>): void {
    super.willUpdate(props);
    this.syncPools();
  }

  protected updated(_props: PropertyValues<this>): void {
    // 展开而没有任何 tab:自动开一个;内容工作目录跟随当前会话的项目
    if (this.on && this.tabs.length === 0) {
      this.addTab();
      return;
    }
    const cwd = this.store?.activeProjectPath() ?? '';
    for (const t of this.tabs) {
      if (t.el && 'cwd' in t.el) (t.el as unknown as { cwd: string }).cwd = cwd;
    }
  }

  // prunePools 清理已不存在的会话(归档/服务器删除/草稿废弃)的 tab 组。
  private prunePools(): void {
    const s = this.store;
    if (!s) return;
    const alive = (sid: string) =>
      sid.startsWith('draft:') ? s.drafts.has(sid) : !!s.index.sessions[sid];
    for (const sid of this.tabsBySid.keys()) {
      if (alive(sid) || sid === this.poolSid) continue;
      this.tabsBySid.delete(sid);
      this.activeBySid.delete(sid);
    }
  }

  // syncPools 会话切换:换入对应会话的 tab 组。各会话的内容常驻 DOM
  // (隐藏保活),切换会话不中断(如 PTY);展开而新会话还没有 tab 时
  // 自动开一个。在 willUpdate 里先于渲染执行,保证渲染取到换入后的组。
  private syncPools(): void {
    this.prunePools();
    const sid = this.store?.activeSessionId ?? '';
    if (sid === this.poolSid) return;
    if (this.poolSid) this.activeBySid.set(this.poolSid, this.activeId);
    this.poolSid = sid;
    this.tabs = this.tabsBySid.get(sid) ?? [];
    this.activeId = this.activeBySid.get(sid) ?? '';
    if (this.on && this.tabs.length === 0) this.addTab();
  }

  private visibleDefs(): BottomTabDef[] {
    return registry.bottom.visible(this.refreshCtx());
  }

  /** addTab 新开一个底栏 tab 并激活(归入当前会话的 tab 组)。 */
  private addTab(defId?: string): void {
    const defs = this.visibleDefs();
    const def = (defId ? defs.find((d) => d.id === defId) : undefined) ?? defs[0];
    if (!def) return;
    const el = def.create(this.refreshCtx());
    const uid = `bt${++this.seq}`;
    this.tabs = [...this.tabs, { uid, defId: def.id, el }];
    this.tabsBySid.set(this.poolSid, this.tabs);
    this.activeId = uid;
    this.activeBySid.set(this.poolSid, uid);
  }

  /** closeTab 关闭指定 tab(移除即销毁其内容);关掉最后一个时收起
   * 底栏,重新展开会自动新开一个。 */
  private closeTab(uid: string): void {
    const idx = this.tabs.findIndex((t) => t.uid === uid);
    if (idx < 0) return;
    const next = this.tabs.filter((_, i) => i !== idx);
    this.tabs = next;
    this.tabsBySid.set(this.poolSid, next);
    if (next.length === 0) {
      this.activeId = '';
      this.activeBySid.set(this.poolSid, '');
      this.fire('grf-toggle-bottom'); // 最后一个关掉:整栏收起
      return;
    }
    if (this.activeId === uid) {
      this.activeId = next[Math.min(idx, next.length - 1)].uid;
      this.activeBySid.set(this.poolSid, this.activeId);
    }
  }

  render() {
    const defs = this.visibleDefs();
    if (defs.length === 0) return nothing;
    return html`
      <div class="gutter-h ${this.on ? '' : 'off'}" @pointerdown=${() => this.startDrag()}></div>
      <div style="height:${this.height}px; display:flex; flex-direction:column; min-height:0">
        <div class="bt-bar">
          ${this.tabs.map((t) => {
            const def = registry.bottom.get(t.defId);
            if (!def) return nothing;
            const n = this.tabs.filter((x) => x.defId === t.defId).indexOf(t) + 1;
            const label = def.titleFor?.(n) ?? `${def.label} ${n}`;
            return html`
              <span
                class="bt-tab ${this.activeId === t.uid ? 'on' : ''}"
                title=${label}
                @click=${() => {
                  this.activeId = t.uid;
                  this.activeBySid.set(this.poolSid, t.uid);
                }}
              >
                ${unsafeHTML(def.icon)}<span>${label}</span>
                <button
                  class="x"
                  title=${this.t('关闭{label}', { label })}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.closeTab(t.uid);
                  }}
                >
                  ${unsafeHTML(icon.close)}
                </button>
              </span>
            `;
          })}
          <span class="bt-ops">
            ${defs.length > 1
              ? html`<button class="op" title=${this.t('新建底栏 tab')} @click=${() => (this.menuOpen = !this.menuOpen)}>${unsafeHTML(icon.plus)}</button>`
              : html`<button class="op" title=${this.t('新建{label}', { label: defs[0].label })} @click=${() => this.addTab()}>${unsafeHTML(icon.plus)}</button>`}
            <button class="op" title=${this.t('收起底栏')} @click=${() => this.fire('grf-toggle-bottom')}>${unsafeHTML(icon.close)}</button>
          </span>
          ${this.menuOpen
            ? html`
                <div class="bt-menu">
                  ${defs.map(
                    (d) => html`
                      <div
                        class="mi"
                        @click=${() => {
                          this.menuOpen = false;
                          this.addTab(d.id);
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
          ${[...this.tabsBySid.entries()].map(([sid, tabs]) =>
            tabs.map(
              (t) => html`<div class="bt-pane ${sid === this.poolSid && this.activeId === t.uid ? 'on' : ''}">${t.el}</div>`,
            ),
          )}
        </div>
      </div>
    `;
  }

  private startDrag(): void {
    this.dragging = true;
    this.classList.add('dragging');
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-bottom-dock': GrfBottomDock;
  }
}
