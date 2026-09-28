// markdown.test.ts — 安全渲染与基础转换。
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/util/markdown';

describe('renderMarkdown', () => {
  it('全部输入先转义(script 注入不可达)', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('javascript: 链接被拒绝,http(s) 放行', () => {
    expect(renderMarkdown('[a](javascript:alert(1))')).not.toContain('<a ');
    expect(renderMarkdown('[a](https://x.dev)')).toContain('<a href="https://x.dev"');
  });

  it('围栏代码块内容原样转义', () => {
    const out = renderMarkdown('```\n<div>&\n```');
    expect(out).toContain('<pre class="md-code"');
    expect(out).toContain('&lt;div&gt;&amp;');
  });

  it('GFM 表格渲染', () => {
    const out = renderMarkdown('| a | b |\n| --- | ---: |\n| 1 | 2 |');
    expect(out).toContain('<table class="md-table">');
    expect(out).toContain('text-align:right');
  });
});
