#!/usr/bin/env node
/**
 * A/B: turndown vs markitdown on the same HTML file or stdin.
 *
 *   node scripts/compare-html-md.js sample.html
 *   curl -s URL | node scripts/compare-html-md.js -
 */
const fs = require('fs');
const path = require('path');

// Prefer compiled dist if present, else ts-node-less inline require via built dist
let htmlToMarkdown, cleanWebpageMarkdown, contentScore, convertHtmlWithMarkitdown;
try {
  ({
    htmlToMarkdown,
    cleanWebpageMarkdown,
    contentScore,
  } = require('../dist/services/htmlToMarkdown'));
  ({ convertHtmlWithMarkitdown } = require('../dist/services/markitdownBridge'));
} catch {
  console.error('Run npm run build first so dist/services/* exists.');
  process.exit(1);
}

async function readInput() {
  const arg = process.argv[2];
  if (!arg || arg === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(path.resolve(arg), 'utf8');
}

function snippet(s, n = 400) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

async function main() {
  const html = await readInput();
  if (!html.trim()) {
    console.error('empty input');
    process.exit(1);
  }

  const photosT = [];
  let turndownMd = htmlToMarkdown(html, photosT);
  turndownMd = cleanWebpageMarkdown(turndownMd, { isFeishu: true });
  const tScore = contentScore(turndownMd, photosT.length);

  const mdResult = await convertHtmlWithMarkitdown(html);
  let markitMd = '';
  let mPhotos = 0;
  let mScore = null;
  let mErr = null;
  if (mdResult.ok) {
    markitMd = cleanWebpageMarkdown(mdResult.markdown, { isFeishu: true });
    // rough image count from markdown images / IMG markers
    mPhotos = (markitMd.match(/!\[/g) || []).length + (markitMd.match(/\[IMG:\d+\]/g) || []).length;
    mScore = contentScore(markitMd, mPhotos);
  } else {
    mErr = mdResult.error;
  }

  console.log('=== turndown ===');
  console.log(`chars=${turndownMd.length} photos=${photosT.length} score=${tScore}`);
  console.log(snippet(turndownMd, 500));
  console.log('');
  console.log('=== markitdown ===');
  if (mErr) {
    console.log(`unavailable: ${mErr}`);
  } else {
    console.log(
      `chars=${markitMd.length} photos~=${mPhotos} score=${mScore} ms=${mdResult.ms}`
    );
    console.log(snippet(markitMd, 500));
  }
  console.log('');
  if (mScore != null) {
    const delta = tScore - mScore;
    console.log(
      `winner: ${delta >= 0 ? 'turndown' : 'markitdown'} (Δscore=${delta})`
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
