/**
 * translate-spanish-articles.ts
 *
 * 把知识库里的西班牙语文章翻译成中文(标题+正文),其他语言不动。
 *
 * 使用与 translate-foreign-articles.ts 相同的 tag-split 策略:
 * 提取纯文本→翻译→插回 HTML,标签零接触,无排版损坏。
 *
 * 原文备份 <file>.bak-es,meta.json 备份 meta.json.bak-es
 * 翻译失败自动恢复。
 *
 * Usage:
 *   DRY=1 npx ts-node scripts/translate-spanish-articles.ts   # 只探测不改动
 *   npx ts-node scripts/translate-spanish-articles.ts          # 实际翻译
 */

import * as fs from 'fs';
import * as path from 'path';
import { isLlmEnabled } from '../src/services/llm';
import { isNonChinese, translateWithPasses } from '../src/services/translate';
import { insertArticle as insertSearchArticle, generateEmbedding } from '../src/services/search';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(BASE, 'data', 'articles');
const META_PATH = path.join(BASE, 'data', 'meta.json');
const DRY = process.env.DRY === '1';

// 只用英语中不会出现的西语词(a/no/me/es/y 这类短词英语也用,会误判)
const ES_STOP = new Set(('el la de que en los las una por con para del como pero sus este esta esto muy sin sobre tambien hasta hay donde desde todo nos ni ese eso entre cuando puede ser tiene anos dia asi mismo otro otra otros antes despues solo tiempo quien ahora cada mucho poco nada algo').split(' '));

// ---- 工具函数 ----

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 10)));
}
function encodeEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function stripTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isSpanish(text: string): { hit: boolean; special: number; stops: number; latin: number } {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const special = (text.match(/[¿¡ñáéíóúüÑÁÉÍÓÚÜ]/g) || []).length;
  const words = text.toLowerCase().match(/[a-záéíóúüñ]+/g) || [];
  const stops = words.filter(w => ES_STOP.has(w)).length;
  const latin = words.length;
  const hit = latin >= 15 && cjk < latin * 0.2 && (special >= 2 || (stops >= 6 && stops / latin > 0.08));
  return { hit, special, stops, latin };
}

// ---- HTML 分段 (与 translate-foreign-articles.ts 相同) ----

type Seg =
  | { tag: true; raw: string }
  | { tag: false; raw: string; trans?: string };

/**
 * 把 HTML 切分为 tag/text 序列。
 *
 * 两遍策略:
 *   1) 窄正则只找 <pre>/<code>/<script>/<style> 的配对,算出保护区间(原样保留)
 *   2) 用 FSM 走 HTML,保护区间整体作为一个 "tag" 段输出,其余正常 tag/text 分切
 *
 * 这样保护区域内的 `<` `>` (如代码中 a < b) 不会干扰解析,内容也不会丢失。
 */
function segmentHtml(html: string): Seg[] {
  const PROTECT = new Set(['pre', 'code', 'script', 'style']);

  // Phase 1: 找保护区间
  const protectRe = /<\/?(pre|code|script|style)\b[^>]*>/gi;
  const stack: { tag: string; start: number }[] = [];
  const rawRanges: [number, number][] = [];
  for (const m of html.matchAll(protectRe)) {
    const isClose = m[0][1] === '/';
    const tagName = m[1].toLowerCase();
    if (isClose) {
      if (stack.length > 0 && stack[stack.length - 1].tag === tagName) {
        const open = stack.pop()!;
        if (stack.length === 0) rawRanges.push([open.start, m.index! + m[0].length]);
      }
    } else {
      stack.push({ tag: tagName, start: m.index! });
    }
  }
  // 合并嵌套区间(取最外层)
  const skipRanges: [number, number][] = [];
  for (const r of rawRanges.sort((a, b) => a[0] - b[0])) {
    if (skipRanges.length > 0 && r[0] < skipRanges[skipRanges.length - 1][1]) {
      skipRanges[skipRanges.length - 1][1] = Math.max(skipRanges[skipRanges.length - 1][1], r[1]);
    } else {
      skipRanges.push(r);
    }
  }

  // Phase 2: 走 HTML,保护区间整体吐出
  const segs: Seg[] = [];
  let i = 0;
  let textStart = -1;
  let skipIdx = 0;

  while (i < html.length) {
    // 是否进入保护区间?
    if (skipIdx < skipRanges.length && i === skipRanges[skipIdx][0]) {
      if (textStart >= 0) {
        const raw = html.slice(textStart, i);
        if (raw) segs.push({ tag: false, raw });
        textStart = -1;
      }
      segs.push({ tag: true, raw: html.slice(skipRanges[skipIdx][0], skipRanges[skipIdx][1]) });
      i = skipRanges[skipIdx][1];
      skipIdx++;
      continue;
    }

    if (html[i] === '<') {
      if (textStart >= 0) {
        const raw = html.slice(textStart, i);
        if (raw) segs.push({ tag: false, raw });
        textStart = -1;
      }
      const tagEnd = html.indexOf('>', i);
      if (tagEnd === -1) { textStart = i + 1; break; }
      segs.push({ tag: true, raw: html.slice(i, tagEnd + 1) });
      i = tagEnd + 1;
      continue;
    }

    if (textStart < 0) textStart = i;
    i++;
  }

  if (textStart >= 0) {
    const raw = html.slice(textStart);
    if (raw) segs.push({ tag: false, raw });
  }

  return segs;
}

function joinSegs(segs: Seg[]): string {
  return segs.map(s => (s.tag ? s.raw : s.trans ?? s.raw)).join('');
}

// ---- 批量翻译 ----

