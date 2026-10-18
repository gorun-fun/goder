// spinner.ts — 「运行中」转圈指示(SVG 弧线圆环)共用件。
// 会话列表行(session-list)与状态浮窗自动化任务行(status-pop)共用
// 同一份 SVG 与旋转动画;尺寸由消费方按各自行高自定(.goder-spin 的
// width/height)。注:不用 CSS border 画弧 —— 小尺寸下弧长随角度抖动,
// 看起来像"转到一半重新开始"(原 session-list 注释)。
import { css, html, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

/** 转圈 SVG(经 unsafeHTML 渲染;描边色走 --goder-* 令牌) */
export const SPINNER_SVG =
  '<svg class="goder-spin" viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6" fill="none" stroke="var(--goder-border-hover)" stroke-width="2" />' +
  '<circle cx="8" cy="8" r="6" fill="none" stroke="var(--goder-accent)" stroke-width="2" stroke-linecap="round" stroke-dasharray="16 38" />' +
  '</svg>';

/** 旋转动画(@keyframes 在各 shadow root 内独立,重名无碍)。 */
export const spinnerCss = css`
  @keyframes goder-spin {
    to {
      transform: rotate(360deg);
    }
  }
  svg.goder-spin {
    animation: goder-spin 0.9s linear infinite;
  }
`;

/** 渲染转圈指示(消费方 CSS 给 .goder-spin 定宽高)。 */
export function renderSpinner(): TemplateResult {
  return html`${unsafeHTML(SPINNER_SVG)}`;
}
