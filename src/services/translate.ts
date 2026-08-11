import fs from 'fs';
import path from 'path';
import { chat, isLlmEnabled } from './llm';

// 多遍翻译:初翻(draft)→评审(critique,只诊断)→精修(revise)
// prompt 存于 prompts/translate/*.md(提示词即代码,改后重跑即生效)
// 术语表 data/glossary.json:命中注入,手编不覆盖
const PROMPT_DIR = path.join(process.cwd(), 'prompts', 'translate');
const GLOSSARY_PATH = path.join(process.cwd(), 'data', 'glossary.json');
const LONG_TEXT_CHARS = 1500;   // ≥ 此长度先跑分析 pass
const BATCH_CHARS = 2500;       // 单次调用最大输入

interface GlossaryTerm { source: string; target: string; keepOriginal?: boolean }

const promptCache = new Map<string, string>();
function loadPrompt(name: string): string {
  if (!promptCache.has(name)) {
    promptCache.set(name, fs.readFileSync(path.join(PROMPT_DIR, name), 'utf-8'));
  }
  return promptCache.get(name)!;
}

let glossaryCache: GlossaryTerm[] | null = null;
function loadGlossary(): GlossaryTerm[] {
  if (glossaryCache) return glossaryCache;
  try {
    const j = JSON.parse(fs.readFileSync(GLOSSARY_PATH, 'utf-8'));
    glossaryCache = j.terms || [];
  } catch {
    glossaryCache = [];
  }
  return glossaryCache!;
}

/** 术语表命中注入(学 translate-book print-terms-for-chunk:只注入本文出现的) */
function glossaryHitsFor(text: string): string {
  const lower = text.toLowerCase();
  const hits = loadGlossary().filter(t => lower.includes(t.source.toLowerCase()));
  if (hits.length === 0) return '(无)';
  return hits.map(t => `- ${t.source} → ${t.target}`).join('\n');
}

/** 泛语种非中文检测:假名(日)/谚文(韩)/拉丁(英西法德…)主导即非中文;汉字占比高即中文 */
export function isNonChinese(text: string): boolean {
  const kana = (text.match(/[぀-ゟ゠-ヿ]/g) || []).length;
  const hangul = (text.match(/[가-힯]/g) || []).length;
  const han = (text.match(/[一-鿿]/g) || []).length;
  const latin = (text.match(/[A-Za-zÀ-ɏḀ-ỿа-яА-Я]/g) || []).length;
  const nonHan = kana + hangul + latin;
  if (nonHan < 6) return false;                     // 极短/几乎没文字,不翻(避免误判符号行)
  if (kana + hangul >= 5 && kana + hangul > han * 0.15) return true;  // 日/韩
  return han < nonHan * 0.2;                        // 拉丁等主导且汉字 <20%
}

/** 按空行块切分,每批 ≤ maxChars(不切断段落) */
export function splitIntoBatches(text: string, maxChars = BATCH_CHARS): string[] {
  const paras = text.split(/\n{2,}/);
  const batches: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) { batches.push(cur); cur = p; }
    else { cur = cur ? cur + '\n\n' + p : p; }
  }
  if (cur) batches.push(cur);
  // 单段超长的硬切(罕见)
  return batches.flatMap(b => {
    if (b.length <= maxChars) return [b];
    const out: string[] = [];
    for (let i = 0; i < b.length; i += maxChars) out.push(b.substring(i, i + maxChars));
    return out;
  });
}

async function llm(system: string, user: string, maxTokens: number): Promise<string> {
  return chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { temperature: 0.2, maxTokens, preferPro: true });
}

/** 单批文本的多遍翻译:分析(长文)→初翻→评审→精修;任一步失败回退上一稿 */
export async function translateWithPasses(text: string, opts?: { noStripMarker?: boolean }): Promise<string> {
  // 输入无编号时,输出可能自发带上【1】标记——统一剥掉,防止泄漏进标题/正文
  // noStripMarker=true:跳过全部标记处理(编号输入,由调用方负责解析)
  const stripMarker = (s: string) => {
    if (opts?.noStripMarker) return s;
    return /【\d+】/.test(text) ? s : s.replace(/^【(?:\d+|终稿|译文|翻译)】\s*/, '');
  };
  const glossary = glossaryHitsFor(text);

  // 分析 pass(仅长文):领域/语气/术语/难点,给初翻当上下文
  let analysis = '';
  if (text.length >= LONG_TEXT_CHARS) {
    try {
      analysis = await llm(
        '你是翻译前的内容分析师。用中文给出:1) 领域与体裁 2) 语气风格 3) 关键术语与难点 4) 翻译策略建议。200 字以内,分条列出。',
        text, 600);
    } catch (err) {
      console.error('[translate] analysis pass failed, continue without:', err instanceof Error ? err.message : err);
    }
  }

  // 初翻
  const draftPrompt = loadPrompt('draft.md').replace('{GLOSSARY}', glossary);
  const draftInput = analysis ? `【文章分析】\n${analysis}\n\n【待翻译正文】\n${text}` : text;
  let draft: string;
  try {
    draft = await llm(draftPrompt, draftInput, 4096);
  } catch (err) {
    console.error('[translate] draft pass failed, keep original:', err instanceof Error ? err.message : err);
    return text;
  }

  // 评审(只诊断)
  let critique: string;
  try {
    critique = await llm(loadPrompt('critique.md'), `【原文】\n${text}\n\n【初翻】\n${draft}`, 2048);
  } catch (err) {
    console.error('[translate] critique pass failed, use draft:', err instanceof Error ? err.message : err);
    return stripMarker(draft);
  }
  if (/^无问题/.test(critique.trim())) return stripMarker(draft);

  // 精修
  try {
    return stripMarker(await llm(loadPrompt('revise.md'), `【原文】\n${text}\n\n【初翻】\n${draft}\n\n【评审意见】\n${critique}`, 4096));
  } catch (err) {
    console.error('[translate] revise pass failed, use draft:', err instanceof Error ? err.message : err);
    return stripMarker(draft);
  }
}

/** 入口:非中文才翻,分块多遍翻译后按原样拼回 */
export async function translateMarkdown(text: string): Promise<{ text: string; translated: boolean }> {
  if (!isLlmEnabled() || !isNonChinese(text)) return { text, translated: false };
  const batches = splitIntoBatches(text);
  const out: string[] = [];
  let consecutiveFails = 0;
  let anyTranslated = false;
  for (let i = 0; i < batches.length; i++) {
    const original = batches[i];
    const result = await translateWithPasses(original);
    if (result === original) {
      consecutiveFails++;
    } else {
      consecutiveFails = 0;
      anyTranslated = true;
    }
    // LLM 连续失败(如 402 欠费)时提前退出,保留原文不阻塞归档
    if (consecutiveFails >= 3) {
      console.error(`[translate] early exit after ${i + 1} batches — LLM unavailable (${consecutiveFails}x fail)`);
      return { text, translated: false };
    }
    out.push(result);
    if (i < batches.length - 1) await new Promise(r => setTimeout(r, 300));
  }
  // translated=true 仅当至少一批真正产出译文(全失败时不再误报,调用方据此跳过/重试)
  return { text: out.join('\n\n'), translated: anyTranslated };
}
