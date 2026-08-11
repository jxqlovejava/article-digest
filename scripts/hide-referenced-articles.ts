/**
 * hide-referenced-articles.ts
 *
 * 一次性迁移:找出「被其他已存档文章引用」的文章(文章里的文章),标记 hidden=true,
 * 使其从列表页与搜索中排除,但保留本地 HTML 页面供合集页链接打开。
 *
 * 判定规则:文章 B 的本地页面被文章 A 的 article-content 引用 → B.hidden = true。
 *   - 匹配 href="articles/<file>.html"
 *   - 匹配裸 https://(x|twitter).com/<user>/status/<id>,规范化后查 meta.tweetUrl
 * 幂等可重跑。
 *
 * Usage(在 app 容器内):
 *   docker exec <app容器> npm run migrate:hidden
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadMeta, saveMeta, rebuildIndex } from '../src/services/renderer';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(BASE, 'data', 'articles');

/** x.com 与 twitter.com 视为同一 URL,规范化用于 meta.tweetUrl 匹配 */
function normalizeTweetUrl(url: string): string {
  return url
    .replace(/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

async function main(): Promise<void> {
  const meta = loadMeta();
  if (meta.length === 0) {
    console.log('[migrate:hidden] meta.json empty — nothing to do');
    return;
  }

  const byTweetUrl = new Map<string, string>();
  for (const m of meta) {
    if (m.tweetUrl) byTweetUrl.set(normalizeTweetUrl(m.tweetUrl), m.fileName);
  }

  const referencedBy = new Set<string>();
  const hrefRe = /href="articles\/([^"]+\.html)"/g;
  const tweetUrlRe = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/g;

  for (const m of meta) {
    const p = path.join(ARTICLES_DIR, m.fileName);
    if (!fs.existsSync(p)) continue;
    let html = '';
    try {
      html = fs.readFileSync(p, 'utf-8');
    } catch (err) {
      console.error(`[migrate:hidden] read fail ${m.fileName}:`, err instanceof Error ? err.message : err);
      continue;
    }
    // 只取 article-content 区间(嵌套 div 也能正确截断,footer 标记内容结束)
    const start = html.indexOf('<div class="article-content">');
    const end = html.indexOf('<div class="article-footer"', start);
    const content = start >= 0 ? html.slice(start, end > start ? end : undefined) : '';

    let h;
    hrefRe.lastIndex = 0;
    while ((h = hrefRe.exec(content)) !== null) {
      const target = h[1];
      if (target !== m.fileName) referencedBy.add(target);
    }
    tweetUrlRe.lastIndex = 0;
    let u;
    while ((u = tweetUrlRe.exec(content)) !== null) {
      const target = byTweetUrl.get(normalizeTweetUrl(u[0]));
      if (target && target !== m.fileName) referencedBy.add(target);
    }
  }

  let hidden = 0;
  const visible: string[] = [];
  for (const m of meta) {
    if (referencedBy.has(m.fileName)) {
      if (!m.hidden) m.hidden = true;
      hidden++;
    } else {
      visible.push(m.fileName);
    }
  }
  saveMeta(meta);
  await rebuildIndex();

  console.log(`[migrate:hidden] ${hidden} article(s) marked hidden, ${meta.length - hidden} remain visible`);
  if (visible.length <= 15) {
    console.log('[migrate:hidden] visible:', visible.join(', '));
  } else {
    console.log('[migrate:hidden] visible sample:', visible.slice(0, 15).join(', '), `…(+${visible.length - 15})`);
  }
}

main().catch(err => {
  console.error('[migrate:hidden] FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
