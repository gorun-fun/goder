// side-dock.ts — <goder-side-dock>:右栏 dock(tab 行 + 内容元素池)。
// 从 chat-panel 剥离的通用容器:dock 属于壳层布局、与聊天内容无关,
// 剥离后「无聊天但保留右栏」的装配(panels="sessions,sidebar")成立。
// tab 行展开时兼任标题栏角色(高 40px 与左栏顶行/聊天头部拉通):空白区
// 按住拖动 = 移动窗口、双击 = 缩放(经 util/titledrag 转发,非桌面态静默);
// 无 tab 的空态入口页顶部补同款空白拖拽条,保持标题行连续。
// 池化语义与剥离前一致:render 返回 HTMLElement 的条目按 (tab id, 会话)
// 池化保活(跨 tab 开关与会话切换不销毁,如终端 PTY),shared 条目为
// scope 级单例(切会话不动,如嵌入方的项目级面板);条目被 hide 后其
// tab 不再渲染。tab 状态(tabs/active/on)由 app-shell 受控下发,变更经
// goder-side-tab-open/close/activate 冒泡上抛(UI 事件总线在壳层闸门)。
import { css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GoderPanel, theme } from '../ui/panel';
import { icon } from '../util/icons';
import { inWails } from '../host/bridge';
import { makeSessionAlive, closeDockMenuOnOutside, dockMenuTpl, dockMenuCss, dockTabCss } from './dock-shared';
import { makeTitleDrag, type TitleDrag } from '../util/titledrag';
import { registry, sideTabId, type PanelContext, type SideTabDef, type SideTabInstance } from '../registry/registry';

@customElement('goder-side-dock')
export class GoderSideDock extends GoderPanel {
  /** 展开态(收起时隐藏,内部 tab 会话保活) */
  @property({ type: Boolean }) on = false;
  /** 已打开的 tab 实例(有序;受控,由 app-shell 维护) */
  @property({ type: Array }) tabs: SideTabInstance[] = [];
  /** 当前激活的 tab id */
  @property({ type: String }) activeTab = '';
  /** 无边框桌面平台(Windows/Linux):壳右上角自绘窗口控制悬浮于
   * tab 行之上,右侧让位(同 chat 头部的 .win) */
  @property({ type: Boolean, attribute: 'win-controls' }) winControls = false;

  /** 用户拖拽后的宽度(null = 按 tab 默认宽) */
  @state() private width: number | null = null;
  /** "+" 类型菜单展开态与定位 */
  @state() private menuOpen = false;
  @state() private menuLeft = 0;
  private dragging = false;
  /** tab 行空白区的窗口拖拽(移动/双击缩放;非桌面态静默) */
  private tdrag: TitleDrag | null = null;

  /** 返回 HTMLElement 的右栏条目(终端等有状态内容)按 (tab id, 会话)
   * 池化保活:跨 tab 开关与会话切换不销毁元素 */
  private elPool = new Map<string, Map<string, HTMLElement>>();
  /** shared 条目(SideTabDef.shared)的 scope 级单例池:按 tab id 一份,
   * 切会话不动元素(防 DOM 移动致 iframe 重载等副作用) */
  private sharedEls = new Map<string, HTMLElement>();
  /** 池内容当前归属的会话('' = 尚未绑定) */
  private poolSid = '';

