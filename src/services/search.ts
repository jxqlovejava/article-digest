import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// Lazily loaded; if it fails we fall back to keyword-only search.
let embedder: ((text: string) => Promise<Float32Array>) | null = null;
let embedderReady = false;
let embedderFailed = false;

const DB_PATH = process.env.SEARCH_DB_PATH
  ? path.resolve(process.env.SEARCH_DB_PATH)
  : path.join(process.cwd(), 'data', 'search.db');
const EMBEDDING_DIM = 384;
const SEMANTIC_TOP_K = 20;

export interface SearchableArticle {
  fileName: string;
  title: string;
  author: string;
  authorHandle: string;
  body: string;
}

function ensureDbDir(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

function openDb(): Database.Database {
  ensureDbDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // FTS5 with trigram tokenizer handles mixed Chinese/English content reasonably.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
      fileName UNINDEXED,
      title,
      author,
      authorHandle,
      body,
      tokenize='trigram'
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS articles_vec (
      fileName TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      generatedAt INTEGER
    );
  `);

  return db;
}

const db = openDb();

const insertFtsStmt = db.prepare(
  `INSERT OR REPLACE INTO articles_fts (fileName, title, author, authorHandle, body) VALUES (?, ?, ?, ?, ?)`
);
const deleteFtsStmt = db.prepare(`DELETE FROM articles_fts WHERE fileName = ?`);
const deleteVecStmt = db.prepare(`DELETE FROM articles_vec WHERE fileName = ?`);
const insertVecStmt = db.prepare(
  `INSERT OR REPLACE INTO articles_vec (fileName, embedding, generatedAt) VALUES (?, ?, ?)`
);
const listVecStmt = db.prepare(`SELECT fileName, embedding FROM articles_vec LIMIT 20000`);
const existsVecStmt = db.prepare(`SELECT 1 FROM articles_vec WHERE fileName = ?`);

export function insertArticle(article: SearchableArticle): void {
  // FTS5 has no real unique constraint — delete then insert to avoid duplicates
  deleteFtsStmt.run(article.fileName);
  insertFtsStmt.run(
    article.fileName,
    article.title,
    article.author,
    article.authorHandle,
    article.body
  );
}

export function deleteArticle(fileName: string): void {
  deleteFtsStmt.run(fileName);
  deleteVecStmt.run(fileName);
}

export function syncMeta(fileNames: string[]): void {
  const valid = new Set(fileNames);
  const ftsRows = db.prepare(`SELECT fileName FROM articles_fts`).all() as { fileName: string }[];
  for (const row of ftsRows) {
    if (!valid.has(row.fileName)) deleteArticle(row.fileName);
  }
}

async function getEmbedder(): Promise<((text: string) => Promise<Float32Array>) | null> {
  if (embedderReady) return embedder;
  if (embedderFailed) return null;

  try {
    // Dynamic import keeps startup fast when semantic search is not used.
    // @ts-expect-error - @xenova/transformers is optional
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = path.join(process.cwd(), 'data', '.cache', 'transformers');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: false,
    });

    embedder = async (text: string): Promise<Float32Array> => {
      const truncated = text.slice(0, 4000);
      const output = (await extractor(truncated, {
        pooling: 'mean',
        normalize: true,
      })) as { data: Float32Array; dims: number[] };
      return output.data.slice(0, EMBEDDING_DIM);
    };

    embedderReady = true;
    return embedder;
  } catch (err) {
    console.error('[search] Failed to load embedding model:', err instanceof Error ? err.message : err);
    embedderFailed = true;
    return null;
  }
}

export async function generateEmbedding(fileName: string, text: string): Promise<void> {
  const embed = await getEmbedder();
  if (!embed) return;

  try {
    const vector = await embed(text);
    const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    insertVecStmt.run(fileName, buffer, Date.now());
  } catch (err) {
    console.error(`[search] Embedding failed for ${fileName}:`, err instanceof Error ? err.message : err);
  }
}

export function setTestEmbedder(fn: ((text: string) => Promise<Float32Array>) | null): void {
  if (process.env.NODE_ENV !== 'test') {
    console.warn('[search] setTestEmbedder ignored outside test environment');
    return;
  }
  embedder = fn;
  embedderReady = fn !== null;
  embedderFailed = fn === null;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function escapeFtsQuery(query: string): string {
  // Keep only letters, numbers, and spaces. Trigram tokenizer works best on clean text.
  // Don't wrap terms in quotes — trigram does substring matching natively.
  return query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

async function semanticSearch(query: string): Promise<string[]> {
  const embed = await getEmbedder();
  if (!embed) return [];

  const queryVec = await embed(query);
  const rows = listVecStmt.all() as { fileName: string; embedding: Buffer }[];

  const scored = rows
    .map(row => {
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, EMBEDDING_DIM);
      return { fileName: row.fileName, score: cosineSimilarity(queryVec, vec) };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEMANTIC_TOP_K);

  return scored.map(item => item.fileName);
}

const shortKeywordStmt = db.prepare(
  `SELECT fileName, title, authorHandle, body FROM articles_fts WHERE title LIKE ? ESCAPE '\\' OR authorHandle LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'`
);

function escapeLike(text: string): string {
  return text.replace(/[%_]/g, '\\$&');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsCjk(text: string): boolean {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text);
}

type FtsRow = {
  fileName: string;
  title: string;
  authorHandle: string;
  body: string;
};

const ftsMatchStmt = db.prepare(
  `SELECT fileName, title, authorHandle, body FROM articles_fts WHERE articles_fts MATCH ?`
);

const MAX_SEARCH_RESULTS = 50;
const SCORE_TITLE = 100;
const SCORE_TITLE_PREFIX = 25;
const SCORE_HANDLE = 80;
const SCORE_BODY = 15;
const SCORE_BODY_HIT = 2;
const MAX_BODY_HIT_BONUS = 10;

export function shortKeywordSearch(query: string): string[] {
  // Literal LIKE path (preserves % / _ as characters via ESCAPE)
  const pattern = `%${escapeLike(query)}%`;
  const rows = shortKeywordStmt.all(pattern, pattern, pattern) as FtsRow[];
  const seen = new Set<string>();
  const result: string[] = [];

  if (containsCjk(query)) {
    for (const row of rows) {
      if (!seen.has(row.fileName)) {
        seen.add(row.fileName);
        result.push(row.fileName);
      }
    }
    return result;
  }

  // ASCII: word-boundary so "IP" ∉ "ship"
  const re = new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(query)}(?![a-zA-Z0-9])`, 'i');
  for (const row of rows) {
    if (seen.has(row.fileName)) continue;
    // Also allow exact substring when query contains non-word symbols (%, _, etc.)
    const hasSpecial = /[^a-zA-Z0-9]/.test(query);
    const hay = `${row.title}\n${row.authorHandle}\n${row.body}`;
    if (hasSpecial ? hay.includes(query) : re.test(hay)) {
      seen.add(row.fileName);
      result.push(row.fileName);
    }
  }
  return result;
}

function fetchLikeCandidates(term: string): FtsRow[] {
  const pattern = `%${escapeLike(term)}%`;
  return shortKeywordStmt.all(pattern, pattern, pattern) as FtsRow[];
}

/** Word-boundary match for Latin tokens (avoids IP∈ship). */
function asciiWordRe(term: string): RegExp {
  return new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(term)}(?![a-zA-Z0-9])`, 'gi');
}

