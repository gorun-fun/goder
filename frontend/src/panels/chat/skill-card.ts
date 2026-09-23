// skill-card.ts — <grf-skill-card>:执行会话 assistant 输出的 <grf-skill>
// 结构块渲染成的技能沉淀卡。技能名 + SKILL.md 正文预览 + 「保存为技能」
// 按钮(点击经 save 事件上报,chat-panel 归一化技能名后经桌面 bridge 落
// 盘 ~/.grf/skills);已保存只读展示。技能写盘仅桌面形态,web 态禁用
// 按钮并提示。
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { theme } from '../../ui/panel';
import { icon } from '../../util/icons';
import { inWails } from '../../host/bridge';

@customElement('grf-skill-card')
export class GrfSkillCard extends LitElement {
  @property() name = '';
  @property() content = '';
  /** 已保存(保存按钮换成已保存标记) */
  @property({ type: Boolean }) saved = false;

  static styles = [
    theme,
    css`
      :host {
        display: block;
        margin: 8px 0;
      }
      .skill-card {
        border: 1px solid var(--grf-border);
        border-radius: var(--grf-radius);
        background: var(--grf-bg-raise);
        overflow: hidden;
      }
      .sc-head {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 8px 10px 6px;
        color: var(--grf-accent-text);
        font-weight: 650;
        font-size: var(--grf-font-size-sm);
      }
      .sc-head svg {
        width: 14px;
        height: 14px;
        flex: none;
      }
      .sc-name {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .sc-body {
        margin: 0;
        padding: 2px 10px 8px;
        font-family: var(--grf-mono);
        font-size: var(--grf-font-size-xs);
        line-height: 1.55;
        color: var(--grf-text-dim);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 140px;
        overflow-y: auto;
      }
      .sc-foot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-top: 1px solid var(--grf-border-soft);
      }
      .sc-foot .primary {
        border: none;
        border-radius: 6px;
        padding: 4px 12px;
        background: var(--grf-accent);
        color: #fff;
        font-size: var(--grf-font-size-xs);
        font-weight: 600;
        cursor: pointer;
      }
      .sc-foot .primary:hover:not(:disabled) {
        filter: brightness(1.1);
      }
      .sc-foot .primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .sc-saved {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: var(--grf-success);
        font-size: var(--grf-font-size-xs);
        font-weight: 600;
      }
      .sc-saved svg {
        width: 12px;
        height: 12px;
      }
      .sc-hint {
        color: var(--grf-text-faint);
        font-size: var(--grf-font-size-xs);
      }
    `,
  ];

  render() {
    return html`
      <div class="skill-card" title="技能:保存到 ~/.grf/skills,设置-技能区可查看,其他会话的 skill 工具可加载">
        <div class="sc-head">${unsafeHTML(icon.bot)}<span class="sc-name">${this.name || '未命名技能'}</span></div>
        <pre class="sc-body">${this.content}</pre>
        <div class="sc-foot">
          ${this.saved
            ? html`<span class="sc-saved">${unsafeHTML(icon.check)} 已保存</span>
              <span class="sc-hint">设置-技能区可查看与编辑</span>`
            : inWails()
              ? html`<button class="primary" @click=${this.onSave}>保存为技能</button>
                <span class="sc-hint">保存后其他会话可通过 skill 工具复用</span>`
              : html`<button class="primary" disabled>保存为技能</button>
                <span class="sc-hint">仅桌面形态可保存技能</span>`}
        </div>
      </div>
    `;
  }

  private onSave(): void {
    this.dispatchEvent(
      new CustomEvent('save', {
        detail: { name: this.name, content: this.content },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grf-skill-card': GrfSkillCard;
  }
}
