import fs from 'fs';
import path from 'path';
import { chat, chatStream, isLlmEnabled, ChatMessage } from './llm';
import { searchArticles } from './search';
import { getOpinionsByArticle, getAllOpinions, Opinion } from './opinions';
import { loadMeta } from './renderer';
import { getArticlesDir } from './renderer';

export interface QaSource {
  fileName: string;
  title: string;
  author: string;
  tweetUrl: string;
  relevantOpinions: { content: string; category: string }[];
  relevance: number;
}

export interface QaResult {
  answer: string;
  sources: QaSource[];
}

export interface QaOptions {
  contextArticle?: string;  // fileName to bias search towards
  history?: ChatMessage[];
}

function extractArticlePlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getArticleContext(fileNames: string[]): Promise<Map<string, { text: string; opinions: Opinion[] }>> {
  const articlesDir = getArticlesDir();
  const contextMap = new Map<string, { text: string; opinions: Opinion[] }>();

  for (const fileName of fileNames) {
    const htmlPath = path.join(articlesDir, fileName);
    if (!fs.existsSync(htmlPath)) {
      console.error('[synthesize] File not found:', htmlPath);
      continue;
    }
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const text = extractArticlePlainText(html);
    // Keep RAG lean: large prompts + Pro stream often mid-abort through proxy
    const maxChars = parseInt(process.env.QA_ARTICLE_CHARS || '1200', 10);
    const truncated = text.length > maxChars ? text.substring(0, maxChars) + '…' : text;
    const opinions = getOpinionsByArticle(fileName).slice(0, 5);
    contextMap.set(fileName, { text: truncated, opinions });
  }

  console.error('[synthesize] getArticleContext: input', fileNames.length, 'files, output', contextMap.size, 'contexts');
  return contextMap;
}

/** Cap history so multi-turn QA doesn't explode prompt size. */
function compactHistory(history: ChatMessage[] | undefined): ChatMessage[] {
  if (!history || history.length === 0) return [];
  const maxTurns = parseInt(process.env.QA_HISTORY_TURNS || '4', 10);
  const maxEach = parseInt(process.env.QA_HISTORY_CHARS || '600', 10);
  return history.slice(-maxTurns).map(m => ({
    role: m.role,
    content:
      (m.content || '').length > maxEach
        ? m.content.slice(0, maxEach) + '…'
        : m.content || '',
  }));
}

function buildRagPrompt(
  question: string,
  contexts: Map<string, { text: string; opinions: Opinion[] }>,
  metaMap: Map<string, { title: string; author: string }>
): string {
  const parts: string[] = [];

  for (const [fileName, ctx] of contexts) {
    const meta = metaMap.get(fileName);
    const title = meta?.title || fileName;
    const author = meta?.author || 'unknown';

    let section = `## ${title} (by ${author})\n`;
    if (ctx.opinions.length > 0) {
      section += `Key opinions:\n`;
      for (const op of ctx.opinions) {
        section += `- [${op.category}] ${op.content}\n`;
      }
    }
    section += `\nContent: ${ctx.text}\n`;
    parts.push(section);
  }

  return parts.join('\n---\n');
}

/** Shared system prompt for RAG Q&A — direct answers, no filler. */
const QA_SYSTEM_PROMPT = `你是用户个人知识库的研究助手。仅依据提供的收藏文章与观点作答。

硬性规则：
1. 直接回答问题本身：禁止复述/改写用户问题，禁止「用户问的是」「你的问题是」「根据提供的多篇文章」「基于以上上下文」「综合来看」等套话开场或过渡
2. 禁止「好的」「当然」「作为一个AI」等填充语；不要解释你的检索/推理过程
3. 开门见山：先给结论或核心要点，再展开论据；多来源冲突时简短并列分歧
4. 引用具体主张时用文章标题点名，不要空泛说「某篇文章」
5. 资料不足时直接说明知识库未找到相关收藏，不要编造，也不要说成「全世界不知道」
6. 问题是中文则用中文答，英文则用英文；条理清晰，可用短段落或列表
7. 写完整再停：论点与必要论据写完，不要半截结束`;