function scoreAsciiDoc(terms: string[], title: string, handle: string, body: string): number {
  let score = 0;
  let termsMatched = 0;
  const t = title || '';
  const h = handle || '';
  const b = body || '';

  for (const term of terms) {
    const re = asciiWordRe(term);
    let hit = false;
    if (re.test(t)) {
      score += SCORE_TITLE;
      hit = true;
      if (new RegExp(`^${escapeRegex(term)}\\b`, 'i').test(t.trim())) {
        score += SCORE_TITLE_PREFIX;
      }
    }
    re.lastIndex = 0;
    if (re.test(h)) {
      score += SCORE_HANDLE;
      hit = true;
    }
    re.lastIndex = 0;
    const bodyHits = b.match(re);
    if (bodyHits && bodyHits.length > 0) {
      score += SCORE_BODY + Math.min(bodyHits.length, MAX_BODY_HIT_BONUS) * SCORE_BODY_HIT;
      hit = true;
    }
    if (hit) termsMatched += 1;
  }

  // Multi-word queries: require every term somewhere (AND)
  if (terms.length > 1 && termsMatched < terms.length) return 0;
  return score;
}

function finalizeRanking(
  scored: { fileName: string; score: number }[]
): { fileName: string; score: number }[] {
  scored.sort((a, b) => b.score - a.score || a.fileName.localeCompare(b.fileName));

  // Prefer title/handle hits; only keep a short tail of body-only matches
  const strong = scored.filter((h) => h.score >= SCORE_TITLE);
  const weak = scored.filter((h) => h.score > 0 && h.score < SCORE_TITLE);
  const merged =
    strong.length > 0 ? [...strong, ...weak.slice(0, 15)] : weak.slice(0, MAX_SEARCH_RESULTS);

  // Dedupe fileName (FTS can have rare dups)
  const seen = new Set<string>();
  const out: { fileName: string; score: number }[] = [];
  for (const h of merged) {
    if (seen.has(h.fileName)) continue;
    seen.add(h.fileName);
    out.push(h);
    if (out.length >= MAX_SEARCH_RESULTS) break;
  }
  return out;
}

