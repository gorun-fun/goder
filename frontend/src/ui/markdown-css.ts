// markdown-css.ts — util/markdown.ts 输出元素(.md-p/.md-h/.md-code/
// .md-quote/.md-hr/.md-table…)的样式单一维护点。
// 消费方:panels/chat/chat-panel(scale 'full',消息流正文)、
// panels/files/file-view(scale 'full',文件预览)、panels/updater/
// update-chip(scale 'compact',适配弹窗小尺寸)。
// - scale:尺寸/间距变体。full = 面板正文幅度;compact = 弹窗说明小尺寸。
// - scope:选择器前缀(宿主容器类,默认 '.md')。
// 实现说明:参数化 CSS 无法走 css`` 静态插值(其只接受 CSSResult 与
// number),故拼字符串后经 unsafeCSS 收口 —— 产物即普通 CSSResult,可
// 直接放入 static styles 数组。
// 注意:消息渲染路径(messages.ts 的 chatMarkdown per-scope 分发)不经
// 本文件,这里只管 markdown 输出元素的样式;markdown.ts 新增输出元素类
// 时在此加规则,全部消费方同步生效。
import { unsafeCSS, type CSSResult } from 'lit';

export type MarkdownScale = 'full' | 'compact';

/** 各 scale 的尺寸/间距参数(两变体的历史差异全部收敛于此)。 */
const SCALE: Record<
  MarkdownScale,
  {
    blockGap: string;
    hMargin: string;
    h12Size: string;
    h12Extra: string;
    h3Size: string;
    h456Size: string;
    codePad: string;
    preBg: string;
    prePad: string;
    preCodeLH: string;
    preCodeColor: string;
    listPadLeft: string;
    liMargin: string;
    quotePad: string;
    hrMargin: string;
    tableFont: string;
    cellBorder: string;
    cellPad: string;
    cellFont: string;
  }
> = {
  full: {
    blockGap: '8px',
    hMargin: '14px 0 7px',
    h12Size: '16px',
    h12Extra: 'border-bottom: 1px solid var(--goder-border-soft); padding-bottom: 4px;',
    h3Size: '14.5px',
    h456Size: '13.5px',
    codePad: '1px 5px',
    preBg: '#131418',
    prePad: '10px 12px',
    preCodeLH: '1.6',
    preCodeColor: 'color: #c6cad2;',
    listPadLeft: '22px',
    liMargin: '2px 0',
    quotePad: '2px 12px',
    hrMargin: '12px 0',
    tableFont: '',
    cellBorder: 'var(--goder-border)',
    cellPad: '4px 10px',
    cellFont: 'font-size: var(--goder-font-size-sm);',
  },
  compact: {
    blockGap: '6px',
    hMargin: '8px 0 4px',
    h12Size: 'var(--goder-font-size)',
    h12Extra: '',
    h3Size: 'var(--goder-font-size-sm)',
    h456Size: 'var(--goder-font-size-xs)',
    codePad: '1px 4px',
    preBg: 'var(--goder-bg-raise)',
    prePad: '6px 8px',
    preCodeLH: '1.5',
    preCodeColor: '',
    listPadLeft: '18px',
    liMargin: '1px 0',
    quotePad: '2px 10px',
    hrMargin: '8px 0',
    tableFont: 'font-size: var(--goder-font-size-xs);',
    cellBorder: 'var(--goder-border-soft)',
    cellPad: '3px 7px',
    cellFont: '',
  },
};

/** markdown 输出元素样式(两 scale 共用同一结构,差异只在取值)。 */
export function markdownCss(scale: MarkdownScale, scope = '.md'): CSSResult {
  const v = SCALE[scale];
  const s = scope;
  return unsafeCSS(`
      ${s} > :first-child {
        margin-top: 0;
      }
      ${s} > :last-child {
        margin-bottom: 0;
      }
      ${s} .md-p {
        margin: 0 0 ${v.blockGap};
      }
      ${s} .md-h {
        margin: ${v.hMargin};
        font-weight: 650;
        line-height: 1.4;
      }
      ${s} h1.md-h,
      ${s} h2.md-h {
        font-size: ${v.h12Size};
        ${v.h12Extra}
      }
      ${s} h3.md-h {
        font-size: ${v.h3Size};
      }
      ${s} h4.md-h,
      ${s} h5.md-h,
      ${s} h6.md-h {
        font-size: ${v.h456Size};
      }
      ${s} code {
        font-family: var(--goder-mono);
        font-size: 0.9em;
        background: var(--goder-bg-hover);
        border-radius: 4px;
        padding: ${v.codePad};
      }
      ${s} pre.md-code {
        background: ${v.preBg};
        border: 1px solid var(--goder-border-soft);
        border-radius: var(--goder-radius-sm);
        padding: ${v.prePad};
        overflow: auto;
        margin: 0 0 ${v.blockGap};
      }
      ${s} pre.md-code code {
        background: none;
        padding: 0;
        font-size: var(--goder-font-size-xs);
        line-height: ${v.preCodeLH};
        ${v.preCodeColor}
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      ${s} ul,
      ${s} ol {
        margin: 0 0 ${v.blockGap};
        padding-left: ${v.listPadLeft};
      }
      ${s} li {
        margin: ${v.liMargin};
      }
      ${s} a {
        color: var(--goder-accent-text);
      }
      ${s} blockquote.md-quote {
        margin: 0 0 ${v.blockGap};
        padding: ${v.quotePad};
        border-left: 3px solid var(--goder-border);
        color: var(--goder-text-dim);
      }
      ${s} hr.md-hr {
        border: none;
        border-top: 1px solid var(--goder-border);
        margin: ${v.hrMargin};
      }
      ${s} table.md-table {
        display: block;
        overflow-x: auto;
        max-width: 100%;
        border-collapse: collapse;
        margin: 0 0 ${v.blockGap};
        ${v.tableFont}
      }
      ${s} table.md-table th,
      ${s} table.md-table td {
        border: 1px solid ${v.cellBorder};
        padding: ${v.cellPad};
        text-align: left;
        vertical-align: top;
        ${v.cellFont}
      }
      ${s} table.md-table th {
        background: var(--goder-bg-hover);
        font-weight: 650;
        white-space: nowrap;
      }
`);
}