  static styles = [
    theme,
    dockTabCss,
    css`
      :host {
        display: flex;
        /* 行布局:拖拽条在左、面板在右,拖拽条被拉伸为通高竖线
         * (列布局会让 4px 拖拽条高度塌 0,分隔线不可见) */
        flex-direction: row;
        min-width: 0;
        min-height: 0;
        flex: 0 1 auto;
        max-width: 65%;
        background: transparent;
        font-family: var(--goder-font);
        font-size: var(--goder-font-size);
        color: var(--goder-text);
      }
      .gutter-side.off,
      aside.side.off {
        display: none;
      }
      /* 右栏面板本体:列布局,承载 tab 行 + 内容区的高度分配。漏掉它
       * (.side-body 的 flex:1 在 block 流里失效)会让内容区高度塌成
       * 内容高:终端点击区残缺、浏览器空态(place-content 居中于
       * 0 高容器)上下溢出盖住地址栏 —— 对齐剥离前 chat-panel 的 .side */
      aside.side {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
      }
      /* 右栏拖拽条:常显一条灰线作为与聊天区的分界,悬停提亮一档 */
      .gutter-side {
        flex: none;
        width: 4px;
        cursor: col-resize;
        position: relative;
      }
      /* 命中区左右各扩 5px:4px 线太细,浏览器 iframe 贴线时几乎点不中 */
      .gutter-side::before {
        content: '';
        position: absolute;
        inset: 0 -5px;
      }
      .gutter-side::after {
        content: '';
        position: absolute;
        inset: 0 1.5px;
        background: var(--goder-border-soft);
      }
      .gutter-side:hover::after {
        background: var(--goder-border-hover);
      }
      /* 拖拽中:禁用右栏内嵌元素的指针事件(尤其浏览器 iframe) */
      :host(.dragging) {
        cursor: col-resize;
      }
      :host(.dragging) .side-body {
        pointer-events: none;
      }
      /* tab 行外包一层定位容器:下拉菜单不能放在 .side-tabs 内 ——
       * 该行横向滚动会把 absolute 子元素裁掉 */
      .tabs-head {
        flex: none;
        position: relative;
      }
      .side-tabs {
        flex: none;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 5px 6px 0;
        border-bottom: 1px solid var(--goder-border);
        user-select: none;
        /* 与左栏顶行/聊天头部同为 40px(含分隔线),三段标题行拉通对齐 */
        height: 40px;
        box-sizing: border-box;
        /* 文件 tab(相对路径标题)可能很多/很长:tab 行横向滚动 */
        overflow-x: auto;
        overflow-y: hidden;
      }
      /* 无边框桌面平台:壳右上角自绘窗口控制(30×3 + 间隙)悬浮于本行,
       * 右侧让位(同 chat 头部 .win) */
      .side-tabs.win {
        padding-right: 106px;
      }
      /* 空态(无 tab 的入口页)顶部空白拖拽条:补齐标题行,空白区可拖动窗口 */
      .tabs-blank {
        flex: none;
        height: 40px;
        box-sizing: border-box;
        border-bottom: 1px solid var(--goder-border);
        user-select: none;
      }
      .stab .stab-t {
        max-width: 170px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* tab chip 基态(display/字号/配色/关闭钮)在 dockTabCss 的
       * .dock-tab 标记类;此处只留本栏差异项(padding/圆角) */
      .stab {
        padding: 4px 8px;
        border-radius: 4px 4px 0 0;
      }
      .stab:hover {
        color: var(--goder-text);
        background: var(--goder-bg-hover);
      }
      /* 激活 tab:白字白下划线,不用强调色 */
      .stab.on {
        color: var(--goder-text);
        border-bottom-color: var(--goder-text);
      }
      .stab svg {
        width: 12px;
        height: 12px;
        flex: none;
      }
      .stab.add {
        color: var(--goder-text-faint);
        border-bottom-color: transparent;
      }
      /* 菜单本体在 dockMenuCss(.dock-menu);实际定位经内联 left 对齐
       * 加号,这里的 left:0 只是兜底 */
      .tabs-head .dock-menu {
        left: 0;
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
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
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
        background: var(--goder-bg-raise);
        border: 1px solid var(--goder-border);
        border-radius: var(--goder-radius);
        color: var(--goder-text-dim);
        font-size: var(--goder-font-size-sm);
        cursor: pointer;
        min-width: 176px;
        justify-content: flex-start;
      }
      .side-empty .entry:hover {
        background: var(--goder-bg-hover);
        color: var(--goder-text);
        border-color: var(--goder-border-hover);
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
      .pane {
        display: none;
      }
      .pane.on {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        min-width: 0;
      }
      .pane > * {
        flex: 1;
        min-height: 0;
        min-width: 0;
      }
      /* 内嵌面板融入底色 */
      .pane > goder-session-detail,
      .pane > goder-review,
      .pane > goder-browser,
      .pane > goder-console {
        background: transparent;
        border-left: none;
      }
    `,
    dockMenuCss,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    // 排除项:tab 本体/关闭键/「+」与下拉菜单(button 兜底未来新增控件)
    this.tdrag = makeTitleDrag('button, .stab, .dock-menu');
    window.addEventListener('pointermove', this.onDrag);
    window.addEventListener('pointerup', this.stopDrag);
    window.addEventListener('pointerdown', this.onWinPointerDown);
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    window.removeEventListener('pointermove', this.onDrag);
    window.removeEventListener('pointerup', this.stopDrag);
    window.removeEventListener('pointerdown', this.onWinPointerDown);
    this.elPool.clear();
    this.sharedEls.clear();
    this.poolSid = '';
    super.disconnectedCallback();
  }

