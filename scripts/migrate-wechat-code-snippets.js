/**
 * Normalize WeChat code-snippet HTML in saved article pages.
 *
 * Problem: WeChat encodes code as multi-<code> lines + empty <ul.line-index><li>
 * bullets. Without WeChat CSS the empty <li>s render as disc dots ("• • •") and
 * sibling <code> stay inline (all lines on one row).
 *
 * Usage:
 *   node scripts/migrate-wechat-code-snippets.js [dir]
 * Default dir: data/articles
 */
const fs = require('fs');
const path = require('path');

// Keep in sync with src/services/fetcher.ts normalizeWechatCodeSnippets
function normalizeWechatCodeSnippets(html) {
  if (!html || !/code-snippet__fix/i.test(html)) return html;

  const decodeEntities = (s) =>
    s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, '&');

  const escapeText = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lineToText = (inner) => {
    const plain = inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?span\b[^>]*>/gi, '')
      .replace(/<\/?[^>]+>/g, '');
    return decodeEntities(plain).replace(/\u00a0/g, ' ');
  };

  function flattenWechatPre(attrs, preInner) {
    const lines = [];
    const re = /<code\b[^>]*>([\s\S]*?)<\/code>/gi;
    let m;
    while ((m = re.exec(preInner)) !== null) {
      lines.push(lineToText(m[1]));
    }
    if (lines.length === 0) {
      const text = lineToText(preInner);
      if (!text.trim()) return '';
      return `<pre><code>${escapeText(text)}</code></pre>`;
    }
    const lang =
      (attrs.match(/\bdata-lang=["']([^"']+)["']/i) || [])[1] ||
      (attrs.match(/\blanguage-([a-z0-9_+-]+)/i) || [])[1] ||
      '';
    const classAttr = lang
      ? ` class="language-${lang.replace(/[^a-zA-Z0-9_+-]/g, '')}"`
      : '';
    const dataAttr = lang ? ` data-lang="${lang.replace(/"/g, '')}"` : '';
    return `<pre${classAttr}${dataAttr}><code>${escapeText(lines.join('\n'))}</code></pre>`;
  }

  let out = html.replace(
    /<section\b[^>]*\bcode-snippet__fix\b[^>]*>([\s\S]*?)<\/section>/gi,
    (_full, sectionInner) => {
      const preMatch = sectionInner.match(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/i);
      if (!preMatch) return sectionInner;
      return flattenWechatPre(preMatch[1], preMatch[2]);
    }
  );

  out = out.replace(
    /<pre\b([^>]*\bcode-snippet__[^>]*)>([\s\S]*?)<\/pre>/gi,
    (_full, attrs, preInner) => {
      if (!/<code\b/i.test(preInner)) return _full;
      const codes = preInner.match(/<code\b/gi);
      if (!codes || codes.length <= 1) return _full;
      return flattenWechatPre(attrs, preInner);
    }
  );

  out = out.replace(
    /<ul\b[^>]*\bcode-snippet__line-index\b[^>]*>[\s\S]*?<\/ul>/gi,
    ''
  );

  // Inject CSS safety net into page <style> once (for any residual structure)
  const cssMarker = '/* wechat-code-snippet-fix */';
  if (!out.includes(cssMarker) && out.includes('</style>')) {
    const css = `
    ${cssMarker}
    .article-content .code-snippet__line-index,
    .article-content ul.code-snippet__line-index {
      display: none !important; list-style: none !important; margin: 0 !important; padding: 0 !important;
    }
    .article-content .code-snippet__fix pre > code,
    .article-content pre[class*="code-snippet"] > code {
      display: block; background: none; padding: 0; border-radius: 0; color: inherit;
      white-space: pre-wrap; word-break: break-word;
    }
`;
    out = out.replace('</style>', css + '</style>');
  }

  return out;
}

function main() {
  const dir = path.resolve(process.argv[2] || path.join(process.cwd(), 'data/articles'));
  if (!fs.existsSync(dir)) {
    console.error('dir not found:', dir);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  let changed = 0;
  let scanned = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    const raw = fs.readFileSync(p, 'utf-8');
    if (!/code-snippet__/i.test(raw)) continue;
    scanned++;
    const next = normalizeWechatCodeSnippets(raw);
    if (next !== raw) {
      fs.writeFileSync(p, next, 'utf-8');
      changed++;
      console.log('fixed', f);
    }
  }
  console.log(`done: scanned=${scanned} fixed=${changed} total=${files.length}`);
}

main();
