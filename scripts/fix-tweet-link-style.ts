/**
 * fix-tweet-link-style.ts
 *
 * 一次性迁移:存量文章里的内嵌推文引用链接样式修复。
 *   1. 去掉链接文本前的「🔄」图标(🔄 @user → @user)
 *   2. 注入 `.article-content a[href^="/articles/"]` 蓝色无下划线样式
 *      (与 renderTweetHtml 内联的样式一致,保证新旧文章观感统一)
 *
 * 未来新保存的文章由 convertMarkdownToHtml + renderTweetHtml 自动生效,无需迁移。
 * 幂等:已注入样式且无 🔄 的文章跳过。
 *
 * Usage(在 app 容器内,ts-node 已随 devDeps 装入镜像):
 *   docker exec <app容器> npx ts-node scripts/fix-tweet-link-style.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(BASE, 'data', 'articles');

// 与 renderTweetHtml 内联样式保持一致
const STYLE_SNIPPET = `    /* 内嵌推文引用链接:像推特原文一样,纯蓝色、无下划线,一眼可点 */
    .article-content a[href^="/articles/"] { color: #1d9bf0; text-decoration: none; }
    .article-content a[href^="/articles/"]:hover { text-decoration: none; }
    [data-theme="dark"] .article-content a[href^="/articles/"] { color: #6cb4ee; }`;

function main(): void {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('[migrate:style] articles dir missing — nothing to do');
    return;
  }
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let fixed = 0;
  for (const f of files) {
    const p = path.join(ARTICLES_DIR, f);
    let html: string;
    try {
      html = fs.readFileSync(p, 'utf-8');
    } catch (err) {
      console.error(`[migrate:style] read fail ${f}:`, err instanceof Error ? err.message : err);
      continue;
    }
    const hasArrows = html.includes('🔄 @');
    const hasStyle = html.includes('a[href^="/articles/"]');
    if (!hasArrows && hasStyle) continue;

    let next = html;
    if (hasArrows) {
      // 只在 article-content 区间替换,避免误伤标题等
      const start = next.indexOf('<div class="article-content">');
      const end = next.indexOf('<div class="article-footer"', start);
      if (start >= 0 && end > start) {
        next = next.slice(0, start) + next.slice(start, end).replace(/🔄 @/g, '@') + next.slice(end);
      } else {
        next = next.replace(/🔄 @/g, '@');
      }
    }
    if (!hasStyle) {
      const styleIdx = next.indexOf('</style>');
      if (styleIdx === -1) {
        console.log(`[migrate:style] skip ${f}: no </style> found`);
        continue;
      }
      next = next.slice(0, styleIdx) + STYLE_SNIPPET + '\n' + next.slice(styleIdx);
    }

    fs.writeFileSync(p, next, 'utf-8');
    fixed++;
    console.log(`[migrate:style] fixed ${f}: ${hasArrows ? 'arrows ' : ''}${!hasStyle ? 'style' : ''}`.trim());
  }
  console.log(`[migrate:style] done: ${fixed} file(s)`);
}

main();
