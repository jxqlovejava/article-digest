#!/usr/bin/env ts-node
/**
 * Migrate: extract opinions from all existing articles.
 * Usage: npm run migrate:opinions
 *
 * Requires LLM_API_KEY to be set.
 */

import { extractAllOpinions } from '../src/services/opinions';
import { loadMeta } from '../src/services/renderer';

async function main() {
  const meta = loadMeta();
  if (meta.length === 0) {
    console.log('No articles found. Exiting.');
    process.exit(0);
  }

  console.log(`Found ${meta.length} articles. Starting opinion extraction...\n`);

  const result = await extractAllOpinions((current, total, filename) => {
    const pct = Math.round((current / total) * 100);
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    process.stdout.write(`\r[${bar}] ${pct}% (${current}/${total}) ${filename.substring(0, 40)}`);
  });

  console.log('\n');
  console.log('Done!');
  console.log(`  Total articles: ${result.total}`);
  console.log(`  With opinions:  ${result.extracted}`);
  console.log(`  Errors:         ${result.errors}`);
}

main().catch((err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
