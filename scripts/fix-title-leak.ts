/**
 * fix-title-leak.ts
 *
 * Fix articles where content leaked into the <title> / <h1> tag.
 * Symptom: the <h1 class="article-title"> contains full article body text,
 * and <div class="article-content"> is empty.
 *
 * Usage:
 *   npx ts-node scripts/fix-title-leak.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(BASE, 'data', 'articles');
const META_PATH = path.join(BASE, 'data', 'meta.json');

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function deriveTitle(text: string, maxLen = 80): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return '';
  let startIdx = 0;
  while (startIdx < lines.length && /^\[(IMG|VIDEO):\d+\]$/.test(lines[startIdx])) {
    startIdx++;
  }
  if (startIdx >= lines.length) return '';
  return lines[startIdx].substring(0, maxLen);
}

interface ArticleMeta {
  fileName: string;
  title: string;
  author: string;
  authorHandle: string;
  authorAvatar: string;
  tweetUrl: string;
  tweetDate: string;
  savedDate: string;
  tweetTimestamp: number;
  savedTimestamp: number;
  contentKey: string;
  sourceType: string;
  pinned: boolean;
  pinnedAt?: number;
  unread: boolean;
  likes?: number;
  retweets?: number;
  replies?: number;
}

function main() {
  const meta: ArticleMeta[] = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  let fixedCount = 0;

  for (const entry of meta) {
    const htmlPath = path.join(ARTICLES_DIR, entry.fileName);
    if (!fs.existsSync(htmlPath)) continue;

    let html = fs.readFileSync(htmlPath, 'utf-8');

    // Extract <h1 class="article-title"> content
    const h1Match = html.match(/<h1 class="article-title">([\s\S]*?)<\/h1>/);
    if (!h1Match) continue;

    const h1Content = h1Match[1].trim();
    // Normal title is ~50-100 chars. If >300, content leaked in.
    if (h1Content.length <= 300) continue;

    // Check that article-content is empty or nearly empty
    const contentDivMatch = html.match(
      /<div class="article-content">([\s\S]*?)<\/div>\s*(?:<div class="article-footer"|<div class="share-overlay")/
    );
    const contentBody = contentDivMatch ? contentDivMatch[1].trim() : '';

    if (contentBody && contentBody.length > h1Content.length * 0.5) {
      // Content div already has substantial content — skip
      continue;
    }

    console.log(`[fix] ${entry.fileName}: title is ${h1Content.length} chars, content is ${contentBody.length} chars`);

    // Derive a short title from the leaked content
    const newTitle = deriveTitle(h1Content, 80) || h1Content.substring(0, 80);
    console.log(`  → new title: "${newTitle}"`);

    // Move h1 content into article-content (as plain text in <p> tags)
    const htmlLines = h1Content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    // Convert to markdown-like paragraphs
    const newContent = htmlLines.map(l => `<p>${escapeHtml(l)}</p>`).join('\n');

    // Replace the long <h1> with short title
    html = html.replace(
      /<h1 class="article-title">([\s\S]*?)<\/h1>/,
      `<h1 class="article-title">${escapeHtml(newTitle)}</h1>`
    );

    // Replace empty/broken article-content with new content
    html = html.replace(
      /(<div class="article-content">)([\s\S]*?)(<\/div>\s*(?:<div class="article-footer"|<div class="share-overlay"))/,
      `$1${newContent}$3`
    );

    // Fix <title> tag too
    html = html.replace(
      /<title>[\s\S]*?<\/title>/,
      `<title>${escapeHtml(newTitle)}</title>`
    );

    // Fix the JS `var title = "..."` in the inline script
    html = html.replace(
      /var title = "[\s\S]*?";/,
      `var title = "${escapeHtml(newTitle).replace(/"/g, '\\"')}";`
    );

    fs.writeFileSync(htmlPath, html, 'utf-8');

    // Update meta
    entry.title = newTitle;
    entry.contentKey = h1Content.substring(0, 200);
    fixedCount++;
  }

  // Save meta
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');
  console.log(`\nDone. Fixed ${fixedCount} article(s).`);
}

main();