function rankAsciiOrShort(query: string): { fileName: string; score: number }[] {
  const terms = escapeFtsQuery(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  let rows: FtsRow[] = [];
  const needsLike = terms.some((t) => t.length < 3);

  if (needsLike) {
    // Short tokens: LIKE candidates, then word-boundary score (AND across terms)
    if (terms.length === 1) {
      rows = fetchLikeCandidates(terms[0]);
    } else {
      const sets = terms.map((t) => new Set(fetchLikeCandidates(t).map((r) => r.fileName)));
      let inter = sets[0];
      for (let i = 1; i < sets.length; i++) {
        inter = new Set([...inter].filter((x) => sets[i].has(x)));
      }
      // Reload rows for intersection (use first term's rows filtered)
      const byName = new Map<string, FtsRow>();
      for (const t of terms) {
        for (const r of fetchLikeCandidates(t)) {
          if (inter.has(r.fileName)) byName.set(r.fileName, r);
        }
      }
      rows = [...byName.values()];
    }
  } else {
    const ftsQuery = terms.join(' ');
    try {
      rows = ftsMatchStmt.all(ftsQuery) as FtsRow[];
    } catch (err) {
      console.error('[search] FTS query failed:', err instanceof Error ? err.message : err);
      // Fallback LIKE for first term
      rows = fetchLikeCandidates(terms[0]);
    }
  }

  const scored: { fileName: string; score: number }[] = [];
  for (const row of rows) {
    const score = scoreAsciiDoc(terms, row.title, row.authorHandle, row.body);
    if (score > 0) scored.push({ fileName: row.fileName, score });
  }
  return finalizeRanking(scored);
}

// Break CJK text into overlapping bigrams for substring matching.
// "AI循环工程" → ["AI","I循","循环","环工","工程"]
function cjkBigrams(text: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    result.push(text.substring(i, i + 2));
  }
  return result;
}

// Common CJK words that don't carry search meaning (query stripping + filters)
const CJK_STOP_WORDS = new Set([
  '怎么','什么','如何','为什么','吗','呢','吧','啊','的','了','是','在',
  '有','不','我','你','他','她','它','们','这','那','哪','着','过',
  '会','能','可以','应该','要','就','也','都','很','和','与','或',
  '但','而','因为','所以','如果','虽然','然后','之后','之前','等等',
  '一个','这个','那个','哪个','一些','一下','一点','有点','还是',
  '已经','正在','一直','总是','比较','非常','真的','可能','大概',
  '自己','我们','你们','他们','什么是','怎么样','怎样','哪些','多少',
  // question / filler — strip so RAG doesn't require them as AND phrases
  '通常','遵循','请问','帮我','一下','是否','能否','应该','一般','常见',
  '关于','对于','怎样','为何','请问下','求教','谢谢',
]);

