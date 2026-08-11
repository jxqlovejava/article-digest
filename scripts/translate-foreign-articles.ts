/**
 * translate-foreign-articles.ts
 *
 * 存量批量:把知识库里所有非中文文章(英/西/日/韩…)翻译成中文(标题+正文)。
 *
 * ## 策略:tag-split — 只翻译纯文本,不动 HTML 标签
 *
 * 旧方案把带 HTML 标签的整块发给 LLM → LLM 可能损坏标签/合并段落/乱编号
 * → 排版坏 + 翻译残留英文。新方案:
 *
 *   1. 把 article-content 内部 HTML 切成 [tag, text, tag, text, …]
 *   2. 仅提取纯文本片段,判断 isNonChinese 后分组编号
 *   3. 多遍翻译流水线(初翻→评审→精修, prompts/translate/*.md, 纯文本输入)
 *   4. 翻译后的纯文本插回原 HTML 结构——标签零接触
 *
 *   标题同样纯文本翻译,同步 <title>、<h1>、var title、meta.json、FTS 索引
 *
 * 原文备份 <file>.bak-trans;meta.json 备份 meta.json.bak-trans
 * 翻译失败(任一步抛错)从 .bak-trans 恢复,不影响其他文章。
 *
 * Usage:
 *   DRY=1 npx ts-node scripts/translate-foreign-articles.ts   # 只探测
 *   npx ts-node scripts/translate-foreign-articles.ts          # 实跑
 *   ONLY=<fileName> npx ts-node scripts/translate-foreign-articles.ts  # 只翻某一篇
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
const ONLY = process.env.ONLY || '';

// ---- HTML 实体编解码 ----

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

// ---- HTML 分段: [tag, text, tag, text, ...] —— 正文里只 text 片段可能需翻译 ----

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

/** 把 segments 拼回 HTML */
function joinSegs(segs: Seg[]): string {
  return segs.map(s => (s.tag ? s.raw : s.trans ?? s.raw)).join('');
}

// ---- 纯文本批量翻译（编号输入→编号输出） ----

/**
 * 把一批纯文本文段编号后送多遍流水线翻译,解析结果回填。
 * 编号解析失败或翻译与原文无差异的文段保留原文(不上传改动)。
 */
async function translateBatchTexts(items: { text: string; target: { trans?: string } }[]): Promise<void> {
  if (items.length === 0) return;

  // 只送 isNonChinese=true 的（不会出现 false 的,但防御性检查）
  const active = items.filter(i => isNonChinese(i.text));
  if (active.length === 0) return;

  // 建立编号映射: 全局的 idx → items 下标
  const idxMap = new Map<number, number>();
  const numberedLines: string[] = [];
  active.forEach((item, localI) => {
    const globalI = items.indexOf(item);
    idxMap.set(localI, globalI);
    numberedLines.push(`【${localI}】${item.text}`);
  });

  const input = numberedLines.join('\n\n');
  const out = await translateWithPasses(input, { noStripMarker: true });

  // 解析 【n】content
  const parts = out.split(/【(\d+)】/);
  const translated = new Map<number, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const localI = parseInt(parts[i], 10);
    if (!isNaN(localI)) translated.set(localI, parts[i + 1].trim());
  }

  // 回填:改变了的才标记
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
  let files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  if (ONLY) files = files.filter(f => f === ONLY);

  // ---- 探测 ----
  const candidates: string[] = [];
  for (const f of files) {
    const html = fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8');
    const title = (html.match(/<h1 class="article-title">([\s\S]*?)<\/h1>/)?.[1] || '').trim();
    const c = extractContentInner(html);
    if (isNonChinese(stripTags(title + ' ' + (c ? c.inner.substring(0, 3000) : '')).substring(0, 1500))) {
      candidates.push(f);
    }
  }
  console.log(`扫描 ${files.length} 篇,非中文候选 ${candidates.length} 篇`);
  if (DRY || candidates.length === 0) return;
  if (!isLlmEnabled()) { console.error('LLM not configured'); process.exit(1); }

  fs.copyFileSync(META_PATH, META_PATH + '.bak-trans');

  let done = 0, failed = 0;
  const CONCURRENCY = 3;

  const processArticle = async (file: string) => {
    const p = path.join(ARTICLES_DIR, file);
    let html = fs.readFileSync(p, 'utf-8');
    // 保留首次备份(.bak-trans 已存在就不覆盖,避免丢原文)
    if (!fs.existsSync(p + '.bak-trans')) {
      fs.copyFileSync(p, p + '.bak-trans');
    }
    try {
      // 1. 标题 (纯文本翻译)
      const oldTitle = stripTags(html.match(/<h1 class="article-title">([\s\S]*?)<\/h1>/)?.[1] || '');
      const newTitle = (await translateWithPasses(oldTitle, { noStripMarker: false }))
        .replace(/<[^>]+>/g, '').trim();
      html = html.replace(/<h1 class="article-title">[\s\S]*?<\/h1>/, `<h1 class="article-title">${encodeEntities(newTitle)}</h1>`);
      html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${encodeEntities(newTitle)}</title>`);
      html = html.replace(/var title = "[\s\S]*?";/, `var title = "${encodeEntities(newTitle).replace(/"/g, '\\"')}";`);

      // 2. 正文 (tag-split 策略)
      const c = extractContentInner(html);
      if (!c) throw new Error('content div not found');

      const segs = segmentHtml(c.inner);
      // 收集需翻译的文本段(只有 non-tag segment 含有 trans 属性)
      const textItems: { text: string; target: { trans?: string; raw: string } }[] = [];
      for (const s of segs) {
        if (!s.tag) {
          const text = decodeEntities(s.raw);
          if (text.trim() && isNonChinese(text)) {
            textItems.push({ text, target: s });
          }
        }
      }

      // 按 ~2500 字符分批
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

      // 拼回 inner HTML
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
      console.log(`[→zh] ${file} | ${textItems.length} texts | ${oldTitle.substring(0, 35)} → ${newTitle.substring(0, 35)}`);
    } catch (err) {
      failed++;
      console.error(`[→zh] FAIL ${file}: ${err instanceof Error ? err.message : err}(已从备份恢复)`);
      fs.copyFileSync(p + '.bak-trans', p);
    }
  };

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + CONCURRENCY).map(processArticle));
  }

  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');
  console.log(`\nDone. translated: ${done}, failed: ${failed}. 重启容器重建索引页后生效。`);
}

main().catch(err => { console.error(err); process.exit(1); });