  /** 拖拽参照容器(app-shell 的 .cols)快照:startDrag 时测一次。参照必须
   * 固定 —— 若每帧取 dock 自身 rect,其左缘随宽度实时变化,上限跟着上一帧
   * 宽度走,拖宽越过聊天列保底线时宽度在两个值间振荡(分隔线跳动) */
  private dragRect: DOMRect | null = null;

  private onDrag = (e: PointerEvent): void => {
    if (!this.dragging || !this.dragRect) return;
    const rect = this.dragRect;
    // 右栏拖宽:下限 260(右栏自身可用),上限保留聊天列最小宽度 300。
    // 与剥离前 chat-panel 同语义(整个 cols 容器宽 - 300),宽度对宽度比较;
    // 不能用 dock 左缘的绝对坐标做上限(量纲不符,且随拖拽移动)
    this.width = Math.min(Math.max(rect.right - e.clientX, 260), Math.max(rect.width - 300, 260));
  };

  private stopDrag = (): void => {
    this.dragging = false;
    this.dragRect = null;
    this.classList.remove('dragging');
  };

  // "+" 菜单:点击菜单外任意处关闭(dock 共享逻辑,见 dock-shared)
  private onWinPointerDown = (e: PointerEvent): void => {
    closeDockMenuOnOutside(e, this.renderRoot, this.menuOpen, ['.dock-menu', '.stab.add'], () => {
      this.menuOpen = false;
    });
  };

  /** 面板渲染上下文(registry 条目渲染用)。 */
  private _ctx?: PanelContext;

  private refreshCtx(): PanelContext {
    this._ctx = {
      scope: this.scope,
      store: this.store,
      sessionId: this.store?.activeSessionId,
      desktop: inWails(),
    };
    return this._ctx;
  }

  protected willUpdate(props: PropertyValues<this>): void {
    super.willUpdate(props);
    this.syncPools();
  }

  // prunePools 清理已不存在的会话(归档/服务器删除/草稿废弃)的池化内容:
  // 从 map 移除后元素不再渲染,断开即销毁(如 PTY)。
  private prunePools(): void {
    const s = this.store;
    if (!s) return;
    const alive = makeSessionAlive(s);
    // 注意结构差异:elPool 外层键是 tab id('terminal'/'file:<路径>'…),
    // 会话 id 在内层 map —— 判活必须遍历内层,否则会把 tab id 当会话 id
    // 误判为已死,每次渲染清空侧栏元素池(终端 PTY 随之被杀重启)。
    for (const [tabId, bySid] of this.elPool) {
      for (const sid of bySid.keys()) {
        if (alive(sid) || sid === this.poolSid) continue;
        bySid.delete(sid);
      }
      if (bySid.size === 0) this.elPool.delete(tabId);
    }
  }

  // syncPools 会话切换收敛 + 内容工作目录跟随当前会话的项目(其他会话
  // 的 tab 保持各自目录,不因切换会话被重启)。
  private syncPools(): void {
    this.prunePools();
    const sid = this.store?.activeSessionId ?? '';
    if (sid !== this.poolSid) this.poolSid = sid;
    const cwd = this.store?.activeProjectPath() ?? '';
    const targets: HTMLElement[] = [];
    for (const bySid of this.elPool.values()) targets.push(...bySid.values());
    for (const el of targets) {
      if (el && 'cwd' in el) (el as unknown as { cwd: string }).cwd = cwd;
    }
  }