async function translateBatchTexts(items: { text: string; target: { trans?: string } }[]): Promise<void> {
  const active = items.filter(i => isNonChinese(i.text));
  if (active.length === 0) return;

  const idxMap = new Map<number, number>();
  const numberedLines: string[] = [];
  active.forEach((item, localI) => {
    const globalI = items.indexOf(item);
    idxMap.set(localI, globalI);
    numberedLines.push(`【${localI}】${item.text}`);
  });

  const input = numberedLines.join('\n\n');
  const out = await translateWithPasses(input, { noStripMarker: true });

  const parts = out.split(/【(\d+)】/);
  const translated = new Map<number, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const localI = parseInt(parts[i], 10);
    if (!isNaN(localI)) translated.set(localI, parts[i + 1].trim());
  }

  for (const [localI, text] of translated) {
    const globalI = idxMap.get(localI);
    if (globalI === undefined) continue;
    const orig = items[globalI].text;
    if (text && decodeEntities(text) !== decodeEntities(orig)) {
      items[globalI].target.trans = encodeEntities(text);
    }
  }
}

/** 提取 article-content 内部 HTML */
function extractContentInner(html: string): { inner: string; start: number; end: number } | null {
  const m = html.match(/(<div class="article-content">)([\s\S]*?)(<\/div>\s*(?:<div class="article-footer"|<div class="share-overlay"))/);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[1].length;
  return { inner: m[2], start, end: start + m[2].length };
}

// ---- 主流程 ----

async function main() {
  const meta: any[] = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  const metaMap = new Map(meta.map(m => [m.fileName, m]));
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));

  // ---- 探测 ----
  const candidates: { file: string; title: string }[] = [];
  for (const f of files) {
    const html = fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8');
    const title = (html.match(/<h1 class="article-title">([\s\S]*?)<\/h1>/)?.[1] || '').trim();
    const c = extractContentInner(html);
    const probe = stripTags(title + ' ' + (c ? c.inner.substring(0, 3000) : '')).substring(0, 1500);
    const det = isSpanish(probe);
    if (det.hit) candidates.push({ file: f, title: stripTags(title).substring(0, 60) + ` [西语标记${det.special} 停用词${det.stops}/${det.latin}]` });
  }
  console.log(`扫描 ${files.length} 篇,探测到西班牙语 ${candidates.length} 篇:`);
  candidates.forEach(c => console.log(`  ${c.file} | ${c.title}`));
  if (DRY || candidates.length === 0) return;
  if (!isLlmEnabled()) { console.error('LLM not configured'); process.exit(1); }

  fs.copyFileSync(META_PATH, META_PATH + '.bak-es');

  // ---- 翻译 ----
  let done = 0, failed = 0;
  for (const { file } of candidates) {
    const p = path.join(ARTICLES_DIR, file);
    let html = fs.readFileSync(p, 'utf-8');
    if (!fs.existsSync(p + '.bak-es')) {
      fs.copyFileSync(p, p + '.bak-es');
    }
    try {
      // 1. 标题 (纯文本)
      const oldTitle = stripTags(html.match(/<h1 class="article-title">([\s\S]*?)<\/h1>/)?.[1] || '');
      const newTitle = (await translateWithPasses(oldTitle, { noStripMarker: false }))
        .replace(/<[^>]+>/g, '').trim();
      html = html.replace(/<h1 class="article-title">[\s\S]*?<\/h1>/, `<h1 class="article-title">${encodeEntities(newTitle)}</h1>`);
      html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${encodeEntities(newTitle)}</title>`);
      html = html.replace(/var title = "[\s\S]*?";/, `var title = "${encodeEntities(newTitle).replace(/"/g, '\\"')}";`);

      // 2. 正文 (tag-split)
      const c = extractContentInner(html);
      if (!c) throw new Error('content div not found');

      const segs = segmentHtml(c.inner);
      const textItems: { text: string; target: { trans?: string; raw: string } }[] = [];
      for (const s of segs) {
        if (!s.tag) {
          const text = decodeEntities(s.raw);
          if (text.trim() && isNonChinese(text)) {
            textItems.push({ text, target: s });
          }
        }
      }

      for (let off = 0; off < textItems.length; ) {
        const batch: typeof textItems = [];
        let batchLen = 0;
        while (off < textItems.length && batchLen + textItems[off].text.length <= 2500) {
          batch.push(textItems[off]);
          batchLen += textItems[off].text.length;
          off++;
        }
        await translateBatchTexts(batch);
        await new Promise(r => setTimeout(r, 300));
      }

      const newInner = joinSegs(segs);
      html = html.substring(0, c.start) + newInner + html.substring(c.end);
      fs.writeFileSync(p, html, 'utf-8');

      // 3. meta + 搜索索引
      const entry: any = metaMap.get(file);
      const newPlain = stripTags(newInner);
      if (entry) {
        entry.title = newTitle;
        entry.contentKey = newPlain.substring(0, 200);
      }
      insertSearchArticle({
        fileName: file,
        title: newTitle,
        author: entry?.author || '',
        authorHandle: entry?.authorHandle || '',
        body: newPlain,
      });
      generateEmbedding(file, `${newTitle}\n${entry?.author || ''}\n${newPlain}`).catch(() => {});
      done++;
      console.log(`[es→zh] ${file} | ${textItems.length} texts | ${oldTitle.substring(0, 30)} → ${newTitle.substring(0, 30)}`);
    } catch (err) {
      failed++;
      console.error(`[es→zh] FAIL ${file}: ${err instanceof Error ? err.message : err}(已从备份恢复)`);
      fs.copyFileSync(p + '.bak-es', p);
    }
  }

  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');
  console.log(`\nDone. translated: ${done}, failed: ${failed}. 重启容器重建索引页后生效。`);
}

main().catch(err => { console.error(err); process.exit(1); });