function uniqueStrings(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Split mixed CN/EN queries into required ASCII brands + CJK content phrases.
 * e.g. "怎么在Reddit赚到自己的第一桶金" → ascii:[Reddit], cjk:[赚到, 第一桶金]
 *
 * Old bigram-OR search treated "自己"/"第一" as enough to match unrelated posts.
 */
function extractSearchTokens(query: string): { ascii: string[]; cjkPhrases: string[] } {
  const ascii = uniqueStrings(
    [...query.matchAll(/[A-Za-z][A-Za-z0-9+.\-]{1,}/g)].map((m) => m[0]).filter((t) => t.length >= 2)
  );

  let rest = query.replace(/[A-Za-z][A-Za-z0-9+.\-%]*/g, ' ');
  const multiStops = [...CJK_STOP_WORDS]
    .filter((s) => s.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const sw of multiStops) {
    if (rest.includes(sw)) rest = rest.split(sw).join(' ');
  }
  // Strip common single-char particles / function words
  rest = rest.replace(
    /[的了是在有和与或但而之及对从到向于被把给让吗呢吧啊哦嗯个一不也都很还要就会能可就又再只才]/g,
    ' '
  );
  rest = rest.replace(/[^\u4e00-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim();

  const cjkPhrases = uniqueStrings([...rest.matchAll(/[\u4e00-\u9fff]{2,12}/g)].map((m) => m[0]));
  return { ascii, cjkPhrases };
}

function docHaystack(row: FtsRow): { titleH: string; all: string } {
  const titleH = `${row.title || ''}\n${row.authorHandle || ''}`;
  return { titleH, all: `${titleH}\n${row.body || ''}` };
}

/**
 * Match a CJK phrase against doc text.
 * Full hit preferred; else longest substring core (e.g. 高容错率 → 容错率 in title).
 * Returns strength 0..1 and whether match is in title/handle.
 */
function matchCjkPhrase(
  phrase: string,
  titleH: string,
  all: string
): { strength: number; inTitle: boolean } {
  if (!phrase) return { strength: 0, inTitle: false };
  if (titleH.includes(phrase)) return { strength: 1, inTitle: true };
  if (all.includes(phrase)) return { strength: 1, inTitle: false };

  // Progressive cores: longer substrings first (suffix/prefix/middle)
  if (phrase.length >= 3) {
    for (let len = phrase.length - 1; len >= 2; len--) {
      let best: { strength: number; inTitle: boolean } | null = null;
      for (let i = 0; i + len <= phrase.length; i++) {
        const sub = phrase.slice(i, i + len);
        if (titleH.includes(sub)) {
          const s = len / phrase.length;
          if (!best || s > best.strength) best = { strength: s, inTitle: true };
        } else if (all.includes(sub)) {
          const s = len / phrase.length;
          if (!best || (s > best.strength && !best.inTitle)) {
            best = { strength: s * 0.95, inTitle: false };
          }
        }
      }
      // Accept solid core (≥2 chars, ≥50% of phrase, or any 3+ char core)
      if (best && (best.strength >= 0.5 || len >= 3)) return best;
    }
  }

  // Bigram coverage fallback (strict)
  const bgs = cjkBigrams(phrase);
  if (bgs.length >= 2) {
    let bgHit = 0;
    let titleBg = 0;
    for (const bg of bgs) {
      if (titleH.includes(bg)) {
        bgHit += 1;
        titleBg += 1;
      } else if (all.includes(bg)) bgHit += 1;
    }
    const cov = bgHit / bgs.length;
    if (cov >= 0.8) {
      return { strength: cov * 0.7, inTitle: titleBg > 0 };
    }
  }
  return { strength: 0, inTitle: false };
}

function scoreContentDoc(
  ascii: string[],
  cjkPhrases: string[],
  title: string,
  handle: string,
  body: string
): number {
  const titleH = `${title || ''}\n${handle || ''}`;
  const all = `${titleH}\n${body || ''}`;
  let score = 0;

  // Latin tokens (brands / product names) are hard requirements
  for (const term of ascii) {
    const re = asciiWordRe(term);
    if (re.test(titleH)) score += 150;
    else if (re.test(all)) score += 35;
    else return 0;
  }

  if (cjkPhrases.length === 0) {
    return score;
  }

  let phrasesHit = 0;
  let titlePhraseHits = 0;
  let strongCoreHits = 0; // strength >= 0.5
  for (const phrase of cjkPhrases) {
    const hit = matchCjkPhrase(phrase, titleH, all);
    if (hit.strength <= 0) continue;

    // Longer / more distinctive phrases dominate short common ones (原则/思路…)
    // e.g. 高容错率→容错率 should beat bare 原则 in unrelated titles
    const lenBoost = phrase.length >= 4 ? 1.35 : phrase.length === 3 ? 1.15 : 0.55;
    const base = hit.inTitle
      ? 110 + phrase.length * 10
      : 28 + phrase.length * 4;
    score += Math.round(base * hit.strength * lenBoost);

    if (hit.inTitle) titlePhraseHits += 1;
    phrasesHit += hit.strength;
    if (hit.strength >= 0.5) strongCoreHits += 1;
  }

  // Natural-language questions produce many tokens; don't require ~all of them.
  // At least one solid core match (≥0.5), or brand+title Chinese.
  // Multi-phrase: require ~40% coverage (was 67% → empty RAG for real questions).
  const minPhrases =
    cjkPhrases.length <= 1
      ? 1
      : cjkPhrases.length === 2
        ? 1
        : Math.max(1, Math.ceil(cjkPhrases.length * 0.4));

  if (phrasesHit + 1e-9 < minPhrases && strongCoreHits < 1) {
    if (!(ascii.length > 0 && titlePhraseHits >= 1)) return 0;
  }
  // No solid core at all → reject (avoids pure noise bigram hits)
  if (strongCoreHits < 1 && titlePhraseHits < 1 && ascii.length === 0) {
    return 0;
  }

  return score;
}

/**
 * Content-token search for CJK and mixed CN/EN queries.
 * 1) Seed candidates from the most distinctive token (ASCII brand preferred)
 * 2) AND-filter remaining ASCII tokens
 * 3) Score with phrase/title preference; drop weak bigram-only hits
 */
function contentSearchRanked(query: string): { fileName: string; score: number }[] {
  const compact = query.replace(/\s+/g, '');
  // Ultra-short pure CJK (≤4 chars): exact substring, title-first ranking
  if (!/[A-Za-z]/.test(query) && compact.length > 0 && compact.length <= 4) {
    const rows = fetchLikeCandidates(compact);
    const scored = rows.map((r) => {
      let score = 0;
      if ((r.title || '').includes(compact)) score += SCORE_TITLE + 40;
      if ((r.authorHandle || '').includes(compact)) score += SCORE_HANDLE;
      if ((r.body || '').includes(compact)) score += SCORE_BODY;
      return { fileName: r.fileName, score };
    });
    return finalizeRanking(scored.filter((h) => h.score > 0));
  }

  const { ascii, cjkPhrases } = extractSearchTokens(query);
  if (ascii.length === 0 && cjkPhrases.length === 0) {
    // Query was all stop-words — fall back to cleaned compact substring if any CJK left
    const fallback = compact.replace(
      /[的了是在有和与或但而之及对从到向于被把给让吗呢吧啊哦嗯个一不也都很还要就会能]/g,
      ''
    );
    if (fallback.length >= 2) {
      const rows = fetchLikeCandidates(fallback);
      return finalizeRanking(
        rows.map((r) => ({
          fileName: r.fileName,
          score: (r.title || '').includes(fallback) ? SCORE_TITLE : SCORE_BODY,
        }))
      );
    }
    return [];
  }

  // Seeds: brands first, then longest CJK + cores (高容错率 → also 容错率)
  const seedTerms: string[] = [];
  if (ascii.length > 0) {
    seedTerms.push(...[...ascii].sort((a, b) => b.length - a.length));
  }
  const cjkByLen = [...cjkPhrases].sort((a, b) => b.length - a.length);
  for (const p of cjkByLen) {
    seedTerms.push(p);
    if (p.length >= 4) {
      seedTerms.push(p.slice(1)); // drop leading char
      seedTerms.push(p.slice(0, -1));
      if (p.length >= 5) seedTerms.push(p.slice(1, -1));
    }
  }
  const seeds = uniqueStrings(seedTerms).slice(0, 8);

  const byName = new Map<string, FtsRow>();
  for (const seed of seeds) {
    let batch = fetchLikeCandidates(seed);
    if (/^[A-Za-z]/.test(seed)) {
      const re = asciiWordRe(seed);
      batch = batch.filter((r) => re.test(docHaystack(r).all));
    }
    for (const r of batch) {
      if (!byName.has(r.fileName)) byName.set(r.fileName, r);
    }
    if (byName.size >= 200) break;
  }

  let rows = [...byName.values()];

  // AND remaining ASCII brands
  for (const term of ascii) {
    const re = asciiWordRe(term);
    rows = rows.filter((r) => re.test(docHaystack(r).all));
  }

  const scored: { fileName: string; score: number }[] = [];
  for (const row of rows) {
    const score = scoreContentDoc(ascii, cjkPhrases, row.title, row.authorHandle, row.body);
    if (score > 0) scored.push({ fileName: row.fileName, score });
  }
  return finalizeRanking(scored);
}

export function keywordSearch(query: string): string[] {
  const q = query.trim();
  if (!q || q.length < 2) return [];

  // CJK or mixed CN/EN → token/AND search (not loose bigram OR)
  if (containsCjk(q)) {
    return contentSearchRanked(q).map((h) => h.fileName);
  }

  return rankAsciiOrShort(q).map((h) => h.fileName);
}

export async function searchArticles(query: string): Promise<string[]> {
  const normalized = query.trim();
  if (!normalized || normalized.length < 2) return [];

  const isCjk = containsCjk(normalized);
  const ftsResults = keywordSearch(normalized);

  // CJK with hits: skip semantic (keyword is good enough for CJK)
  if (isCjk && ftsResults.length > 0) {
    return ftsResults.slice(0, MAX_SEARCH_RESULTS);
  }
  // Non-CJK with enough hits: skip semantic
  if (ftsResults.length >= 3) {
    return ftsResults.slice(0, MAX_SEARCH_RESULTS);
  }
  // Fall through: try semantic for CJK with 0 results, or non-CJK with < 3 results

  const semanticResults = await semanticSearch(normalized);
  const seen = new Set(ftsResults);
  const ordered = [...ftsResults];
  for (const fileName of semanticResults) {
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    ordered.push(fileName);
    if (ordered.length >= MAX_SEARCH_RESULTS) break;
  }
  return ordered;
}

// Get FTS5 snippets for search results
export function getSnippets(query: string, fileNames: string[]): Map<string, string> {
  const snippets = new Map<string, string>();
  const escaped = escapeFtsQuery(query);
  if (!escaped) return snippets;

  for (const fileName of fileNames) {
    try {
      const row = db.prepare(
        `SELECT snippet(articles_fts, 1, '<em>', '</em>', '...', 40) as s FROM articles_fts WHERE fileName = ? AND articles_fts MATCH ?`
      ).get(fileName, escaped) as { s: string } | undefined;
      if (row?.s) snippets.set(fileName, row.s);
    } catch {
      // snippet() can fail if query syntax doesn't match
    }
  }
  return snippets;
}

const KEYWORD_STOP_WORDS = new Set([
  '的', '了', '是', '在', '有', '和', '与', '或', '但', '而', '为', '之', '及', '等', '对',
  '从', '到', '向', '于', '被', '把', '给', '让', '叫', '使', '得', '着', '过', '吗', '呢',
  '吧', '啊', '哦', '嗯', '这个', '那个', '什么', '怎么', '为什么', '如何', '一个', '可以',
  '已经', '正在', '没有', '就是', '不是', '这样', '那样', '我们', '你们', '他们', '她们',
  '它们', '自己', '这里', '那里', '哪里', '现在', '当时', '今天', '明天', '昨天', '时候',
  '时间', '方式', '问题', '事情', '东西', '地方', '人员', '工作', '生活', '世界', '社会',
  '公司', '企业', '产品', '服务', '用户', '客户', '项目', '系统', '平台', '文章', '内容',
  '分享', '推荐', '收藏', '转发', '评论', '点赞', '微博', '推特', '微信', '公众', '号',
  '我', '你', '他', '她', '它', '这', '那', '哪', '个', '一', '不', '也', '都', '很', '还',
  '要', '就', '会', '能', '可', '应', '该', '想', '说', '看', '来', '去', '上', '下', '中',
  '大', '小', '多', '少', '好', '坏', '新', '旧', '高', '低', '长', '短', '前', '后', '内',
  '外', '里', '间', '边', '面', '方', '头', '部', '身', '体', '心', '手', '眼', '口', '声',
  '地', '得', '着', '过', '将', '被', '把', '给', '让', '跟', '同', '和', '与', '或', '但',
  '因为', '所以', '如果', '虽然', '然后', '之后', '之前', '等等', '一些', '一下', '一点',
  '有点', '还是', '一直', '总是', '比较', '非常', '真的', '可能', '大概', '你的', '我的',
  '他的', '她的', '它的', '我们的', '你们的', '他们的', '精华',
]);

/**
 * Build a complete, human-readable search suggestion from an article title.
 * Prefer full phrases with clear meaning — never return one-word shreds like "Loop" / "Announcing".
 */
function extractSuggestPhrase(title: string): string {
  let t = String(title || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/&(?:quot|amp|lt|gt|nbsp|#\d+);/gi, ' ')
    .replace(/["""'']/g, '')
    .replace(/[#@]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t) return '';

  // Drop noisy prefixes
  t = t.replace(/^(?:转发[：:]\s*|re:\s*|RE:\s*)/i, '');
  t = t.replace(/^(?:万字长文\s*[|｜]\s*)/, '');

  // Prefer main title before | / 丨 subtitle (keep complete left clause)
  const pipeParts = t.split(/\s*[|丨]\s*/);
  if (pipeParts[0] && pipeParts[0].trim().length >= 8) {
    t = pipeParts[0].trim();
  }

  // "短主题：长说明" → use short topic only when it already reads as a full phrase
  const colonMatch = t.match(/^(.{8,28}?)[：:](.+)$/);
  if (colonMatch) {
    const left = colonMatch[1].trim();
    const words = left.split(/\s+/).filter(Boolean);
    const hasCjk = /[\u4e00-\u9fff]/.test(left);
    // e.g. "Loop Engineering：..." or "循环工程：..."
    if ((hasCjk && left.length >= 4) || (!hasCjk && words.length >= 2)) {
      t = left;
    }
  }

  // Reject incomplete / low-value shreds
  if (t.length < 8) return '';
  if (KEYWORD_STOP_WORDS.has(t)) return '';
  // Single Latin token (Announcing / Claude alone / Loop)
  if (/^[A-Za-z0-9][A-Za-z0-9+\-./]*$/.test(t) && t.length < 12) return '';
  // Starts with dangling English function words only when whole string is tiny
  if (/^(?:How|What|Why|The|A|An|Is|Are|To)\s/i.test(t) && t.split(/\s+/).length < 4 && t.length < 18) {
    // keep longer questions like "How to build an audience..."
  }

  const MAX = 36;
  if (t.length <= MAX) return t;

  // Soft truncate at a natural boundary — avoid mid-phrase 14-char cuts
  const slice = t.slice(0, MAX);
  const bounds = [' ', '，', '。', '、', '：', ':', '—', '–', '-', '；', '；', '·'];
  let best = -1;
  for (const b of bounds) {
    const i = slice.lastIndexOf(b);
    if (i >= 16 && i > best) best = i;
  }
  const cut = (best > 0 ? slice.slice(0, best) : slice).trim();
  // Don't return if cut became too short / meaningless
  if (cut.length < 8) return '';
  return cut + (t.length > cut.length ? '…' : '');
}

/** Higher = better suggestion candidate */
function suggestQuality(phrase: string): number {
  let s = 0;
  const len = phrase.length;
  if (len >= 12 && len <= 36) s += 4;
  else if (len >= 8 && len <= 40) s += 2;
  else s -= 1;

  if (/[\u4e00-\u9fff]/.test(phrase)) s += 2;
  const words = phrase.split(/\s+/).filter(Boolean);
  if (words.length >= 3) s += 3;
  else if (words.length === 2) s += 1;

  // Looks like a complete topic
  if (/[：:]/.test(phrase) || /[\u4e00-\u9fff]{4,}/.test(phrase)) s += 1;
  if (/…$/.test(phrase)) s -= 1;
  // Single CamelCase / bare product token
  if (/^[A-Z][a-zA-Z0-9]*$/.test(phrase)) s -= 4;
  if (/^(?:How|What|Why|The|A|An)\b/i.test(phrase) && words.length < 4) s -= 2;

  return s;
}

export function getSearchSuggestions(limit: number = 3): string[] {
  const countRow = db.prepare(`SELECT COUNT(*) as c FROM articles_fts`).get() as { c: number } | undefined;
  const total = countRow?.c || 0;
  if (total === 0) return [];

  // Collect a pool of quality phrases, then pick diverse top ones
  const pool: { phrase: string; quality: number }[] = [];
  const seenPhrase = new Set<string>();
  const usedOffset = new Set<number>();
  const maxAttempts = Math.min(Math.max(total * 2, 80), 400);

  let attempts = 0;
  while (pool.length < Math.max(limit * 8, 24) && attempts < maxAttempts) {
    attempts++;
    const offset = Math.floor(Math.random() * total);
    if (usedOffset.has(offset)) continue;
    usedOffset.add(offset);
    const row = db.prepare(`SELECT title FROM articles_fts LIMIT 1 OFFSET ?`).get(offset) as
      | { title: string }
      | undefined;
    const phrase = extractSuggestPhrase(row?.title || '');
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seenPhrase.has(key)) continue;
    seenPhrase.add(key);
    const q = suggestQuality(phrase);
    if (q < 2) continue; // drop low-quality shreds
    pool.push({ phrase, quality: q });
  }

  // Sort by quality, then light shuffle among peers for "换一换"
  pool.sort((a, b) => b.quality - a.quality || Math.random() - 0.5);

  const results: string[] = [];
  for (const item of pool) {
    // Avoid near-duplicates (same 8-char prefix)
    const prefix = item.phrase.slice(0, 8);
    if (results.some((r) => r.slice(0, 8) === prefix)) continue;
    results.push(item.phrase);
    if (results.length >= limit) break;
  }
  return results;
}

/** Wipe and rebuild FTS from a full article list (used by reindex scripts). */
export function rebuildFtsIndex(articles: SearchableArticle[]): number {
  const tx = db.transaction((items: SearchableArticle[]) => {
    db.exec(`DELETE FROM articles_fts`);
    for (const a of items) {
      insertFtsStmt.run(a.fileName, a.title, a.author, a.authorHandle, a.body);
    }
  });
  tx(articles);
  return articles.length;
}

export function closeSearchDb(): void {
  db.close();
}