  /** 当前环境可用的右栏条目。 */
  private sideDefs(): SideTabDef[] {
    return registry.side.visible(this.refreshCtx());
  }

  /** 取(懒建)某会话、某 tab 的保活元素;仅 render 返回 HTMLElement 的
   * 条目走池化,模板条目返回 null。shared 条目走 scope 级单例池。 */
  private pooledEl(def: SideTabDef, key: string | undefined, sid: string): HTMLElement | null {
    const tabId = key !== undefined ? `${def.id}:${key}` : def.id;
    if (def.shared) {
      let el = this.sharedEls.get(tabId);
      if (!el) {
        const out = def.render(this.refreshCtx(), key);
        if (!(out instanceof HTMLElement)) return null; // 模板条目不走池化
        el = out;
        this.sharedEls.set(tabId, el);
      }
      return el;
    }
    let bySid = this.elPool.get(tabId);
    if (!bySid) {
      bySid = new Map();
      this.elPool.set(tabId, bySid);
    }
    let el = bySid.get(sid);
    if (!el) {
      const out = def.render(this.refreshCtx(), key);
      if (!(out instanceof HTMLElement)) return null; // 模板条目不走池化
      el = out;
      bySid.set(sid, el);
    }
    return el;
  }

  /** 某条目当前(会话维度的)池化元素(公开:壳层/宿主对池内元素做编程
   * 操作的通道,如浏览器 tab 导航);模板条目或条目不存在返回 undefined。
   * 单例条目取池化实例,多实例条目取当前会话的实例。 */
  panelEl(defId: string, key?: string): HTMLElement | undefined {
    const def = registry.side.get(defId);
    if (!def) return undefined;
    return this.pooledEl(def, key, this.poolSid || this.store?.activeSessionId || '') ?? undefined;
  }

  // tabLabel 实例标题:显式 title > 条目 titleFor > 条目 label。
  private tabLabel(t: SideTabInstance, defs: SideTabDef[]): string {
    const def = defs.find((d) => d.id === t.defId);
    if (!def) return t.defId;
    return t.title ?? def.titleFor?.(t.key) ?? def.label;
  }

  // toggleMenu 开"+"菜单:打开时实测加号位置,菜单左上角对齐加号左缘
  // (tab 行可横向滚动,加号位置不固定)。右侧空间不足时向左收。
  private toggleMenu(): void {
    if (this.menuOpen) {
      this.menuOpen = false;
      return;
    }
    const add = this.renderRoot.querySelector('.stab.add') as HTMLElement | null;
    if (add) {
      const head = this.renderRoot.querySelector('.tabs-head') as HTMLElement | null;
      const max = head ? head.clientWidth - 170 : add.offsetLeft;
      this.menuLeft = Math.max(0, Math.min(add.offsetLeft, max));
    }
    this.menuOpen = true;
  }

  render() {
    const ctx = this.refreshCtx();
    const defs = this.sideDefs();
    // 打开的 tab 过滤到仍可用的条目(条目被 hide 后其 tab 不再渲染)
    const tabs = this.tabs.filter((t) => defs.some((d) => d.id === t.defId));
    const activeInst = tabs.find((t) => sideTabId(t) === this.activeTab);
    const activeDef = activeInst ? defs.find((d) => d.id === activeInst.defId) : undefined;
    const width = this.width ?? activeDef?.width ?? 300;
    const on = this.activeTab;
    const sid = this.poolSid || this.store?.activeSessionId || '';
    if (!this.on && tabs.length === 0 && defs.length === 0) return nothing;

    return html`
      <div class="gutter-side ${this.on ? '' : 'off'}" @pointerdown=${() => this.startDrag()}></div>
      <aside class="side ${this.on ? '' : 'off'}" style="width:${width}px">
        ${this.renderTabBar(tabs, defs)}
        <div class="side-body">
          ${tabs.map((t) => {
            const def = defs.find((d) => d.id === t.defId)!;
            const active = on === sideTabId(t);
            // 池化条目:所有会话的元素常驻 DOM(隐藏保活,切会话不销毁,
            // PTY/滚动位置都在),仅「当前会话 + 激活 tab」可见;模板条目
            // 轻量,按激活 tab 现渲染。
            const el = this.pooledEl(def, t.key, sid);
            if (el) {
              if (def.shared) {
                // shared 条目:scope 级单例,激活即见,不随会话切换换元素
                return html`<div class="pane ${active ? 'on' : ''}">${el}</div>`;
              }
              const tabId = t.key !== undefined ? `${def.id}:${t.key}` : def.id;
              const bySid = this.elPool.get(tabId) ?? new Map();
              return [...bySid.entries()].map(
                ([ownerSid, pel]) => html`<div class="pane ${active && ownerSid === sid ? 'on' : ''}">${pel}</div>`,
              );
            }
            return html`<div class="pane ${active ? 'on' : ''}">${def.render(ctx, t.key)}</div>`;
          })}
        </div>
      </aside>
    `;
  }

