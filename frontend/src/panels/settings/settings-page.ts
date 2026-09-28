// settings-page.ts — <grf-settings-page>:设置视图的主体工作面板(黑色
// 圆角大卡,与 <grf-chat> 同视觉;头部空白区同为窗口拖拽/双击缩放区)。
// 只承担壳层:分区标题/已保存提示/滚动画布(wide 分区加宽)与分区
// render 的装配保活(HTMLElement 池)。分区页面本体一律经
// registry.settings 的 render 供给 —— 内置六分区是 sections/ 目录的
// 分区组件(builtin-common 注册时池化),三方自定义分区同通道;同 id
// 重复 add 可覆写内置分区页面。改动即时生效并自动保存(分区组件提交
// 后上抛 grf-saved,头部闪「已保存」);桌面态配置落 config.json,外观
// 镜像 localStorage;左栏导航由 app-shell 提供。
import { css, html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { inWails } from '../../host/bridge';
import { registry, type PanelContext, type SettingsSectionDef } from '../../registry/registry';
import { makeTitleDrag, type TitleDrag } from '../../util/titledrag';
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

  /** 自动保存成功的瞬时提示(分区组件上抛 grf-saved 驱动) */
  @state() private savedFlash = false;
  private savedTimer?: ReturnType<typeof setTimeout>;
  /** 分区注册表订阅(三方 add/hide/remove 时重渲;池中失效条目一并清掉) */
  private offRegistry?: () => void;
  /** 分区 render 返回 HTMLElement 时跨分区切换保活(内置分区组件与
   * 三方自绘分区同一约定;def 被替换/移除时条目失效、重新构建) */
  private customPool = new Map<string, { def: SettingsSectionDef; el: HTMLElement }>();
  /** 头部空白区为窗口拖拽区(移动/双击缩放;非桌面态静默) */
  private tdrag: TitleDrag | null = null;

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
      .hint {
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        line-height: 1.7;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.tdrag = makeTitleDrag('button');
    // 分区组件保存成功后上抛 grf-saved → 头部闪提示(composed 事件,
    // 从分区组件的 shadow DOM 冒出)
    this.addEventListener('grf-saved', () => this.flashSaved());
    this.offRegistry = registry.settings.subscribe(() => {
      for (const [id, entry] of this.customPool) {
        if (registry.settings.get(id) !== entry.def) this.customPool.delete(id);
      }
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.tdrag?.dispose();
    this.tdrag = null;
    this.offRegistry?.();
    this.offRegistry = undefined;
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.savedTimer = undefined;
    super.disconnectedCallback();
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
        <div class="body ${def?.wide ? 'wide' : ''}">${this.renderSection(def)}</div>
      </div>
    `;
  }

  /** 分区渲染上下文(与右栏 tab 同构;设置视图无会话上下文,
   * sessionId 为空、shell 为 undefined)。 */
  private get panelCtx(): PanelContext {
    return { scope: this.scope, store: this.store, desktop: inWails() };
  }

  /** 分区主体:定义带 render 时渲染之(内置六分区是 sections/ 的分区
   * 组件、三方自定义分区自绘;返回 HTMLElement 进池保活);无 render
   * 或未注册的分区给出占位。 */
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
    return html`<div class="hint">分区「${def?.label ?? this.section}」不存在或已被移除。</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-settings-page': GrfSettingsPage;
  }
}
