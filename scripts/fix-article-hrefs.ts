/**
 * fix-article-hrefs.ts
 *
 * 一次性修复:存量文章正文里的 `href="articles/X.html"` 相对链接改为绝对路径
 * `href="/articles/X.html"`。
 *
 * 背景:convertMarkdownToHtml 生成的引用链接早期是相对路径 `articles/X.html`。
 * 文章页本身位于 /articles/X.html,相对链接会被浏览器解析成 /articles/articles/Y.html
 * (双重 articles)而 404。本脚本把存量 HTML 里的相对链接补上前导 `/`。
 *
 * 幂等:已带 `/` 的链接不会被再次替换(模式不匹配)。只处理 data/articles/*.html,
 * 不碰 index.html(列表页在根路径,`articles/` 相对链接本来就正确)。
 *
 * Usage(在 app 容器内,ts-node 已随 devDeps 装入镜像):
 *   docker exec <app容器> npx ts-node scripts/fix-article-hrefs.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(BASE, 'data', 'articles');

function main(): void {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('[migrate:fixhrefs] articles dir missing — nothing to do');
    return;
  }
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let fixed = 0;
  let totalLinks = 0;
  for (const f of files) {
    const p = path.join(ARTICLES_DIR, f);
    let html: string;
    try {
      html = fs.readFileSync(p, 'utf-8');
    } catch (err) {
      console.error(`[migrate:fixhrefs] read fail ${f}:`, err instanceof Error ? err.message : err);
      continue;
    }
    const links = (html.match(/href="articles\//g) || []).length;
    if (links === 0) continue;
    const next = html.replace(/href="articles\//g, 'href="/articles/');
    if (next !== html) {
      fs.writeFileSync(p, next, 'utf-8');
      fixed++;
      totalLinks += links;
      console.log(`[migrate:fixhrefs] fixed ${f}: ${links} link(s)`);
    }
  }
  console.log(`[migrate:fixhrefs] done: ${fixed} file(s), ${totalLinks} link(s) fixed`);
}

main();