function buildQaUserMessage(question: string, ragContext: string): string {
  if (ragContext.trim()) {
    return `【知识库资料】\n${ragContext}\n\n【问题】\n${question}`;
  }
  return `知识库检索未返回相关收藏。\n\n【问题】\n${question}\n\n用用户的语言直接说明：未找到相关已收藏文章，可换个说法或先收藏相关帖子。不要编造来源。`;
}

/** QA generation budget — 2048 often cut Chinese multi-paragraph answers short. */
const QA_MAX_TOKENS = Math.max(1024, parseInt(process.env.QA_MAX_TOKENS || '4096', 10) || 4096);

export async function answerQuestion(
  question: string,
  options: QaOptions = {}
): Promise<QaResult> {
  if (!isLlmEnabled()) {
    throw new Error('LLM not configured. Set LLM_API_KEY to enable Q&A.');
  }

  // 1. Determine articles to use
  const topArticles = await retrieveTopArticles(question, options.contextArticle);

  // 2. Get article contexts + opinions
  const contextMap = await getArticleContext(topArticles);
  const meta = loadMeta();
  const metaMap = new Map(meta.map(m => [m.fileName, m]));

  // 3. Build RAG prompt
  const ragContext = buildRagPrompt(question, contextMap, new Map(
    Array.from(metaMap.entries()).map(([k, v]) => [k, { title: v.title, author: v.author }])
  ));

  // 4. Generate answer
  const messages: ChatMessage[] = [
    { role: 'system', content: QA_SYSTEM_PROMPT },
    { role: 'user', content: buildQaUserMessage(question, ragContext) },
  ];

  const hist = compactHistory(options.history);
  if (hist.length > 0) {
    messages.splice(1, 0, ...hist);
  }

  const answer = await chat(messages, {
    temperature: 0.4,
    maxTokens: QA_MAX_TOKENS,
    preferPro: true, // RAG QA: prefer Pro for longer reliable context
  });

  // 5. Build source list
  const sources: QaSource[] = [];
  for (const fileName of topArticles) {
    const ctx = contextMap.get(fileName);
    const m = metaMap.get(fileName);
    if (!ctx) continue;
    sources.push({
      fileName,
      title: m?.title || fileName,
      author: m?.author || 'unknown',
      tweetUrl: m?.tweetUrl || '',
      relevantOpinions: ctx.opinions.map(o => ({ content: o.content, category: o.category })),
      relevance: 1.0,
    });
  }

  return { answer, sources };
}

// ---- Streaming ----

/** Retrieve articles for RAG; retry with stripped question words if first pass empty. */
async function retrieveTopArticles(
  question: string,
  contextArticle?: string
): Promise<string[]> {
  if (contextArticle) return [contextArticle];

  let results = await searchArticles(question);
  if (results.length === 0) {
    const simplified = question
      .replace(/[？?！!。.\s]+/g, ' ')
      .replace(
        /通常|遵循|哪些|什么|如何|怎么|为什么|请问|帮我|是否|能否|应该|一般|常见|关于|对于/g,
        ' '
      )
      .replace(/\s+/g, ' ')
      .trim();
    if (simplified.length >= 2 && simplified !== question.trim()) {
      console.error('[synthesize] empty search, retry simplified:', simplified);
      results = await searchArticles(simplified);
    }
  }
  // 参考来源：默认 5 篇（再压上下文，降低流式中断）
  const topK = Math.max(1, Math.min(12, parseInt(process.env.QA_TOP_K || '5', 10) || 5));
  console.error(
    '[synthesize] retrieveTopArticles:',
    question.slice(0, 40),
    '→',
    results.length,
    'hits, use',
    Math.min(topK, results.length)
  );
  return results.slice(0, topK);
}

