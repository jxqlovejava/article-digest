/**
 * Rebuild FTS keyword index only (fast). Does not touch embeddings.
 * Usage: node scripts/reindex-fts.js
 * In Docker: node scripts/reindex-fts.js  (cwd=/app, data at /app/data)
 */
const fs = require('fs');
const path = require('path');

// Prefer compiled dist in production container
let search;
let loadMeta;
try {
  search = require('../dist/services/search');
  loadMeta = require('../dist/services/renderer').loadMeta;
} catch {
  // Local ts-node path not used — require dist after build
  console.error('[reindex-fts] Run after npm run build (need dist/).');
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function main() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.error('[reindex-fts] No articles dir:', ARTICLES_DIR);
    process.exit(1);
  }

  const metaList = loadMeta();
  const metaMap = new Map(metaList.map((m) => [m.fileName, m]));
  const files = fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.html'));
  console.log(`[reindex-fts] articles=${files.length} meta=${metaList.length}`);

  const items = [];
  for (const fileName of files) {
    const meta = metaMap.get(fileName);
    if (!meta) continue;
    let body = '';
    try {
      body = stripHtml(fs.readFileSync(path.join(ARTICLES_DIR, fileName), 'utf-8'));
    } catch {
      body = meta.title || '';
    }
    items.push({
      fileName,
      title: meta.title || fileName,
      author: meta.author || '',
      authorHandle: meta.authorHandle || '',
      body: body.slice(0, 50000),
    });
  }

  const n = search.rebuildFtsIndex(items);
  console.log(`[reindex-fts] FTS rebuilt: ${n} docs`);

  // Smoke-test suggestions
  const kws = search.getSearchSuggestions(5);
  console.log('[reindex-fts] sample keywords:', kws);

  if (typeof search.closeSearchDb === 'function') search.closeSearchDb();
}

main();
