// model-sheet.ts — 模型选择底部弹层(移动端 chat 头部模型 chip 呼出)+
// 模型菜单的共享渲染件:composer 桌面浮层与底部弹层共用同一套分组列表
// 模板(renderModelGroups)与思考强度选项(EFFORT_OPTIONS),保证两处
// 勾选语义、provider 前缀展示一致。呈现为移动惯用的 bottom sheet:
// 遮罩 + 底部上滑面板(模型分组列表 + 思考强度分段选择),底部让位
// 宿主注入的安全区变量(--safe-inset-bottom)。
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { theme, controls } from '../../ui/panel';
import { fireCompact } from '../../ui/fire';
import { icon } from '../../util/icons';
import { translate } from '../../core/i18n';
import type { ModelMenuGroup } from '../../util/model-menu';

/** 思考强度:值随请求 reasoning.effort 下发,由上游模型解释;空 = 服务端默认 */
export const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' },
];

/** 弹层列表项的勾选图标(composer 桌面浮层同款) */
export const CHECK_SVG = html`
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M3 8.5l3.2 3.2L13 5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

/** 菜单项去掉 provider 前缀(分组标题已显示 provider)。 */
export function shortModel(m: string): string {
  const i = m.indexOf('/');
  return i >= 0 ? m.slice(i + 1) : m;
}

/** 模型分组列表(供应商 → 模型,选中态打勾):composer 桌面浮层与
 *  底部弹层共用的模板;样式由各自的宿主组件提供(类名约定一致)。 */
export function renderModelGroups(
  providers: ModelMenuGroup[],
  active: string,
  onPick: (m: string) => void,
): TemplateResult {
  return html`${providers.map(
    (g) => html`
      <div class="pop-group">${g.name}</div>
      ${g.models.map(
        (m) => html`
          <button class="pop-item" @click=${() => onPick(m)}>
            <span class="check">${m === active ? CHECK_SVG : nothing}</span>
            <span class="tx"><b title=${m}>${shortModel(m)}</b></span>
          </button>
        `,
      )}
    `,
  )}`;
}

/** 底部弹层:数据由宿主(chat-panel)下发,选择结果经事件上抛。 */
@customElement('goder-model-sheet')
export class GoderModelSheet extends LitElement {
  /** 数据域名(i18n) */
  @property({ type: String }) scope = 'default';
  /** 模型菜单数据:供应商 → 模型(空 = 无法枚举) */
  @property({ type: Array }) providers: ModelMenuGroup[] = [];
  /** 当前使用的模型('' = 未选择) */
  @property({ type: String }) model = '';
  /** 选中态模型(菜单打勾;'' = 回落当前模型) */
  @property({ type: String }) activeModel = '';
  /** 思考强度('' = 服务端默认;low/high/max) */
  @property({ type: String }) effort = '';

  private t(key: string): string {
    return translate(this.scope, key);
  }

  private pick(m: string): void {
    fireCompact(this, 'select', m);
    fireCompact(this, 'close', {});
  }

  private pickEffort(v: string): void {
    fireCompact(this, 'effort-change', v);
  }

  private close(): void {
    fireCompact(this, 'close', {});
  }

  /** 空表引导:跳设置的模型分区(chat-panel 接 manage 事件复用守卫跳转) */
  private manage(): void {
    fireCompact(this, 'manage', {});
    this.close();
  }

  static styles = [
    theme,
    controls,
    css`
      :host {
        display: contents;
      }
      .mask {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: 200;
        animation: goder-ms-fade 0.15s ease;
      }
      .sheet {
        position: fixed;
        left: 50%;
        transform: translateX(-50%);
        bottom: 0;
        width: min(100%, 520px);
        box-sizing: border-box;
        background: var(--goder-card);
        border: 1px solid var(--goder-border);
        border-bottom: none;
        border-radius: 16px 16px 0 0;
        box-shadow: var(--goder-shadow);
        z-index: 201;
        display: flex;
        flex-direction: column;
        max-height: 72vh;
        padding-bottom: max(10px, var(--safe-inset-bottom, 0px));
        animation: goder-ms-up 0.18s ease;
      }
      @keyframes goder-ms-up {
        from {
          transform: translateX(-50%) translateY(100%);
        }
      }
      @keyframes goder-ms-fade {
        from {
          opacity: 0;
        }
      }
      .grab {
        flex: none;
        width: 36px;
        height: 4px;
        border-radius: 2px;
        background: var(--goder-border-hover);
        margin: 8px auto 4px;
      }
      .head {
        flex: none;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 16px 8px;
      }
      .head .ht {
        flex: 1;
        font-weight: 600;
        font-size: var(--goder-font-size);
      }
      .head .x {
        border: none;
        background: transparent;
        color: var(--goder-text-faint);
        padding: 6px;
        border-radius: var(--goder-radius-sm);
        cursor: pointer;
      }
      .head .x:hover {
        color: var(--goder-text);
        background: var(--goder-bg-hover);
      }
      .head .x svg {
        width: 14px;
        height: 14px;
        display: block;
      }
      .list {
        min-height: 0;
        overflow-y: auto;
        padding: 0 6px 6px;
        display: grid;
        gap: 1px;
        /* 列表过短时也保持可见的手感高度 */
        min-height: 96px;
      }
      .empty {
        padding: 22px 16px;
        display: grid;
        gap: 10px;
        justify-items: center;
        color: var(--goder-text-faint);
        font-size: var(--goder-font-size-sm);
      }
      /* 分组列表样式:与 composer 桌面浮层同名类保持一致观感 */
      .pop-group {
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
        padding: 6px 8px 2px;
        border-top: 1px solid var(--goder-border-soft);
        margin-top: 3px;
      }
      .pop-item {
        display: flex;
        align-items: flex-start;
        gap: 7px;
        width: 100%;
        text-align: left;
        border: none;
        background: transparent;
        color: var(--goder-text-dim);
        border-radius: var(--goder-radius-sm);
        padding: 10px 8px;
        cursor: pointer;
        font-size: var(--goder-font-size-sm);
        font-family: var(--goder-font);
      }
      .pop-item:active,
      .pop-item.sel {
        background: var(--goder-bg-hover);
        color: var(--goder-text);
      }
      .pop-item .check {
        width: 13px;
        flex: none;
        color: var(--goder-accent-text);
        padding-top: 2px;
      }
      .pop-item .check svg {
        width: 13px;
        height: 13px;
        display: block;
      }
      .pop-item .tx {
        min-width: 0;
      }
      .pop-item .tx b {
        display: block;
        font-weight: 500;
        color: var(--goder-text);
        font-size: var(--goder-font-size-sm);
        overflow-wrap: anywhere;
      }
      /* 思考强度:底部一行分段选择(选中高亮,不打断弹层) */
      .effort {
        flex: none;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px 6px;
        border-top: 1px solid var(--goder-border-soft);
      }
      .effort .lbl {
        flex: none;
        font-size: var(--goder-font-size-xs);
        color: var(--goder-text-faint);
      }
      .seg {
        display: flex;
        gap: 6px;
        flex: 1;
        justify-content: flex-end;
      }
      .seg button {
        border: 1px solid var(--goder-border);
        background: transparent;
        color: var(--goder-text-dim);
        border-radius: 99px;
        padding: 6px 14px;
        font-size: var(--goder-font-size-xs);
        font-family: var(--goder-font);
        cursor: pointer;
      }
      .seg button.on {
        border-color: var(--goder-accent);
        color: var(--goder-accent-text);
        background: var(--goder-accent-soft);
      }
    `,
  ];

  render() {
    const empty = this.providers.length === 0 && !this.model;
    const active = this.activeModel || this.model;
    return html`
      <div class="mask" @click=${this.close}></div>
      <div class="sheet" role="dialog" aria-label=${this.t('选择模型')}>
        <div class="grab"></div>
        <div class="head">
          <span class="ht">${this.t('选择模型')}</span>
          <button class="x" title=${this.t('关闭')} aria-label=${this.t('关闭')} @click=${this.close}>
            ${unsafeHTML(icon.close)}
          </button>
        </div>
        <div class="list">
          ${empty
            ? html`<div class="empty">
                <span>${this.t('暂无模型列表')}</span>
                <button class="primary" @click=${this.manage}>${this.t('去设置配模型')}</button>
              </div>`
            : renderModelGroups(this.providers, active, (m) => this.pick(m))}
        </div>
        <div class="effort">
          <span class="lbl">${this.t('思考强度')}</span>
          <div class="seg">
            ${EFFORT_OPTIONS.map(
              (o) => html`<button class=${o.value === this.effort ? 'on' : ''} @click=${() => this.pickEffort(o.value)}>
                ${this.t(o.label)}
              </button>`,
            )}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goder-model-sheet': GoderModelSheet;
  }
}
