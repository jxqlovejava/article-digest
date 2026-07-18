/**
 * Fix stacked HTML entities / &nbsp; / &#xx; in meta.json + article HTML
 * for author, handle, title (and author display in article pages).
 *
 * Usage:
 *   node scripts/migrate-text-encoding.js [dataDir]
 * Default dataDir: ./data
 */
const fs = require('fs');
const path = require('path');

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  middot: '·',
  bull: '•',
};

function decodeNumeric(body) {
  if (/^x/i.test(body)) {
    const n = parseInt(body.slice(1), 16);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
    try { return String.fromCodePoint(n); } catch { return ''; }
  }
  const n = parseInt(body, 10);
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function decodeOnce(text) {
  let s = text.replace(/&#(x?[0-9a-fA-F]+);/g, (m, body) => {
    const ch = decodeNumeric(body);
    return ch === '' ? m : ch;
  });
  s = s.replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, name) => {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : m;
  });
  return s;
}

function normalizeScrapedText(input) {
  if (input == null) return '';
  let s = String(input);
  if (!s) return '';
  s = s.replace(/\.html\(false\)$/i, '');
  let prev = '';
  for (let i = 0; i < 8 && s !== prev; i++) {
    prev = s;
    s = s.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
    });
    s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    s = decodeOnce(s);
  }
  s = s.replace(/[\u00a0\u202f\u2007\u2060]/g, ' ');
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  s = s.replace(/[^\S\n]+/g, ' ');
  return s.trim();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function needsFix(s) {
  if (!s) return false;
  return /&(?:amp|nbsp|quot|lt|gt|apos|#\d+|#x[0-9a-f]+);/i.test(s) || /\\u[0-9a-fA-F]{4}/.test(s);
}

function main() {
  const dataDir = path.resolve(process.argv[2] || path.join(process.cwd(), 'data'));
  const metaPath = path.join(dataDir, 'meta.json');
  const articlesDir = path.join(dataDir, 'articles');

  let metaFixed = 0;
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    for (const a of meta) {
      let changed = false;
      for (const field of ['author', 'authorHandle', 'title']) {
        const raw = a[field];
        if (typeof raw !== 'string' || !needsFix(raw)) continue;
        const next = normalizeScrapedText(raw);
        if (next !== raw) {
          a[field] = next;
          changed = true;
        }
      }
      if (changed) {
        metaFixed++;
        console.log('meta', a.fileName, '→', a.author);
      }
    }
    if (metaFixed) {
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    }
  }

  let htmlFixed = 0;
  if (fs.existsSync(articlesDir)) {
    for (const f of fs.readdirSync(articlesDir).filter((x) => x.endsWith('.html'))) {
      const p = path.join(articlesDir, f);
      let html = fs.readFileSync(p, 'utf-8');
      if (!needsFix(html) && !/&amp;amp;/.test(html)) continue;

      let changed = false;
      // author-name / author-handle spans
      html = html.replace(
        /(<span class="author-name">)([\s\S]*?)(<\/span>)/g,
        (_m, a, body, c) => {
          // body may contain only text (already escaped entities as text)
          const plain = normalizeScrapedText(body);
          const next = escapeHtml(plain);
          if (next !== body) changed = true;
          return a + next + c;
        }
      );
      html = html.replace(
        /(<span class="author-handle">)([\s\S]*?)(<\/span>)/g,
        (_m, a, body, c) => {
          // may have leading @
          const hasAt = body.trimStart().startsWith('@');
          const plain = normalizeScrapedText(body.replace(/^@/, ''));
          const next = (hasAt ? '@' : '') + escapeHtml(plain);
          if (next !== body) changed = true;
          return a + next + c;
        }
      );
      // <title>
      html = html.replace(/<title>([\s\S]*?)<\/title>/, (_m, body) => {
        const plain = normalizeScrapedText(body);
        const next = escapeHtml(plain);
        if (next !== body) changed = true;
        return `<title>${next}</title>`;
      });
      // article h1 title
      html = html.replace(
        /(<h1 class="article-title">)([\s\S]*?)(<\/h1>)/g,
        (_m, a, body, c) => {
          const plain = normalizeScrapedText(body);
          const next = escapeHtml(plain);
          if (next !== body) changed = true;
          return a + next + c;
        }
      );

      if (changed) {
        fs.writeFileSync(p, html, 'utf-8');
        htmlFixed++;
        console.log('html', f);
      }
    }
  }

  // Rebuild index page if present so list meta-author is clean after meta fix
  console.log(`done metaFixed=${metaFixed} htmlFixed=${htmlFixed}`);
  console.log('Note: restart app or hit rebuild index so index.html picks up meta author fixes.');
}

main();
