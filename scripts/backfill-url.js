const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
let updated = 0;

for (const entry of meta) {
  if (entry.tweetUrl) continue;
  const htmlPath = path.join(ARTICLES_DIR, entry.fileName);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const m = html.match(/<a href="(https?:\/\/(x\.com|twitter\.com)\/[^"]+)" class="source-link"/);
  if (m) {
    entry.tweetUrl = m[1];
    updated++;
  }
}

fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
console.log(`Backfilled tweetUrl for ${updated} articles`);
