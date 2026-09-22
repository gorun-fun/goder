// settings-nav.ts — <grf-settings-nav>:设置视图的左栏导航。
// 顶部返回工作区,下方分组列分区:条目一律经 registry.settings 装配
// (内置「基础设置」「智能体」两组在 builtin-common 注册,三方自定义分区
// 经 registry.settings.add 注入,缺省归入「扩展」分组)。当前分区由宿主
// (app-shell)持有,经 section 属性下发,切换时冒泡 grf-settings-section
// 事件。底部身份区与 <grf-session-list> 一致。
import { css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { GrfPanel, theme, controls } from '../../ui/panel';
import { icon } from '../../util/icons';
import { inWails } from '../../host/bridge';
import { registry, getSettingsConfig, onSettingsChange, type PanelContext, type SettingsSectionDef } from '../../registry/registry';
import '../sessions/user-chip';

/** 分区 id:内置六个 + 三方自定义(经 registry.settings.add 注册的任意 id) */
export type SettingsSection = 'appearance' | 'models' | 'harness' | 'plugins' | 'mcp' | 'skills' | (string & {});

/** 「智能体」分组的组名(settings.agentGroup:false 时整组隐藏) */
const AGENT_GROUP = '智能体';

/** 三方自定义分区缺省归入的分组标题 */
const DEFAULT_GROUP = '扩展';

@customElement('grf-settings-nav')
export class GrfSettingsNav extends GrfPanel {
  /** 当前分区(宿主下发) */
  @property({ type: String }) section: SettingsSection = 'appearance';
  /** 与 session-list 对齐:嵌入态宿主自管身份区时可隐藏底部 */
  @property({ type: Boolean, attribute: 'no-connection' }) noConnectionFooter = false;

  /** 设置页裁剪变更订阅(configure 的 settings)与分区注册表订阅 */
  private offSettings?: () => void;
  private offRegistry?: () => void;

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--grf-bg-raise);
        font-family: var(--grf-font);
        font-size: var(--grf-font-size);
        color: var(--grf-text);
      }
      /* 整行可点的返回条目(与 file-list 一致) */
      .back {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 9px 12px;
        border-bottom: 1px solid var(--grf-border-soft);
        font-weight: 650;
        font-size: var(--grf-font-size-sm);
        color: var(--grf-text-dim);
        cursor: pointer;
        user-select: none;
      }
      .back:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .back svg {
        width: 13px;
        height: 13px;
        flex: none;
      }
      .list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        padding: 6px 6px 12px;
      }
      .title {
        flex: none;
        padding: 8px 12px 2px;
        font-size: var(--grf-font-size-xs);
        color: var(--grf-text-faint);
        font-weight: 650;
        letter-spacing: 0.4px;
        user-select: none;
      }
      .list .title {
        padding: 10px 12px 8px;
      }
      .item {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 6px 8px;
        border-radius: var(--grf-radius-sm);
        cursor: pointer;
        color: var(--grf-text-dim);
        font-size: var(--grf-font-size-sm);
        user-select: none;
      }
      .item:hover {
        background: var(--grf-bg-hover);
        color: var(--grf-text);
      }
      .item.on {
        background: var(--grf-accent-soft);
        color: var(--grf-accent-text);
      }
      .item svg {
        width: 14px;
        height: 14px;
        flex: none;
      }
      .footbar {
        flex: none;
        border-top: 1px solid var(--grf-border-soft);
        padding: 8px 12px;
        display: flex;
        align-items: center;
        gap: 8px;
        user-select: none;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.offSettings = onSettingsChange(() => this.requestUpdate());
    this.offRegistry = registry.settings.subscribe(() => this.requestUpdate());
  }

  disconnectedCallback(): void {
    this.offSettings?.();
    this.offSettings = undefined;
    this.offRegistry?.();
    this.offRegistry = undefined;
    super.disconnectedCallback();
  }

  protected updated(): void {
    // 当前分区不可见(被 hide / agentGroup 隐藏 / 定义被移除)时,退回
    // 第一个可见分区(shell 的分区状态经事件驱动,这里纠正避免中央区
    // 渲染死角)
    const list = this.visibleDefs();
    if (list.length && !list.some((d) => d.id === this.section)) {
      this.fire('grf-settings-section', list[0].id);
    }
  }

  /** 宿主经 configure 的 settings.agentGroup:false 隐藏「智能体」分组 */
  private get agentHidden(): boolean {
    return getSettingsConfig(this.scope)?.agentGroup === false;
  }

  /** registry.settings 里当前可见的分区定义(按 order 排序;agentGroup
   * 隐藏时滤掉「智能体」组)。 */
  private visibleDefs(): SettingsSectionDef[] {
    const ctx: PanelContext = { scope: this.scope, store: this.store, desktop: inWails() };
    return registry.settings.visible(ctx).filter((d) => !(this.agentHidden && d.group === AGENT_GROUP));
  }

  render() {
    // 分区按 group 归组(内置:基础设置/智能体;三方缺省「扩展」),组间
    // 顺序按组内首个条目的 order 决定(条目列表本身已按 order 排序)
    const groups: [string, SettingsSectionDef[]][] = [];
    for (const def of this.visibleDefs()) {
      const glabel = def.group ?? DEFAULT_GROUP;
      let g = groups.find(([l]) => l === glabel);
      if (!g) {
        g = [glabel, []];
        groups.push(g);
      }
      g[1].push(def);
    }
    return html`
      <div class="back" title="返回工作区" @click=${() => this.fire('grf-close-settings')}>
        ${unsafeHTML(icon.arrowLeft)}
        <span>返回工作区</span>
      </div>
      <div class="list">
        ${groups.map(
          ([glabel, items]) => html`
            <div class="title">${glabel}</div>
            ${items.map(
              (def) => html`
                <div class="item ${this.section === def.id ? 'on' : ''}" @click=${() => this.fire('grf-settings-section', def.id)}>
                  ${unsafeHTML(def.icon ?? icon.settings)}
                  <span>${def.label}</span>
                </div>
              `,
            )}
          `,
        )}
      </div>
      ${this.noConnectionFooter
        ? nothing
        : html`
            <div class="footbar">
              <grf-user-chip scope=${this.scope}></grf-user-chip>
            </div>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-settings-nav': GrfSettingsNav;
  }
}
