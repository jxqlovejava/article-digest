/**
 * reindex-translated.ts
 *
 * 一次性迁移:把「已翻译成中文」的文章重新写入搜索索引。
 *
 * 背景:translateArticleContent 只更新了 HTML 标题与 meta.title,没有回写 FTS 搜索索引,
 * 导致英文文章翻译成中文后,搜中文关键词(如「评估工程」)搜不到——FTS 里还是翻译前的英文。
 * 本脚本找出有 .orig.md(原文非中文)且正文已翻译成中文的文章,用当前中文标题+正文重建索引。
 * 治本:translateArticleContent 已加回写,本脚本只处理存量。
 *
 * 幂等可重跑。
 *
 * Usage(在 app 容器内,ts-node 已随 devDeps 装入镜像):
 *   docker exec <app容器> npx ts-node scripts/reindex-translated.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadMeta, isArticleUntranslated } from '../src/services/renderer';
import { insertArticle } from '../src/services/search';
import { normalizeScrapedText } from '../src/utils/textDecode';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(BASE, 'data', 'articles');

function main(): void {
  const metaMap = new Map(loadMeta().map(m => [m.fileName, m]));
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let reindexed = 0;
  let skippedStillForeign = 0;
  for (const f of files) {
    const origPath = path.join(ARTICLES_DIR, f.replace(/\.html$/, '.orig.md'));
    if (!fs.existsSync(origPath)) continue; // 原文本来就是中文,无需处理
    const p = path.join(ARTICLES_DIR, f);
    let html: string;
    try {
      html = fs.readFileSync(p, 'utf-8');
    } catch (err) {
      console.error(`[reindex-translated] read fail ${f}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (isArticleUntranslated(html)) { skippedStillForeign++; continue; } // 仍是外文(未翻译/翻译失败)

    // 提取当前(翻译后)标题与正文
    const titleM = html.match(/<h1 class="article-title">([\s\S]*?)<\/h1>/);
    const title = titleM ? normalizeScrapedText(titleM[1]).trim() : '';
    const cm = html.match(/<div class="article-content">([\s\S]*?)(<\/div>\s*(?:<div class="article-footer"|<div class="share-overlay"))/);
    const body = cm
      ? normalizeScrapedText(cm[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
      : '';

    const meta = metaMap.get(f);
    insertArticle({
      fileName: f,
      title: title || meta?.title || f,
      author: meta?.author || '',
      authorHandle: meta?.authorHandle || '',
      body,
    });
    reindexed++;
  }
  console.log(`[reindex-translated] re-indexed ${reindexed} translated article(s), skipped ${skippedStillForeign} still-foreign`);
}

main();
