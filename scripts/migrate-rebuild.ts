/**
 * Migration: rebuild all saved articles to pick up title + media fixes.
 *
 * Usage (on server):
 *   npx ts-node scripts/migrate-rebuild.ts
 *
 * What it does:
 *   1. Reads data/meta.json
 *   2. For each article, re-fetches the tweet via FxTwitter API
 *   3. Re-renders the HTML (media files are skipped if already downloaded)
 *   4. Preserves original pinned / unread states
 *   5. Rebuilds the index page
 *
 * Notes:
 *   - Requires USE_PROXY=1 and HTTPS_PROXY to be set (same as the app)
 *   - Adds 1.5s delay between requests to avoid rate limiting
 *   - Logs failures but continues with remaining articles
 */

import path from 'path';
import { fetchTweet } from '../src/services/fetcher';
import { saveTweet, rebuildIndex, loadMeta, saveMeta } from '../src/services/renderer';
import { parseTweetUrl } from '../src/utils/url';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const META_FILE = path.join(DATA_DIR, 'meta.json');

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const meta = loadMeta();
  if (meta.length === 0) {
    console.log('No articles found in meta.json');
    process.exit(0);
  }

  console.log(`Migrating ${meta.length} articles...\n`);

  let success = 0;
  let failed = 0;
  const failedList: string[] = [];

  for (let i = 0; i < meta.length; i++) {
    const entry = meta[i];
    console.log(`[${i + 1}/${meta.length}] ${entry.title}`);

    const parsed = parseTweetUrl(entry.tweetUrl);
    if (!parsed) {
      console.log(`  SKIP: cannot parse tweetUrl ${entry.tweetUrl}`);
      failed++;
      failedList.push(entry.fileName);
      continue;
    }

    try {
      const tweet = await fetchTweet(parsed);
      await saveTweet(tweet);

      // Restore pinned / unread states (saveTweet overwrites them)
      const updatedMeta = loadMeta();
      const idx = updatedMeta.findIndex(m => m.fileName === entry.fileName);
      if (idx >= 0) {
        if (entry.pinned) {
          updatedMeta[idx].pinned = true;
          updatedMeta[idx].pinnedAt = entry.pinnedAt || Date.now();
        }
        if (!entry.unread) {
          updatedMeta[idx].unread = false;
        }
        saveMeta(updatedMeta);
      }

      success++;
      console.log(`  OK: ${tweet.title || '(no title)'}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL: ${msg}`);
      failedList.push(entry.fileName);
    }

    if (i < meta.length - 1) {
      await sleep(1500); // Rate limit protection
    }
  }

  await rebuildIndex();

  console.log(`\n--- Done ---`);
  console.log(`Success: ${success}`);
  console.log(`Failed:  ${failed}`);
  if (failedList.length > 0) {
    console.log(`Failed files: ${failedList.join(', ')}`);
  }
}

main().catch(err => {
  console.error('Migration crashed:', err);
  process.exit(1);
});
