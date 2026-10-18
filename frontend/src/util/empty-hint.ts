// empty-hint.ts — 面板居中空态/错误态提示模板(图标 + 主文案 + 可选
// 副文案)。只共享模板结构;视觉(内边距/居中/绝对铺满等)由消费方的
// .hint / .hint .sub CSS 自定。消费方:inspector/review、inspector/browser。
import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

export function renderEmptyHint(iconSvg: string, text: string, sub?: string): TemplateResult {
  return html`
    <div class="hint">
      ${unsafeHTML(iconSvg)}
      <div>${text}</div>
      ${sub ? html`<div class="sub">${sub}</div>` : nothing}
    </div>
  `;
}
