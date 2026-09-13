// markdown.ts — 极简安全 markdown 渲染:全部输入先 HTML 转义,再做受限
// 转换(标题/代码块/行内代码/粗斜体/链接/列表/引用/表格,其余保持原样
// 文本),不引入第三方依赖,输出可直接 innerHTML。

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 仅放行 http(s) 链接,防 javascript: 注入。
function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

function inline(text: string): string {
  let out = esc(text);
  // 行内代码先占位,避免内部再被转换。
  const codes: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\x00${codes.length - 1}\x00`;
  });
  // 图片 ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, _alt, url) => {
    const href = safeHref(url);
    return href ? `<img src="${esc(href)}" alt="" loading="lazy">` : m;
  });
  // 链接 [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  // 粗斜体
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

// 表格行拆分:去掉首尾竖线,按未转义竖线切分(\| 为字面竖线),单元格
// trim 后原样返回,交给 inline() 转换。
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '|') {
      cur += '|';
      j++;
    } else if (s[j] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += s[j];
    }
  }
  cells.push(cur.trim());
  return cells;
}

// GFM 分隔行(如 | :--- | ---: |):仅由 | : - 空白组成、每格至少一个 -。
// 是则返回每列对齐方式数组,否则 null。
function tableAligns(line: string): string[] | null {
  const cells = splitRow(line);
  if (!cells.length) return null;
  const aligns: string[] = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    aligns.push(l && r ? 'center' : r ? 'right' : 'left');
  }
  return aligns;
}

export function renderMarkdown(src: string): string {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;

  const flushList = (ordered: boolean, items: string[]) => {
    if (!items.length) return;
    const tag = ordered ? 'ol' : 'ul';
    html.push(`<${tag}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`);
  };

  // 表格起点:当前行含竖线且下一行是合法分隔行
  const isTableStart = (idx: number): boolean =>
    idx + 1 < lines.length &&
    !!lines[idx].trim() &&
    lines[idx].includes('|') &&
    tableAligns(lines[idx + 1]) !== null;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾 ```
      html.push(
        `<pre class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      html.push(`<h${level} class="md-h">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // 水平线
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote class="md-quote">${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // GFM 表格:表头行 + 分隔行 + 连续含竖线数据行;列数按表头补齐/截断,
    // 对齐方式取自分隔行(默认左对齐,不加冗余 style)
    if (isTableStart(i)) {
      const head = splitRow(line);
      const aligns = tableAligns(lines[i + 1])!;
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        body.push(splitRow(lines[i]));
        i++;
      }
      const cell = (txt: string, k: number, tag: 'th' | 'td') => {
        const a = aligns[k] ?? 'left';
        return `<${tag}${a !== 'left' ? ` style="text-align:${a}"` : ''}>${inline(txt)}</${tag}>`;
      };
      html.push(
        `<table class="md-table"><thead><tr>${head.map((c, k) => cell(c, k, 'th')).join('')}</tr></thead>` +
          `<tbody>${body
            .map((r) => `<tr>${head.map((_h, k) => cell(r[k] ?? '', k, 'td')).join('')}</tr>`)
            .join('')}</tbody></table>`,
      );
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*[-*+]\s+/, '')));
        i++;
      }
      flushList(false, items);
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')));
        i++;
      }
      flushList(true, items);
      continue;
    }

    // 段落:连续非空行合并
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !isTableStart(i)
    ) {
      buf.push(lines[i]);
      i++;
    }
    html.push(`<p class="md-p">${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return html.join('');
}