export async function* answerQuestionStream(
  question: string,
  options: QaOptions = {}
): AsyncIterable<{ type: 'sources'; sources: QaSource[] } | { type: 'delta'; delta: string } | { type: 'error'; error: string }> {
  if (!isLlmEnabled()) {
    yield { type: 'error', error: 'LLM not configured. Set LLM_API_KEY.' };
    return;
  }

  // 1. Determine articles
  const topArticles = await retrieveTopArticles(question, options.contextArticle);

  // 2. Load contexts
  const contextMap = await getArticleContext(topArticles);
  const meta = loadMeta();
  const metaMap = new Map(meta.map(m => [m.fileName, m]));

  // 3. Build sources list (emit immediately)
  const sources: QaSource[] = [];
  for (const fileName of topArticles) {
    const ctx = contextMap.get(fileName);
    const m = metaMap.get(fileName);
    if (!ctx) continue;
    sources.push({
      fileName,
      title: m?.title || fileName,
      author: m?.author || 'unknown',
      tweetUrl: m?.tweetUrl || '',
      relevantOpinions: ctx.opinions.map(o => ({ content: o.content, category: o.category })),
      relevance: 1.0,
    });
  }
  yield { type: 'sources', sources };

  // 4. Build prompt and stream
  const ragContext = buildRagPrompt(question, contextMap, new Map(
    Array.from(metaMap.entries()).map(([k, v]) => [k, { title: v.title, author: v.author }])
  ));

  const messages: ChatMessage[] = [
    { role: 'system', content: QA_SYSTEM_PROMPT },
    { role: 'user', content: buildQaUserMessage(question, ragContext) },
  ];

  const hist = compactHistory(options.history);
  if (hist.length > 0) {
    messages.splice(1, 0, ...hist);
  }

  try {
    // Stream with Flash by default (chatStream ignores preferPro for model pick unless forced).
    // Pro + large RAG was mid-cut by proxy; auto-continue handles residual aborts.
    for await (const delta of chatStream(messages, {
      temperature: 0.4,
      maxTokens: QA_MAX_TOKENS,
      preferPro: false,
    })) {
      yield { type: 'delta', delta };
    }
  } catch (err) {
    // chatStream already maps abort/timeout; keep message for SSE client
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Suggestions with caching ----

const DATA_DIR = path.resolve(process.cwd(), 'data');

interface SuggestionCache {
  questions: string[];
  used: number;
}

function getSuggestionsCachePath(contextKey: string): string {
  const safeKey = contextKey.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
  return path.join(DATA_DIR, `suggestions_${safeKey}.json`);
}

function loadSuggestionsCache(contextKey: string): SuggestionCache | null {
  const p = getSuggestionsCachePath(contextKey);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (raw && Array.isArray(raw.questions)) return { questions: raw.questions, used: raw.used || 0 };
  } catch {}
  return null;
}

function saveSuggestionsCache(contextKey: string, cache: SuggestionCache): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(getSuggestionsCachePath(contextKey), JSON.stringify(cache), 'utf-8');
  } catch {}
}

/**
 * Return a full batch of suggested questions.
 *
 * Rule: show a cached batch only if NONE of them has been used.
 * If any suggestion was clicked (`used > 0`), discard the rest and
 * regenerate a brand-new full set of `count` questions — never return
 * a partial leftover list like [q2, q3].
 */
export async function getOrGenerateSuggestions(
  count: number = 3,
  contextFileName?: string
): Promise<string[]> {
  const key = contextFileName || '_global';
  const cached = loadSuggestionsCache(key);

  // Intact unused batch only
  if (
    cached &&
    cached.used === 0 &&
    Array.isArray(cached.questions) &&
    cached.questions.length > 0
  ) {
    return cached.questions.slice(0, count);
  }

  // Any prior use (or missing/empty cache) → full regenerate
  const previous = cached?.questions || [];
  try {
    const questions = await generateSuggestedQuestions(count, contextFileName, previous);
    if (questions.length > 0) {
      saveSuggestionsCache(key, { questions, used: 0 });
      return questions.slice(0, count);
    }
  } catch (err) {
    console.error(
      '[synthesize] getOrGenerateSuggestions failed:',
      err instanceof Error ? err.message : err
    );
  }
  // Prefer stale questions over empty welcome UI (regenerate may fail after LLM/proxy issues)
  if (cached && Array.isArray(cached.questions) && cached.questions.length > 0) {
    return cached.questions.slice(0, count);
  }
  return [];
}

