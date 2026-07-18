import fs from 'fs';
import path from 'path';
import { insertArticle, generateEmbedding, closeSearchDb } from '../src/services/search';
import { loadMeta } from '../src/services/renderer';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function run() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('[migrate-search] No articles directory found.');
    return;
  }

  const metaList = loadMeta();
  const metaMap = new Map(metaList.map(m => [m.fileName, m]));
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));

  console.log(`[migrate-search] Found ${files.length} articles.`);

  // Phase 1: FTS keyword index (fast, synchronous).
  let ftsCount = 0;
  for (const fileName of files) {
    const meta = metaMap.get(fileName);
    if (!meta) {
      console.warn(`[migrate-search] No meta for ${fileName}, skipping.`);
      continue;
    }
    const html = fs.readFileSync(path.join(ARTICLES_DIR, fileName), 'utf-8');
    const body = stripHtml(html);
    insertArticle({
      fileName,
      title: meta.title,
      author: meta.author,
      authorHandle: meta.authorHandle,
      body,
    });
    ftsCount++;
    if (ftsCount % 50 === 0) console.log(`[migrate-search] FTS indexed ${ftsCount}/${files.length}`);
  }
  console.log(`[migrate-search] FTS indexing complete: ${ftsCount} articles.`);

  // Phase 2: semantic embeddings (slow, batched).
  const pending = files
    .map(f => ({ fileName: f, meta: metaMap.get(f) }))
    .filter((item): item is { fileName: string; meta: NonNullable<typeof item.meta> } => !!item.meta);

  const batchSize = 5;
  let embCount = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async ({ fileName, meta }) => {
        const html = fs.readFileSync(path.join(ARTICLES_DIR, fileName), 'utf-8');
        const body = stripHtml(html);
        const text = `${meta.title}\n${meta.author}\n${body}`;
        await generateEmbedding(fileName, text);
        embCount++;
      })
    );
    console.log(`[migrate-search] Embeddings ${Math.min(embCount, pending.length)}/${pending.length}`);
  }

  console.log(`[migrate-search] Done. FTS: ${ftsCount}, embeddings: ${embCount}.`);
}

run()
  .catch(err => {
    console.error('[migrate-search] Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    closeSearchDb();
  });