  private startDrag(): void {
    this.dragging = true;
    this.classList.add('dragging');
    // 参照取父容器(壳层 .cols;独立使用时回退自身),拖拽期间不再重测
    this.dragRect = (this.parentElement ?? this).getBoundingClientRect();
  }

  // renderTabBar 右栏顶部 tab 栏;无已开 tab 时显示居中类型入口。
  // passive 条目(如文件)只由外部带 key 打开,不进两个手动打开入口;
  // 已开的 passive tab 照常显示在 tab 行、可激活可关闭。
  private renderTabBar(tabs: SideTabInstance[], defs: SideTabDef[]) {
    const openable = defs.filter((d) => !d.passive);
    if (tabs.length === 0) {
      return html`
        <div class="tabs-blank" @mousedown=${(e: MouseEvent) => this.tdrag?.onDown(e)} @dblclick=${(e: MouseEvent) => this.tdrag?.onDbl(e)}></div>
        <div class="side-empty">
          <div class="hint">${this.t('选择要打开的面板')}</div>
          <div class="entries">
            ${openable.map(
              (d) => html`
                <button class="entry" title=${this.t('打开{label}', { label: d.label })} @click=${() => this.fire('goder-side-tab-open', { defId: d.id } satisfies SideTabInstance)}>
                  ${unsafeHTML(d.icon)}
                  <span>${d.label}</span>
                </button>
              `,
            )}
          </div>
        </div>
      `;
    }
    return html`
      <div
        class="tabs-head"
        @mousedown=${(e: MouseEvent) => this.tdrag?.onDown(e)}
        @dblclick=${(e: MouseEvent) => this.tdrag?.onDbl(e)}
      >
        <div class="side-tabs ${this.winControls ? 'win' : ''}">
          ${tabs.map((t) => {
            const def = defs.find((d) => d.id === t.defId)!;
            const tid = sideTabId(t);
            const label = this.tabLabel(t, defs);
            return html`
              <span class="stab dock-tab ${this.activeTab === tid ? 'on' : ''}" title=${label} @click=${() => this.fire('goder-side-tab-activate', tid)}>
                ${unsafeHTML(def.icon)}
                <span class="stab-t">${label}</span>
                <button
                  class="x"
                  title=${this.t('关闭{label}', { label })}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.fire('goder-side-tab-close', tid);
                  }}
                >
                  ${unsafeHTML(icon.close)}
                </button>
              </span>
            `;
          })}
          <span class="stab dock-tab add" title=${this.t('打开其他面板')} @click=${() => this.toggleMenu()}>${unsafeHTML(icon.plus)}</span>
        </div>
        ${this.menuOpen
          ? dockMenuTpl(
              openable.map((d) => ({
                icon: d.icon,
                label: d.label,
                tag: tabs.some((t) => t.defId === d.id && !d.multi) ? this.t('已打开') : undefined,
                pick: () => {
                  this.menuOpen = false;
                  this.fire('goder-side-tab-open', { defId: d.id } satisfies SideTabInstance);
                },
              })),
              `left:${this.menuLeft}px`,
            )
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-side-dock': GoderSideDock;
  }
}