/** Fire-and-forget warm of global suggestion cache (index / process boot). */
export function warmGlobalSuggestions(): void {
  if (!isLlmEnabled()) return;
  getOrGenerateSuggestions(3)
    .then(qs => {
      console.error('[synthesize] warm global suggestions:', qs.length);
    })
    .catch(err => {
      console.error(
        '[synthesize] warm global suggestions failed:',
        err instanceof Error ? err.message : err
      );
    });
}

/**
 * Mark that the user clicked a suggestion in this context.
 * Invalidates the whole batch so the next fetch regenerates `count` new ones.
 */
export function useSuggestion(contextFileName: string | undefined, _count: number = 1): void {
  const key = contextFileName || '_global';
  const cached = loadSuggestionsCache(key);
  if (cached && cached.questions.length > 0) {
    // Invalidate the whole batch: any click means next load regenerates 3 fresh ones.
    // (Do not keep leftovers for partial display.)
    saveSuggestionsCache(key, {
      questions: cached.questions,
      used: cached.questions.length,
    });
  }
}

export async function generateSuggestedQuestions(
  count: number = 3,
  contextFileName?: string,
  previousQuestions: string[] = []
): Promise<string[]> {
  if (!isLlmEnabled()) return [];

  const messages: ChatMessage[] = [];
  const avoidBlock =
    previousQuestions.length > 0
      ? `\n\n请不要重复或轻微改写以下已经展示过的问题，给出全新角度：\n${previousQuestions
          .map((q, i) => `${i + 1}. ${q}`)
          .join('\n')}`
      : '';

  if (contextFileName) {
    const htmlPath = path.join(getArticlesDir(), contextFileName);
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      const text = extractArticlePlainText(html);
      const truncated = text.length > 3000 ? text.substring(0, 3000) + '...' : text;
      const opinions = getOpinionsByArticle(contextFileName);
      const opinionLines =
        opinions.length > 0
          ? opinions.map(o => `- [${o.category}] ${o.content}`).join('\n')
          : '无';

      messages.push(
        {
          role: 'system',
          content: `基于以下文章内容，生成恰好${count}个读者可能会问的中文问题。问题应自然、多样，帮助深入理解文章。返回JSON格式：{"questions": ["问题1", "问题2", ...]}，questions 数组长度必须为 ${count}。${avoidBlock}`,
        },
        {
          role: 'user',
          content: `关键观点：\n${opinionLines}\n\n文章内容：\n${truncated}`,
        }
      );
    }
  }

  if (messages.length === 0) {
    const opinions = getAllOpinions();
    if (opinions.length === 0) return [];

    // Sample opinions from different articles
    const sampled = opinions.slice(0, 20);
    const topicList = sampled.map(o => `[${o.category}] ${o.content.substring(0, 150)}`).join('\n');

    messages.push(
      {
        role: 'system',
        content: `基于以下知识库中的观点，生成恰好${count}个用户可能感兴趣的中文问题。问题应该自然、多样，覆盖不同主题。返回JSON格式：{"questions": ["问题1", "问题2", ...]}，questions 数组长度必须为 ${count}。${avoidBlock}`,
      },
      { role: 'user', content: topicList }
    );
  }

  try {
    const { chatWithJson } = await import('./llm');
    const result = await chatWithJson<{ questions: string[] }>(messages, { temperature: 0.9 });
    const qs = (result.questions || [])
      .map(q => (typeof q === 'string' ? q.trim() : ''))
      .filter(Boolean);
    // Prefer fresh questions not in the previous batch
    const prevSet = new Set(previousQuestions.map(q => q.trim()));
    const unique = qs.filter(q => !prevSet.has(q));
    const merged = unique.length >= count ? unique : [...unique, ...qs.filter(q => !unique.includes(q))];
    return merged.slice(0, count);
  } catch {
    return [];
  }
}
