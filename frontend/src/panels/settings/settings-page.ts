// settings-page.ts — <grf-settings-page>:设置视图的主体工作面板(黑色
// 圆角大卡,与 <grf-chat> 同视觉;头部空白区同为窗口拖拽/双击缩放区)。
// 分区与左栏导航一致,一律经 registry.settings 装配:内置分区(render 留
// 空,由本组件内部实现——外观/模型/Harness 服务与连接、插件、MCP、技能)
// 与三方自定义分区(render 自绘,同 id 重复 add 可覆写内置分区页面)。
// 改动即时生效并自动保存 —— 桌面态配置落 config.json,外观镜像
// localStorage;左栏导航由 app-shell 提供。
import { css, html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { inWails } from '../../host/bridge';
import { registry, type PanelContext, type SettingsSectionDef } from '../../registry/registry';
import { makeTitleDrag, type TitleDrag } from '../../util/titledrag';
import { settingsStore, ACCENTS, FONT_MIN, FONT_MAX, type ThemeMode } from '../../core/settings/settings-store';
import type { ProviderDTO, PluginDTO } from '../../host/bridge';
import type { SettingsSection } from './settings-nav';

@customElement('grf-settings-page')
export class GrfSettingsPage extends GrfPanel {
  /** 当前分区(宿主下发,与左栏导航联动) */
  @property({ type: String }) section: SettingsSection = 'appearance';
  /** 左栏收起时头部左上角显示左边栏开关(展开时开关在左栏顶行) */
  @property({ type: Boolean, attribute: 'left-toggle' }) leftToggle = false;
  /** 左栏当前展开态 */
  @property({ type: Boolean }) leftOn = true;
  /** macOS 桌面态:左栏收起时头部为红绿灯保留悬浮位 */
  @property({ type: Boolean }) leftLights = false;
  /** 无边框桌面平台(Windows/Linux):头部右上为壳自绘的窗口控制
   * (最小化/最大化/关闭)留位 */
  @property({ type: Boolean, attribute: 'win-controls' }) winControls = false;

  /** 自动保存成功的瞬时提示 */
  @state() private savedFlash = false;
  private savedTimer?: ReturnType<typeof setTimeout>;
  /** 常规分区下的服务状态轮询(仅桌面态) */
  private srvTimer?: ReturnType<typeof setInterval>;
  private storeUnsub?: () => void;
  /** 分区注册表订阅(三方 add/hide/remove 时重渲;池中失效条目一并清掉) */
  private offRegistry?: () => void;
  /** 三方自定义分区的元素池:render 返回 HTMLElement 时跨分区切换保活
   * (与右栏 tab 约定一致);def 被替换/移除时条目失效、重新构建 */
  private customPool = new Map<string, { def: SettingsSectionDef; el: HTMLElement }>();
  /** 头部空白区为窗口拖拽区(移动/双击缩放;非桌面态静默) */
  private tdrag: TitleDrag | null = null;
  /** 模型分区:当前选中的供应商名(右侧展示其详情) */
  private selProv: string | null = null;

  /** 当前生效的选中供应商:未选中或已失效时回退到第一个(默认展开)。 */
  private get activeProvName(): string | null {
    const list = settingsStore.modelCfg?.providers ?? [];
    if (list.length && !list.some((x) => x.name === this.selProv)) return list[0].name;
    return this.selProv;
  }
  /** 自动检测进行中 / 结果提示 */
  @state() private detecting = false;
  private detectMsg = '';
  /** 待二次确认删除的供应商名 */
  private pendingDelete: string | null = null;
  private deleteTimer?: ReturnType<typeof setTimeout>;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        height: 100%;
        /* 黑色圆角主面板,与聊天卡一致;底部拉通到窗口底 */
        background: var(--grf-card);
        border-radius: 12px 12px 0 0;
        overflow: hidden;
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        color: var(--grf-text);
      }
      header {
        flex: none;
        display: flex;
        align-items: center;
        gap: 8px;
        /* 固定与左栏顶行同高(40px),分隔线对齐;内容垂直居中 */
        height: 40px;
        padding: 0 14px;
        box-sizing: border-box;
        border-bottom: 1px solid var(--grf-border);
        user-select: none;
        font-weight: 650;
      }
      /* macOS 左栏收起时:窗口红绿灯悬浮于卡片左上,头部左侧让位 */
      header.lights {
        padding-left: 80px;
      }
      /* 无边框桌面平台(Windows/Linux):壳右上角自绘的窗口控制悬浮于卡片右上,右侧让位 */
      header.win {
        padding-right: 106px;
      }
      header .tg {
        background: transparent;
        border: none;
        color: var(--grf-text-faint);
        padding: 3px 5px;
        cursor: pointer;
        border-radius: 5px;
      }
      header .tg:hover {
        color: var(--grf-text);
        background: var(--grf-bg-hover);
      }
      header svg {
        width: 14px;
        height: 14px;
        color: var(--grf-text-faint);
      }
      header .saved {
        margin-left: auto;
        font-size: var(--grf-font-size-xs);
        font-weight: 400;
        color: var(--grf-success);
        opacity: 0;
        transition: opacity 0.2s;
      }
      header .saved.show {
        opacity: 1;
      }
      .scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }
      .body {
        max-width: 620px;
        margin: 0 auto;
        padding: 22px 24px 40px;
        display: grid;
        gap: 26px;
        align-content: start;
      }
      /* 模型分区双栏布局需要更宽的画布 */
      .body.wide {
        max-width: 880px;
      }
      .sec h4 {
        margin: 0 0 12px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        font-weight: 650;
        letter-spacing: 0.4px;
        text-transform: uppercase;
      }
      label {
        display: grid;
        gap: 5px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        margin-bottom: 12px;
      }
      .hint {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        line-height: 1.7;
        margin-top: 4px;
      }
      label.check {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      label.check input {
        width: auto;
      }
      .seg {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .seg button {
        flex: 0 1 auto;
      }
      .seg button.on {
        border-color: var(--grf-accent);
        color: var(--grf-accent-text);
        background: var(--grf-accent-soft);
      }
      .swatches {
        display: flex;
        gap: 10px;
        padding: 2px 0;
      }
      .swatch {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: none;
        padding: 0;
        cursor: pointer;
        position: relative;
      }
      .swatch .c {
        position: absolute;
        inset: 3px;
        border-radius: 50%;
      }
      .swatch.on {
        box-shadow: 0 0 0 2px var(--grf-card), 0 0 0 4px var(--grf-text-dim);
      }
      .swatch:hover {
        filter: brightness(1.15);
      }
      /* 调色盘:原生取色器叠在圆上,点击即弹系统取色面板 */
      .swatch.picker {
        background: conic-gradient(
          from 0deg,
          #e5534b,
          #e5a53c,
          #3fb96f,
          #3ca6e5,
          #8d7ce8,
          #e5637a,
          #e5534b
        );
        display: inline-block;
      }
      .swatch.picker input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
        margin: 0;
        padding: 0;
        border: none;
      }
      .fontsize {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .fontsize input {
        width: 84px;
      }
      .fontsize .unit {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .srv-line {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin: 2px 0 12px;
      }
      .srv-line .ok {
        color: var(--grf-success);
      }
      .srv-line .bad {
        color: var(--grf-error);
      }
      code.tok {
        font-family: var(--grf-mono);
        font-size: 10px;
        background: var(--grf-bg);
        padding: 1px 5px;
        border-radius: 4px;
        user-select: all;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
      /* 供应商/模型双栏布局(参考系统设置:左列表右详情) */
      .models-cols {
        display: grid;
        grid-template-columns: 190px 1fr;
        gap: 12px;
        align-items: start;
      }
      .prov-list {
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        background: var(--grf-bg-raise);
        padding: 5px;
        display: grid;
        gap: 2px;
        align-content: start;
        /* 供应商过多时限高滚动,"添加供应商"按钮随列表滚动 */
        max-height: 420px;
        overflow-y: auto;
      }
      .prov-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        user-select: none;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
      }
      .prov-item:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .prov-item.on {
        background: var(--grf-accent-soft);
        color: var(--grf-accent-text);
      }
      .prov-item .pname {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .prov-item .cnt {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .prov-item.on .cnt {
        color: inherit;
        opacity: 0.8;
      }
      .add-prov {
        justify-content: flex-start;
        margin-top: 3px;
      }
      .prov-detail {
        min-width: 0;
      }
      .prov-detail .prov {
        margin-bottom: 0;
      }
      .prov-body .fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .prov-body .fields label {
        margin-bottom: 0;
      }
      /* 平铺卡片(插件/技能):网格布局,安装与删除为主 */
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 10px;
      }
      .tile {
        position: relative;
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        background: var(--grf-bg-raise);
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      /* 右上角:禁用开关与标签(与右下角删除同一右边缘对齐) */
      .tile .corner {
        position: absolute;
        top: 6px;
        right: 12px; /* 与内容区右缘对齐(卡片左右 padding 12px) */
        display: flex;
        align-items: center;
        gap: 4px;
      }
      /* 右下角:删除 */
      .tile .tacts {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        margin-top: auto;
        padding-top: 6px;
        min-height: 24px;
      }
      .tile .tname {
        /* 右上角留出禁用按钮的空间 */
        max-width: calc(100% - 64px);
        font-size: var(--grf-font-size-sm);
        font-weight: 650;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tile.on {
        border-color: var(--grf-accent);
        background: var(--grf-accent-soft);
      }
      /* 已禁用:整体压暗 */
      .tile.off {
        opacity: 0.55;
      }
      .tile.off .tname {
        text-decoration: line-through;
        text-decoration-thickness: 1px;
      }
      .tile .tsub {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tile .tag {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        background: var(--grf-bg);
        border: 1px solid var(--grf-border);
        border-radius: 999px;
        padding: 1px 7px;
      }
      /* 模型行:可编辑输入框 + 设默认 + 删除;过多时限高滚动 */
      .mlist {
        display: grid;
        gap: 4px;
        align-content: start;
        max-height: 320px;
        overflow-y: auto;
      }
      .mrow {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 6px;
        border-radius: var(--grf-radius-sm);
        border: 1px solid transparent;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
      }
      .mrow:hover {
        background: var(--grf-bg-hover);
      }
      .mrow .minput {
        flex: 1;
        min-width: 0;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-sm);
        padding: 3px 8px;
      }
      .mrow .mdel {
        flex: none;
        padding: 2px 7px;
        font-size: var(--grf-font-size-sm);
      }
      .mrow .mhint {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        user-select: none;
      }
      /* 供应商卡片 */
      .prov {
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        background: var(--grf-bg-raise);
        margin-bottom: 8px;
        overflow: hidden;
      }
      .prov-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        cursor: pointer;
        user-select: none;
      }
      .prov-head:hover {
        background: var(--grf-bg-hover);
      }
      .prov-head .caret {
        color: var(--grf-text-faint);
        font-size: 10px;
        width: 10px;
        flex: none;
      }
      .prov-head .pname {
        font-weight: 650;
        font-size: var(--grf-font-size-sm);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .prov-head .tag {
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-dim);
        background: var(--grf-bg);
        border: 1px solid var(--grf-border);
        border-radius: 999px;
        padding: 1px 7px;
      }
      .prov-head .meta {
        margin-left: auto;
        flex: none;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
      }
      .prov-head .meta.warn {
        color: var(--grf-warn);
      }
      .prov-body {
        border-top: 1px solid var(--grf-border-soft);
        padding: 10px;
        display: grid;
        gap: 10px;
      }
      .prov-body textarea {
        min-height: 58px;
        resize: vertical;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-sm);
      }
      .prov-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.tdrag = makeTitleDrag('button');
    this.storeUnsub = settingsStore.subscribe(() => this.requestUpdate());
    this.offRegistry = registry.settings.subscribe(() => {
      for (const [id, entry] of this.customPool) {
        if (registry.settings.get(id) !== entry.def) this.customPool.delete(id);
      }
      this.requestUpdate();
    });
    if (this.section === 'models' || this.section === 'harness') void settingsStore.loadModelCfg();
    if (this.section === 'plugins' || this.section === 'mcp') void settingsStore.loadPluginsCfg();
    if (this.section === 'skills') void settingsStore.loadSkillsCfg();
    if (this.section === 'plugins') void settingsStore.loadRemotePlugins();
    if (this.section === 'skills') void settingsStore.loadRemoteSkills();
    this.srvTimer = setInterval(() => {
      if (inWails() && this.section === 'harness') void settingsStore.refreshServerStatus();
    }, 4000);
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    this.storeUnsub?.();
    this.storeUnsub = undefined;
    this.offRegistry?.();
    this.offRegistry = undefined;
    if (this.srvTimer) clearInterval(this.srvTimer);
    this.srvTimer = undefined;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = undefined;
    super.disconnectedCallback();
  }

  protected updated(props: Map<string, unknown>): void {
    super.updated(props);
    // 切分区时按需拉取 gh 侧配置(已加载则跳过)。
    if (props.has('section')) {
      if (this.section === 'models' || this.section === 'harness') void settingsStore.loadModelCfg();
      if (this.section === 'plugins' || this.section === 'mcp') void settingsStore.loadPluginsCfg();
      if (this.section === 'skills') void settingsStore.loadSkillsCfg();
      if (this.section === 'plugins') void settingsStore.loadRemotePlugins();
      if (this.section === 'skills') void settingsStore.loadRemoteSkills();
    }
  }

  /** 通用提交:改配置 → 保存落盘 → 即时应用到当前 scope → 闪提示 */
  private commit(patch: Parameters<typeof settingsStore.patchCfg>[0]): void {
    settingsStore.patchCfg(patch);
    void settingsStore.saveCfg(this.scope).then(() => this.flashSaved());
  }

  private flashSaved(): void {
    this.savedFlash = true;
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => (this.savedFlash = false), 1400);
  }

  render() {
    // 标题与图标取分区定义(三方自定义分区经 registry.settings.add 注册;
    // 未注册的分区 id 回落通用设置图标 + 原始 id 展示)
    const def = registry.settings.get(this.section);
    const title = def?.label ?? this.section;
    const ic = def?.icon ?? icon.settings;
    return html`
      <header
        class=${[this.leftLights && !this.leftOn ? 'lights' : '', this.winControls ? 'win' : ''].filter(Boolean).join(' ')}
        @mousedown=${(e: MouseEvent) => this.tdrag?.onDown(e)}
        @dblclick=${(e: MouseEvent) => this.tdrag?.onDbl(e)}
      >
        ${this.leftToggle && !this.leftOn
          ? html`<button class="tg" title="展开会话列表" @click=${() => this.fire('grf-toggle-sessions')}>${unsafeHTML(icon.panelLeft)}</button>`
          : nothing}
        ${unsafeHTML(ic)}
        <span>${title}</span>
        <span class="saved ${this.savedFlash ? 'show' : ''}">${unsafeHTML(icon.check)} 已保存</span>
      </header>
      <div class="scroll">
        <div class="body ${this.section === 'models' || def?.wide ? 'wide' : ''}">${this.renderSection(def)}</div>
      </div>
    `;
  }

  /** 三方分区渲染上下文(与右栏 tab 同构;设置视图无会话上下文,
   * sessionId 为空、shell 为 undefined)。 */
  private get panelCtx(): PanelContext {
    return { scope: this.scope, store: this.store, desktop: inWails() };
  }

  /** 分区主体:定义带 render(三方自定义,或对内置分区的覆写)时渲染之
   * (返回 HTMLElement 进池保活);否则回落内置实现;未知分区给出占位。 */
  private renderSection(def: SettingsSectionDef | undefined): TemplateResult | HTMLElement {
    if (def?.render) {
      const cached = this.customPool.get(def.id);
      if (cached && cached.def === def) return cached.el;
      const out = def.render(this.panelCtx);
      if (out instanceof HTMLElement) {
        this.customPool.set(def.id, { def, el: out });
        return out;
      }
      this.customPool.delete(def.id);
      return out;
    }
    switch (this.section) {
      case 'appearance':
        return this.renderAppearance();
      case 'models':
        return this.renderModels();
      case 'harness':
        return this.renderHarness();
      case 'plugins':
        return this.renderPlugins();
      case 'mcp':
        return this.renderMcp();
      case 'skills':
        return this.renderSkills();
      default:
        return html`<div class="sec"><div class="hint">分区「${def?.label ?? this.section}」不存在或已被移除。</div></div>`;
    }
  }

  // ---------- Harness:服务与连接 + gh 常用设置 ----------

  private renderHarness() {
    const cfg = settingsStore.cfg;
    if (!inWails()) {
      // 纯 web 态:无托管,允许配置直连地址(注意 gh server 无 CORS 头,
      // 浏览器直连需经同源反代,如 grf-web-serve 的 /grf-api)。
      return html`
        <div class="sec">
          <h4>连接</h4>
          <label>
            服务器地址
            <input
              type="text"
              .value=${cfg.remoteUrl}
              @change=${(e: InputEvent) => this.commit({ remoteUrl: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label>
            Token
            <input
              type="password"
              .value=${cfg.remoteToken}
              @change=${(e: InputEvent) => this.commit({ remoteToken: (e.target as HTMLInputElement).value })}
            />
          </label>
          <div class="hint">
            浏览器模式:配置即时应用到当前页面并镜像到本地。gh server 不带
            CORS 头,直连需经同源反代(如 grf-web-serve 的 /grf-api)。
          </div>
        </div>
        ${this.renderGhSettings()}
      `;
    }
    return html`
      <div class="sec">
        <h4>服务</h4>
        <div class="seg" style="margin-bottom:12px">
          <button class=${cfg.serverMode === 'managed' ? 'on' : ''} @click=${() => this.commit({ serverMode: 'managed' })}>
            本地
          </button>
          <button class=${cfg.serverMode === 'remote' ? 'on' : ''} @click=${() => this.commit({ serverMode: 'remote' })}>
            远程
          </button>
        </div>
        ${cfg.serverMode === 'managed'
          ? html`<div class="hint">本地模式使用内置托管的 gh server,无需任何设置。</div>`
          : html`
              <label>
                服务器地址
                <input
                  type="text"
                  .value=${cfg.remoteUrl}
                  @change=${(e: InputEvent) => this.commit({ remoteUrl: (e.target as HTMLInputElement).value })}
                />
              </label>
              <label>
                Token
                <input
                  type="password"
                  .value=${cfg.remoteToken}
                  @change=${(e: InputEvent) => this.commit({ remoteToken: (e.target as HTMLInputElement).value })}
                />
              </label>
              <div class="hint">远程地址经同源代理转发,保存后即时生效。</div>
            `}
      </div>
      ${this.renderGhSettings()}
    `;
  }

  /** 网页形态配置区回落文案:gh 过旧不支持 vs 读取中/失败。 */
  private webAgentHint(what: string): string {
    return settingsStore.agentApi === 'unsupported'
      ? `当前 gh server 版本过旧,暂不支持网页管理${what}(升级 gh server 后可用)。`
      : `正在读取${what}…(长时间无响应请检查上方服务连接)`;
  }

  /** gh settings.json 常用设置(max_steps / mouse / policy);桌面经桥、
   * 网页经 gh server agent API(配置随登录用户隔离)。 */
  private renderGhSettings() {
    if (!inWails() && !settingsStore.modelCfg) return nothing; // 未就绪/不支持
    const mc = settingsStore.modelCfg;
    if (!mc) {
      return html`<div class="sec"><h4>gh 设置</h4><div class="hint">正在读取 gh 配置…</div></div>`;
    }
    const ro = !mc.writable;
    return html`
      <div class="sec">
        <h4>gh 设置</h4>
        <label>
          最大步数(max_steps)
          <select
            .value=${mc.maxSteps != null ? String(mc.maxSteps) : ''}
            ?disabled=${ro}
            @change=${(e: Event) => {
              const raw = (e.target as HTMLSelectElement).value;
              // 空值 = 无限制:不写 max_steps 键,沿用文件原值或省略
              settingsStore.updateGhSettings({ maxSteps: raw === '' ? null : Number(raw) });
            }}
          >
            <option value="">无限制</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <!-- 文件里存在列表外的旧值时原样带出,避免保存时静默篡改 -->
            ${mc.maxSteps != null && ![50, 100, 200].includes(mc.maxSteps)
              ? html`<option value=${String(mc.maxSteps)} selected>${mc.maxSteps}(原值)</option>`
              : nothing}
          </select>
        </label>
        <label>
          权限策略
          <select
            .value=${mc.policy || 'write-workspace'}
            ?disabled=${ro}
            @change=${(e: Event) => settingsStore.updateGhSettings({ policy: (e.target as HTMLSelectElement).value })}
          >
            <option value="write-workspace">工作区(仅工作区内可写)</option>
            <option value="off">完全控制(不限制)</option>
            <!-- 文件里存在映射外的旧值时原样带出,避免保存时静默篡改 -->
            ${mc.policy && mc.policy !== 'write-workspace' && mc.policy !== 'off'
              ? html`<option value=${mc.policy} selected>${mc.policy}(原值)</option>`
              : nothing}
          </select>
        </label>
        <div class="hint">
          写入 <code class="tok">${mc.path}</code>,与终端 gh 共用;清空即沿用文件原值或省略该键。gh server 运行中时,部分改动需重启服务后生效。
        </div>
      </div>
    `;
  }

  // ---------- 智能体扩展:插件 / MCP / 技能 ----------

  /** 已知内置插件的展示名;其余展示文件名。 */
  private pluginLabel(name: string): string {
    const map: Record<string, string> = {
      'grf-browser': '浏览器',
      'grf-computer': '电脑操作',
      'goder-console': '界面控制',
    };
    return map[name] ?? name;
  }

  private isBuiltinPlugin(name: string): boolean {
    return name === 'grf-browser' || name === 'grf-computer' || name === 'goder-console';
  }

  /** 插件分区:平铺卡片,只做安装与删除;内置(浏览器/电脑操作)不可删。 */
  private renderPlugins() {
    const pc = settingsStore.pluginsCfg;
    if (!pc) {
      return html`<div class="sec"><div class="hint">${inWails() ? '正在读取插件配置…' : this.webAgentHint('插件配置')}</div></div>`;
    }
    // 已安装 = 自动发现目录文件 ∪ 显式列表里的本地项(command 型)。
    // Windows 的发现名带 .exe、显式列表存裸名:展示与去重统一按裸名
    // (删除走服务端 名/名.exe 双探测,均兼容)。
    const local = pc.plugins.filter((p) => !p.url).map((p) => p.name);
    const installed = Array.from(new Set([...pc.discovered.map((f) => f.replace(/\.exe$/, '')), ...local]));
    installed.sort();
    const ro = !pc.writable;
    // 服务器上可安装的 = 远端文件减去已安装(宽松匹配 grf- 前缀/.exe 后缀)
    const norm = (s: string) => s.toLowerCase().replace(/\.exe$/, '').replace(/^grf-/, 'grf-');
    const installedNorm = new Set(installed.map(norm));
    const available = (settingsStore.remotePlugins?.files ?? []).filter((f) => !installedNorm.has(norm(f)));
    return html`
      <div class="sec">
        <h4>已安装</h4>
        ${installed.length
          ? html`
              <div class="tiles">
                ${installed.map((name) => {
                  const on = settingsStore.pluginEnabled(name);
                  return html`
                    <div class="tile ${on ? '' : 'off'}">
                      <div class="corner">
                        ${on ? nothing : html`<span class="tag">已禁用</span>`}
                        ${this.isBuiltinPlugin(name) ? html`<span class="tag">内置</span>` : nothing}
                        ${ro
                          ? nothing
                          : html`<button class="ghost" @click=${() => settingsStore.setPluginEnabled(name, !on)}>
                              ${on ? '禁用' : '启用'}
                            </button>`}
                      </div>
                      <div class="tname">${this.pluginLabel(name)}</div>
                      <div class="tsub">${name}</div>
                      <div class="tacts">
                        ${ro || this.isBuiltinPlugin(name)
                          ? nothing
                          : html`<button
                              class="ghost ${this.pendingDelete === name ? 'danger' : ''}"
                              @click=${() => void this.deletePlugin(name)}
                            >
                              ${this.pendingDelete === name ? '确认删除' : '删除'}
                            </button>`}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
          : html`<div class="hint">还没有安装插件。</div>`}
        ${this.agentMsg ? html`<div class="hint">${this.agentMsg}</div>` : nothing}
      </div>
      <div class="sec">
        <h4>在线安装</h4>
        ${settingsStore.remotePlugins === null
          ? html`<div class="hint">${inWails() ? '正在查询官方下载服务器…' : '在线安装请用桌面版;网页形态经上方的插件/MCP 列表管理。'}</div>`
          : available.length
            ? html`
                <div class="tiles">
                  ${available.map(
                    (f) => html`
                      <div class="tile">
                        <div class="tname">${this.pluginLabel(f.replace(/\.exe$/, '').replace(/^grf-/, 'grf-'))}</div>
                        <div class="tsub">${f}</div>
                        <div class="tacts">
                          <button class="ghost" ?disabled=${this.busyAgent} @click=${() => void this.installPlugin(f)}>
                            ${this.busyAgent ? '安装中…' : '安装'}
                          </button>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
            : html`<div class="hint">官方下载服务器上暂无其他可安装插件。</div>`}
        <div class="hint">插件安装到 <code class="tok">${pc.dir}</code>,安装/删除后自动重启 gh server 生效。</div>
      </div>
    `;
  }

  @state() private busyAgent = false;
  @state() private agentMsg = '';

  private async installPlugin(name: string): Promise<void> {
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.installPlugin(name);
    this.busyAgent = false;
    this.agentMsg = err ? `安装失败:${err}` : `已安装 ${name}`;
    if (!err) this.flashSaved();
    this.pendingDelete = null;
    this.requestUpdate();
  }

  private async deletePlugin(name: string): Promise<void> {
    if (this.pendingDelete !== name) {
      this.pendingDelete = name;
      this.requestUpdate();
      if (this.deleteTimer) clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => {
        this.pendingDelete = null;
        this.requestUpdate();
      }, 3000);
      return;
    }
    this.pendingDelete = null;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.removePluginOnline(name);
    this.busyAgent = false;
    this.agentMsg = err ? `删除失败:${err}` : `已删除 ${name}`;
    if (!err) this.flashSaved();
    this.requestUpdate();
  }

  /** 远程 MCP 端点(plugins 数组的 url/token 项)。 */
  private renderMcp() {
    const pc = settingsStore.pluginsCfg;
    if (!pc) {
      return html`<div class="sec"><div class="hint">${inWails() ? '正在读取 MCP 配置…' : this.webAgentHint('MCP 配置')}</div></div>`;
    }
    const ro = !pc.writable;
    // 远程 MCP 依赖显式列表:自动发现模式下先切换。
    // command 为空的项也算远程卡片:新添加的端点(url 尚未填)立即显示。
    const remotes = pc.plugins.filter((p) => p.url || p.command.length === 0);
    if (!pc.explicit) {
      return html`
        <div class="sec">
          <h4>MCP</h4>
          <div class="hint">
            当前为自动发现模式(只加载本地插件目录)。添加远程 MCP 端点需要切换为显式列表。
          </div>
          <button
            ?disabled=${ro}
            @click=${() =>
              settingsStore.updatePlugins({
                explicit: true,
                // 切换时把已发现的本地插件一并带入,避免显式列表为空导致全部停用
                // (条目名用裸名,command 指向目录里的真实文件,Windows 带 .exe)
                plugins: [
                  ...pc.plugins,
                  ...pc.discovered
                    .filter((f) => !pc.plugins.some((x) => x.name === f.replace(/\.exe$/, '')))
                    .map((f) => ({
                      name: f.replace(/\.exe$/, ''),
                      command: [`${pc.dir}/${f}`],
                      url: '',
                      token: '',
                      timeout: 0,
                    })),
                ],
              })}
          >
            切换为显式列表
          </button>
        </div>
      `;
    }
    return html`
      <div class="sec">
        <h4>远程 MCP 端点</h4>
        ${remotes.length
          ? remotes.map((p) => this.renderMcpCard(p, ro))
          : html`<div class="hint">还没有远程 MCP 端点。</div>`}
        ${ro
          ? nothing
          : html`<button @click=${() => this.addMcp()}>${unsafeHTML(icon.plus)} 添加 MCP 端点</button>`}
        <div class="hint">
          远程 MCP 经 Streamable HTTP 接入(写入 settings.json 的 plugins 数组);本地 stdio
          型 MCP 在「插件」分区用启动命令接入。保存后自动重启 gh server 生效。
        </div>
      </div>
    `;
  }

  private renderMcpCard(p: PluginDTO, ro: boolean) {
    return html`
      <div class="prov">
        <div class="prov-head">
          <span class="pname">${p.name}</span>
          <span class="tag">远程</span>
          ${ro
            ? nothing
            : html`<button
                class="ghost ${this.pendingDelete === p.name ? 'danger' : ''}"
                style="margin-left:auto"
                @click=${() => void this.deleteMcp(p.name)}
              >
                ${this.pendingDelete === p.name ? '确认删除' : '删除'}
              </button>`}
        </div>
        <div class="prov-body">
          <div class="fields">
            <label>
              名称
              <input
                type="text"
                .value=${p.name}
                ?disabled=${ro}
                @change=${(e: InputEvent) => this.renameMcp(p.name, (e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              超时(秒,0=默认)
              <input
                type="number"
                min="0"
                .value=${String(p.timeout || 0)}
                ?disabled=${ro}
                @change=${(e: InputEvent) =>
                  settingsStore.updatePlugin(p.name, { timeout: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })}
              />
            </label>
          </div>
          <label>
            URL(Streamable HTTP 端点)
            <input
              type="text"
              .value=${p.url}
              placeholder="https://mcp.example.com/mcp"
              ?disabled=${ro}
              @change=${(e: InputEvent) => settingsStore.updatePlugin(p.name, { url: (e.target as HTMLInputElement).value.trim() })}
            />
          </label>
          <label>
            Bearer Token
            <input
              type="password"
              .value=${p.token}
              placeholder=${!inWails() && p.hasToken ? '已设置(留空保留,输入更换)' : ''}
              ?disabled=${ro}
              @change=${(e: InputEvent) => settingsStore.updatePlugin(p.name, { token: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
      </div>
    `;
  }

  private addMcp(): void {
    const pc = settingsStore.pluginsCfg!;
    let i = 1;
    let name = 'new-mcp';
    while (pc.plugins.some((x) => x.name === name)) name = `new-mcp-${++i}`;
    settingsStore.addPlugin({ name, command: [], url: '', token: '', timeout: 0 });
  }

  /** MCP 端点重命名(摘旧加新,保存时自动重启)。 */
  private renameMcp(oldName: string, raw: string): void {
    const to = raw.trim();
    const pc = settingsStore.pluginsCfg!;
    if (!to || to === oldName || pc.plugins.some((x) => x.name === to)) {
      this.requestUpdate();
      return;
    }
    settingsStore.removePlugin(oldName);
    const src = pc.plugins.find((x) => x.name === oldName);
    settingsStore.addPlugin({ ...(src as PluginDTO), name: to });
    this.pendingDelete = null;
  }

  /** 删除 MCP 端点(二次确认)。 */
  private async deleteMcp(name: string): Promise<void> {
    if (this.pendingDelete !== name) {
      this.pendingDelete = name;
      this.requestUpdate();
      if (this.deleteTimer) clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => {
        this.pendingDelete = null;
        this.requestUpdate();
      }, 3000);
      return;
    }
    this.pendingDelete = null;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    settingsStore.removePlugin(name);
  }

  /** 技能分区:平铺卡片(安装/删除/点开编辑)+ 搜索 + 在线安装。 */
  private renderSkills() {
    const sc = settingsStore.skillsCfg;
    if (!sc) {
      return html`<div class="sec"><div class="hint">${inWails() ? '正在读取技能列表…' : this.webAgentHint('技能列表')}</div></div>`;
    }
    const ro = !sc.writable;
    const kw = this.skillKw.trim().toLowerCase();
    const skills = sc.skills.filter((s) => !kw || s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw));
    // 在线可安装 = 服务器 skills/*.md 减去已装同名技能
    const installed = new Set(sc.skills.map((s) => s.name.toLowerCase()));
    const available = (settingsStore.remoteSkills?.files ?? [])
      .map((f) => f.replace(/\.md$/, ''))
      .filter((n) => !installed.has(n.toLowerCase()));
    return html`
      <div class="sec">
        <h4>已安装</h4>
        <input
          type="text"
          placeholder="搜索已安装技能…"
          .value=${this.skillKw}
          style="margin-bottom:10px"
          @input=${(e: InputEvent) => {
            this.skillKw = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        ${skills.length
          ? html`
              <div class="tiles">
                ${skills.map(
                  (s) => html`
                    <div class="tile ${s.disabled ? 'off' : ''} ${this.selSkill === s.name ? 'on' : ''}">
                      <div class="corner">
                        ${s.disabled ? html`<span class="tag">已禁用</span>` : nothing}
                        ${ro
                          ? nothing
                          : html`<button class="ghost" @click=${() => void this.toggleSkill(s.name, s.disabled)}>
                              ${s.disabled ? '启用' : '禁用'}
                            </button>`}
                      </div>
                      <div class="tname" title="点击编辑" style="cursor:pointer" @click=${() => void this.openSkill(s.name)}>${s.name}</div>
                      <div class="tsub" title=${s.description}>${s.description || '—'}</div>
                      <div class="tacts">
                        ${ro
                          ? nothing
                          : html`<button
                              class="ghost ${this.pendingDelete === s.name ? 'danger' : ''}"
                              @click=${() => void this.deleteSkill(s.name)}
                            >
                              ${this.pendingDelete === s.name ? '确认删除' : '删除'}
                            </button>`}
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`<div class="hint">${kw ? '没有匹配的技能。' : '还没有技能。'}</div>`}
        ${this.agentMsg ? html`<div class="hint">${this.agentMsg}</div>` : nothing}
      </div>
      <div class="sec">
        <h4>在线安装</h4>
        ${settingsStore.remoteSkills === null
          ? html`<div class="hint">${inWails() ? '正在查询官方下载服务器…' : '在线安装请用桌面版;网页形态可新建/编辑/启停自己的技能。'}</div>`
          : available.length
            ? html`
                <div class="tiles">
                  ${available.map(
                    (n) => html`
                      <div class="tile">
                        <div class="tname">${n}</div>
                        <div class="tsub">官方技能</div>
                        <div class="tacts">
                          <button class="ghost" ?disabled=${this.busyAgent} @click=${() => void this.installSkillFile(n)}>
                            ${this.busyAgent ? '安装中…' : '安装'}
                          </button>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
            : html`<div class="hint">官方服务器上暂无其他可安装技能。</div>`}
        ${ro
          ? nothing
          : html`
              <div class="mrow add" style="margin-top:8px">
                <input
                  class="minput"
                  type="text"
                  placeholder="技能名"
                  .value=${this.newSkillName}
                  @input=${(e: InputEvent) => (this.newSkillName = (e.target as HTMLInputElement).value)}
                />
                <input
                  class="minput"
                  type="text"
                  placeholder="SKILL.md 的在线 URL(https://…/SKILL.md)"
                  .value=${this.newSkillUrl}
                  @input=${(e: InputEvent) => (this.newSkillUrl = (e.target as HTMLInputElement).value)}
                />
                <button class="ghost" ?disabled=${this.busyAgent} @click=${() => void this.installSkillURL()}>URL 安装</button>
              </div>
            `}
        <div class="hint">
          技能目录 <code class="tok">${sc.path}</code>,安装/删除后自动重启 gh server 生效;点技能名可编辑 SKILL.md。
        </div>
      </div>
      ${this.selSkill
        ? html`
            <div class="sec">
              <h4>编辑 ${this.selSkill}</h4>
              <textarea
                style="min-height:220px;font-family:var(--grf-mono);font-size:var(--grf-font-size-sm)"
                .value=${this.skillText}
                @input=${(e: InputEvent) => (this.skillText = (e.target as HTMLTextAreaElement).value)}
              ></textarea>
              <div class="actions" style="margin-top:8px">
                ${this.skillMsg ? html`<span class="hint">${this.skillMsg}</span>` : nothing}
                <button class="ghost" @click=${() => this.closeSkill()}>关闭</button>
                <button ?disabled=${ro} @click=${() => void this.saveSkillNow()}>保存</button>
              </div>
            </div>
          `
        : nothing}
    `;
  }

  /** 当前编辑中的技能名与全文(点开时从后端读取)。 */
  private selSkill: string | null = null;
  private skillText = '';
  @state() private skillMsg = '';
  private skillKw = '';
  private newSkillName = '';
  private newSkillUrl = '';

  private async openSkill(name: string): Promise<void> {
    if (this.selSkill === name) {
      this.closeSkill();
      return;
    }
    const text = await settingsStore.readSkill(name);
    this.selSkill = name;
    this.skillText = text ?? '';
    this.skillMsg = '';
    this.requestUpdate();
  }

  private closeSkill(): void {
    this.selSkill = null;
    this.skillText = '';
    this.skillMsg = '';
    this.requestUpdate();
  }

  private async saveSkillNow(): Promise<void> {
    if (!this.selSkill) return;
    const err = await settingsStore.writeSkill(this.selSkill, this.skillText);
    this.skillMsg = err ? `保存失败:${err}` : '已保存';
    this.flashSaved();
    this.requestUpdate();
  }

  /** 删除技能(二次确认)。 */
  private async deleteSkill(name: string): Promise<void> {
    if (this.pendingDelete !== name) {
      this.pendingDelete = name;
      this.requestUpdate();
      if (this.deleteTimer) clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => {
        this.pendingDelete = null;
        this.requestUpdate();
      }, 3000);
      return;
    }
    this.pendingDelete = null;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.removeSkill(name);
    this.busyAgent = false;
    this.agentMsg = err ? `删除失败:${err}` : `已删除技能 ${name}`;
    if (!err) {
      this.flashSaved();
      if (this.selSkill === name) this.closeSkill();
    }
    this.requestUpdate();
  }

  /** 禁用/启用技能(改名 SKILL.md ↔ SKILL.md.disabled)。 */
  private async toggleSkill(name: string, disabled: boolean): Promise<void> {
    this.agentMsg = '';
    // disabled 是点击时状态:当前已禁用 ⇒ 本次动作是启用,直接作为目标启用态传入
    const err = await settingsStore.toggleSkillEnabled(name, disabled);
    this.agentMsg = err ? `操作失败:${err}` : disabled ? `已启用技能 ${name}` : `已禁用技能 ${name}`;
    if (!err) this.flashSaved();
    this.requestUpdate();
  }

  /** 在线安装官方技能。 */
  private async installSkillFile(name: string): Promise<void> {
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.installSkillFile(`${name}.md`);
    this.busyAgent = false;
    this.agentMsg = err ? `安装失败:${err}` : `已安装技能 ${name}`;
    if (!err) this.flashSaved();
    this.requestUpdate();
  }

  /** 从任意 URL 安装 SKILL.md。 */
  private async installSkillURL(): Promise<void> {
    const name = this.newSkillName.trim();
    const url = this.newSkillUrl.trim();
    if (!name || !url) {
      this.agentMsg = '请填写技能名与 SKILL.md 的 URL';
      this.requestUpdate();
      return;
    }
    this.busyAgent = true;
    this.agentMsg = '';
    const err = await settingsStore.installSkillFromURL(name, url);
    this.busyAgent = false;
    this.agentMsg = err ? `安装失败:${err}` : `已安装技能 ${name}`;
    if (!err) {
      this.newSkillName = '';
      this.newSkillUrl = '';
      this.flashSaved();
    }
    this.requestUpdate();
  }

  // ---------- 外观:主题 / 强调色(预设 + 调色盘) / 字号 ----------

  private renderAppearance() {
    const ap = settingsStore.appearance;
    const themes: [ThemeMode, string][] = [
      ['dark', '深色'],
      ['light', '浅色'],
    ];
    // 当前是否为自定义色(非预设 key)
    const custom = !(ap.accent in ACCENTS);
    return html`
      <div class="sec">
        <h4>主题</h4>
        <div class="seg">
          ${themes.map(
            ([k, label]) => html`
              <button class=${ap.theme === k ? 'on' : ''} @click=${() => settingsStore.setAppearance({ theme: k })}>${label}</button>
            `,
          )}
        </div>
      </div>
      <div class="sec">
        <h4>强调色</h4>
        <div class="swatches">
          ${(Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]).map((k) => {
            const a = ACCENTS[k];
            return html`
              <button
                class="swatch ${ap.accent === k ? 'on' : ''}"
                title=${a.label}
                @click=${() => settingsStore.setAppearance({ accent: k })}
              >
                <span class="c" style="background:${a.accent}"></span>
              </button>
            `;
          })}
          <!-- 调色盘:自定义任意颜色 -->
          <label class="swatch picker ${custom ? 'on' : ''}" title="自定义颜色">
            <input
              type="color"
              .value=${custom && ap.accent.startsWith('#') ? ap.accent : '#4c8dff'}
              @input=${(e: InputEvent) => settingsStore.setAppearance({ accent: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
        <div class="hint">点击调色盘可任选颜色;强调色会同步应用到按钮、链接与运行指示等界面元素。</div>
      </div>
      <div class="sec">
        <h4>界面字号</h4>
        <div class="fontsize">
          <button title="减小字号" @click=${() => this.stepFontSize(-0.5)}>−</button>
          <input
            type="number"
            min=${FONT_MIN}
            max=${FONT_MAX}
            step="0.5"
            .value=${String(ap.fontSize)}
            @change=${(e: InputEvent) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v) && v >= FONT_MIN && v <= FONT_MAX) settingsStore.setAppearance({ fontSize: v });
              else this.requestUpdate(); // 越界输入:重渲染拉回当前值
            }}
          />
          <span class="unit">px</span>
          <button title="增大字号" @click=${() => this.stepFontSize(0.5)}>+</button>
        </div>
        <div class="hint">基准字号(${FONT_MIN}–${FONT_MAX}px,步进 0.5);各级文字按比例随基准缩放。</div>
      </div>
      <div class="hint">外观即时生效,并镜像保存到本地,重启后自动恢复。嵌入宿主仍可直接覆盖 --grf-* 变量换肤。</div>
    `;
  }

  private stepFontSize(d: number): void {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round((settingsStore.appearance.fontSize + d) * 2) / 2));
    settingsStore.setAppearance({ fontSize: next });
  }

  // ---------- 模型:供应商/模型双栏(默认模型是 gh 侧概念,goder 不设:
  // 新会话模型按"同项目最近会话 → 全局最近会话"继承,无记录时守卫引导) ----------

  private renderModels() {
    const mc = settingsStore.modelCfg;
    const readOnly = !mc || !mc.writable;

    return html`
      <div class="sec">
        <h4>供应商与模型</h4>
        ${mc
          ? html`
              <div class="models-cols">
                <div class="prov-list">${this.renderProvList(mc.providers, readOnly)}</div>
                <div class="prov-detail">${this.renderProvDetail(readOnly)}</div>
              </div>
              <div class="hint">
                配置保存在 <code class="tok">${mc.path}</code>(其余配置项不受影响)。${inWails()
                  ? '服务运行中时保存后自动重启 gh server 生效。'
                  : '保存后新会话即生效(配置随登录用户隔离;API Key 不回显,留空即保留)。'}
              </div>
            `
          : html`<div class="hint">
              ${inWails()
                ? '正在读取模型配置…'
                : this.webAgentHint('模型配置')}
            </div>`}
      </div>
    `;
  }

  /** 左栏:供应商列表(名称 + 模型数),底部"添加供应商"。 */
  private renderProvList(list: ProviderDTO[], readOnly: boolean) {
    if (!list.length && readOnly) return html`<div class="hint">还没有供应商。</div>`;
    return html`
      ${list.map((p) => {
        const n = (p.models ?? []).length;
        return html`
          <div
            class="prov-item ${this.activeProvName === p.name ? 'on' : ''}"
            title=${p.name}
            @click=${() => {
              this.selProv = p.name;
              this.requestUpdate();
            }}
          >
            <span class="pname">${p.name}</span>
            ${p.managed ? html`<span class="cnt">托管</span>` : nothing}
            <span class="cnt">${n || '—'}</span>
          </div>
        `;
      })}
      ${readOnly
        ? nothing
        : html`<button class="add-prov" @click=${() => this.addProv()}>${unsafeHTML(icon.plus)} 添加供应商</button>`}
    `;
  }

  /** 右栏:选中供应商的详情(连接信息 + 模型列表)。平台托管项
   * (p.managed,嵌入方反代注入)只读展示:连接信息不显示、模型不可增删。 */
  private renderProvDetail(readOnly: boolean) {
    const list = settingsStore.modelCfg?.providers ?? [];
    const p = list.find((x) => x.name === this.activeProvName);
    if (!p) {
      return html`<div class="hint">${list.length ? '从左侧选择一个供应商查看详情。' : '还没有供应商,点左下"添加供应商"新增一个。'}</div>`;
    }
    const ro = readOnly || p.managed === true;
    return html`
      <div class="prov">
        <div class="prov-head" title="当前模型数">
          <span class="pname">${p.name}</span>
          <span class="tag">${p.type || '默认'}</span>
          <span class="meta">${(p.models ?? []).length} 个模型</span>
          ${ro
            ? nothing
            : html`<button
                class="ghost ${this.pendingDelete === p.name ? 'danger' : ''}"
                style="margin-left:auto"
                @click=${() => this.askDelete(p.name)}
              >
                ${this.pendingDelete === p.name ? '确认删除' : '删除'}
              </button>`}
        </div>
        <div class="prov-body">
          ${p.managed
            ? html`<div class="hint" style="margin:0 0 8px">
                平台托管供应商:由平台统一下发与更新(含连接信息与密钥代理),此处仅展示模型清单。
              </div>`
            : html`
          <div class="fields">
            <label>
              名称
              <input
                type="text"
                .value=${p.name}
                ?disabled=${ro}
                @change=${(e: InputEvent) => this.renameProv(p.name, (e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              协议类型
              <select
                .value=${p.type}
                ?disabled=${ro}
                @change=${(e: Event) => this.field(p.name, { type: (e.target as HTMLSelectElement).value })}
              >
                <option value="">默认(OpenAI 兼容)</option>
                <option value="OpenAI">OpenAI</option>
              </select>
            </label>
            <label>
              Base URL
              <input
                type="text"
                .value=${p.baseUrl}
                placeholder="https://api.openai.com/v1"
                ?disabled=${ro}
                @change=${(e: InputEvent) => this.field(p.name, { baseUrl: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                .value=${p.apiKey}
                placeholder=${!inWails() && p.hasKey ? '已设置(留空保留,输入更换)' : 'sk-…(本地服务可留空)'}
                ?disabled=${ro}
                @change=${(e: InputEvent) => this.field(p.name, { apiKey: (e.target as HTMLInputElement).value })}
              />
            </label>
          </div>
          `}
          <div class="mlist">
            ${(p.models ?? []).map((m, i) => {
              return html`
                <div class="mrow">
                  <input
                    class="minput"
                    type="text"
                    .value=${m}
                    ?disabled=${ro}
                    @change=${(e: InputEvent) => this.setModelAt(p.name, i, (e.target as HTMLInputElement).value)}
                  />
                  ${ro
                    ? nothing
                    : html`<button class="ghost mdel" title="删除该模型" @click=${() => this.removeModelAt(p.name, i)}>×</button>`}
                </div>
              `;
            })}
            ${ro
              ? nothing
              : html`
                  <div class="mrow add">
                    <input
                      class="minput"
                      type="text"
                      placeholder="添加模型,如 gpt-4o"
                      @change=${(e: InputEvent) => {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (v) this.addModelRow(p.name, v);
                        else this.requestUpdate();
                      }}
                    />
                    <span class="mhint">回车添加</span>
                  </div>
                `}
          </div>
          ${ro
            ? nothing
            : html`
                <div class="prov-actions">
                  ${this.detectMsg && this.activeProvName === p.name ? html`<span class="hint">${this.detectMsg}</span>` : nothing}
                  <button ?disabled=${this.detecting} @click=${() => void this.detectProvModels(p.name)}>
                    ${this.detecting ? '检测中…' : `${'自动检测'}`}
                  </button>
                </div>
              `}
        </div>
      </div>
    `;
  }

  private field(name: string, patch: Partial<ProviderDTO>): void {
    settingsStore.updateProvider(name, patch);
  }

  /** 改某一行模型名(去空白;与既有名重复时拉回原值)。 */
  private setModelAt(name: string, i: number, raw: string): void {
    const p = (settingsStore.modelCfg?.providers ?? []).find((x) => x.name === name);
    const v = raw.trim();
    if (!p || !v || (p.models ?? [])[i] === v) {
      this.requestUpdate();
      return;
    }
    const ms = [...(p.models ?? [])];
    if (ms.some((m, j) => j !== i && m === v)) {
      this.requestUpdate(); // 重名:拒绝并拉回
      return;
    }
    ms[i] = v;
    this.field(name, { models: ms });
  }

  private removeModelAt(name: string, i: number): void {
    const p = (settingsStore.modelCfg?.providers ?? []).find((x) => x.name === name);
    if (!p) return;
    this.field(name, { models: (p.models ?? []).filter((_, j) => j !== i) });
  }

  private addModelRow(name: string, v: string): void {
    const p = (settingsStore.modelCfg?.providers ?? []).find((x) => x.name === name);
    if (!p) return;
    if ((p.models ?? []).includes(v)) {
      this.requestUpdate(); // 已存在:忽略并清空输入
      return;
    }
    this.field(name, { models: [...(p.models ?? []), v] });
  }

  /** 自动检测:询问供应商 /models 并把结果合并进模型列表。 */
  private async detectProvModels(name: string): Promise<void> {
    this.detecting = true;
    this.detectMsg = '';
    this.requestUpdate();
    const n = await settingsStore.detectProviderModels(name);
    this.detecting = false;
    this.detectMsg = n < 0 ? '检测失败:请检查 Base URL 与 API Key 后重试' : `检测到 ${n} 个模型,已合并进列表`;
    this.requestUpdate();
    this.flashSaved();
  }

  /** 新增一个占位供应商并选中(名称可直接改)。 */
  private addProv(): void {
    const list = settingsStore.modelCfg?.providers ?? [];
    let i = 1;
    let name = 'new-provider';
    while (list.some((p) => p.name === name)) name = `new-provider-${++i}`;
    settingsStore.addProvider({ name, type: '', baseUrl: '', apiKey: '', models: [] });
    this.selProv = name;
    this.requestUpdate();
  }

  private renameProv(oldName: string, raw: string): void {
    // 托管项不可改名(UI 已隐藏输入框,此处兜底防程序化触发)
    if (settingsStore.modelCfg?.providers.find((p) => p.name === oldName)?.managed) {
      this.requestUpdate();
      return;
    }
    const to = raw.trim();
    if (!to || to === oldName) {
      this.requestUpdate(); // 非法输入:重渲染把输入框拉回原值
      return;
    }
    settingsStore.renameProvider(oldName, to);
    if (this.selProv === oldName) this.selProv = to;
    if (this.pendingDelete === oldName) this.pendingDelete = null;
    this.requestUpdate();
  }

  /** 删除需二次确认(3s 内再点一次),避免误删供应商。 */
  private askDelete(name: string): void {
    // 托管项不可删(平台统一下发,UI 已隐藏按钮,此处兜底)
    if (settingsStore.modelCfg?.providers.find((p) => p.name === name)?.managed) return;
    if (this.pendingDelete === name) {
      this.pendingDelete = null;
      if (this.deleteTimer) clearTimeout(this.deleteTimer);
      this.deleteTimer = undefined;
      settingsStore.removeProvider(name);
      if (this.selProv === name) this.selProv = null;
      this.requestUpdate();
      return;
    }
    this.pendingDelete = name;
    this.requestUpdate();
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = setTimeout(() => {
      this.pendingDelete = null;
      this.deleteTimer = undefined;
      this.requestUpdate();
    }, 3000);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-settings-page': GrfSettingsPage;
  }
}
