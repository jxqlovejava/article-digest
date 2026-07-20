import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { ArticleLink } from '../types/knowledge';
import { loadMeta, getArticlesDir } from './renderer';
import { searchArticles } from './search';
import { chatWithJson, isLlmEnabled, ChatMessage } from './llm';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = process.env.KNOWLEDGE_DB_PATH
  ? path.resolve(process.env.KNOWLEDGE_DB_PATH)
  : path.join(DATA_DIR, 'knowledge.db');

function ensureDbDir(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

function openDb(): Database.Database {
  ensureDbDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS article_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_filename TEXT NOT NULL,
      target_filename TEXT NOT NULL,
      relation TEXT NOT NULL,
      strength REAL DEFAULT 0.5,
      explanation TEXT,
      created_at INTEGER,
      UNIQUE(source_filename, target_filename)
    );
  `);

  return db;
}

// ── Plain-text extraction from article HTML ──────────────────────────────

function extractPlainText(html: string): string {
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

const CHINESE_STOP_WORDS = new Set([
  '一个', '这个', '那个', '这些', '那些', '什么', '怎么', '如何',
  '可以', '没有', '不是', '就是', '但是', '而且', '因为', '所以',
  '如果', '虽然', '然后', '之后', '同时', '还有', '已经', '以及',
  '或者', '那么', '这样', '那样', '这里', '那里', '每个', '所有',
  '我们', '他们', '它们', '你们', '自己', '别人', '其他',
  '其中', '之一', '一些', '很多', '大量', '部分', '整个',
  '这种', '那种', '通过', '进行', '利用', '使用', '需要', '能够',
  '应该', '可能', '不会', '不断', '开始', '成为', '进入', '出现',
  '目前', '当前', '未来', '过去', '之前', '之后', '期间', '时候',
  '问题', '情况', '方面', '方式', '方法', '过程', '结果', '影响',
  '信息', '数据', '内容', '领域', '行业', '市场', '经济', '社会',
  '发展', '变化', '趋势', '管理', '技术', '系统', '产品', '服务',
]);

const ENGLISH_STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'not', 'but', 'had', 'has', 'was', 'all',
  'can', 'any', 'its', 'our', 'who', 'see', 'use', 'may', 'via', 'how',
  'get', 'set', 'say', 'one', 'two', 'new', 'now', 'yet', 'also', 'just',
  'than', 'that', 'this', 'with', 'from', 'they', 'have', 'been', 'were',
  'more', 'some', 'what', 'when', 'where', 'which', 'their', 'them',
  'into', 'over', 'such', 'each', 'about', 'would', 'could', 'should',
  'other', 'after', 'then', 'than', 'many', 'these', 'those',
]);

function extractTopics(text: string, maxTopics = 15): string[] {
  // Chinese character sequences (2+ chars)
  const cnPhrases: string[] = [];
  const cnMatches = text.match(/[一-鿿]{2,}/g) || [];
  for (const phrase of cnMatches) {
    const trimmed = phrase.trim();
    if (trimmed.length >= 2 && !CHINESE_STOP_WORDS.has(trimmed)) {
      cnPhrases.push(trimmed);
    }
  }

  // English words (3+ chars)
  const enWords: string[] = [];
  const enMatches = text.match(/[a-zA-Z]{3,}/g) || [];
  for (const word of enMatches) {
    const lower = word.toLowerCase();
    if (!ENGLISH_STOP_WORDS.has(lower)) {
      enWords.push(lower);
    }
  }

  // Count frequencies
  const freq = new Map<string, number>();
  for (const p of cnPhrases) freq.set(p, (freq.get(p) || 0) + 1);
  for (const w of enWords) freq.set(w, (freq.get(w) || 0) + 1);

  // Sort by frequency descending, then by length (prefer more distinctive terms)
  return [...freq.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    })
    .slice(0, maxTopics)
    .map(([term]) => term);
}

function readArticleText(fileName: string): string {
  const articlesDir = getArticlesDir();
  const htmlPath = path.join(articlesDir, fileName);
  if (!fs.existsSync(htmlPath)) return '';
  try {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    return extractPlainText(html);
  } catch {
    return '';
  }
}

/** In-memory topic cache per batch — avoids re-parsing HTML */
const topicCache = new Map<string, string[]>();

function getTopicsForArticle(fileName: string): string[] {
  if (!topicCache.has(fileName)) {
    const text = readArticleText(fileName);
    topicCache.set(fileName, extractTopics(text));
  }
  return topicCache.get(fileName) || [];
}

function clearTopicCache(): void {
  topicCache.clear();
}

/**
 * Find the article title from meta.json or extract from HTML.
 */
function getArticleTitle(fileName: string): string {
  const meta = loadMeta();
  const entry = meta.find(m => m.fileName === fileName);
  if (entry?.title) return entry.title;
  // Fallback: extract from HTML
  const text = readArticleText(fileName);
  const lines = text.split('\n').filter(l => l.trim());
  return lines[0] || fileName;
}

// ── LLM-based link discovery ────────────────────────────────────────────

interface DiscoveryResult {
  links: Array<{
    targetFileName: string;
    relation: 'supports' | 'contradicts' | 'extends' | 'summarizes' | 'related';
    strength: number;
    explanation: string;
  }>;
}

async function discoverWithLlm(
  sourceFileName: string,
  sourceTopics: string[],
  candidates: Array<{ fileName: string; title: string; snippet: string }>
): Promise<ArticleLink[]> {
  const now = Date.now();
  const sourceTitle = getArticleTitle(sourceFileName);
  const sourceText = readArticleText(sourceFileName);
  const sourceSnippet = sourceText.substring(0, 1000);

  const candidateList = candidates
    .map(c => `- ${c.title} (${c.fileName}): ${c.snippet.substring(0, 300)}`)
    .join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You analyze relationships between articles and classify them.

Relationship types:
- "supports" — Article B provides evidence or reasoning supporting Article A's claims
- "contradicts" — Article B presents an opposing viewpoint or conflicting evidence to Article A
- "extends" — Article B builds upon, deepens, or further develops Article A's topic
- "summarizes" — Article B is a summary or overview of what Article A covers in detail
- "related" — Same general topic, but no stronger relationship

Return JSON: {"links": [{"targetFileName": "...", "relation": "...", "strength": 0.8, "explanation": "..."}]}

Rules:
- Only include links where you're reasonably confident
- Strength 0..1 (higher = stronger relationship)
- Explanation should be 1-2 sentences describing the relationship
- If no meaningful links, return empty links array`,
    },
    {
      role: 'user',
      content: `Source article:
Title: ${sourceTitle}
File: ${sourceFileName}
Topics: ${sourceTopics.join(', ')}
Content: ${sourceSnippet.substring(0, 800)}

Candidate articles:
${candidateList}

Identify which candidate articles relate to the source article and classify the relationship.`,
    },
  ];

  try {
    const result = await chatWithJson<DiscoveryResult>(messages, { temperature: 0.1 });

    return (result.links || []).map(link => ({
      sourceFileName,
      targetFileName: link.targetFileName,
      relation: link.relation,
      strength: Math.min(1, Math.max(0, link.strength)),
      explanation: link.explanation || '',
      createdAt: now,
    }));
  } catch (err) {
    console.error('[synthesis] LLM discovery error:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Topic overlap fallback ──────────────────────────────────────────────

function discoverWithTopicOverlap(
  sourceFileName: string,
  sourceTopics: string[],
  candidates: Array<{ fileName: string; title: string; snippet: string }>
): ArticleLink[] {
  const now = Date.now();
  const links: ArticleLink[] = [];

  for (const candidate of candidates) {
    if (candidate.fileName === sourceFileName) continue;
    const candidateTopics = getTopicsForArticle(candidate.fileName);
    const sharedTopics = sourceTopics.filter(t => candidateTopics.includes(t));
    const sharedCount = sharedTopics.length;

    if (sharedCount >= 2) {
      const strength = Math.min(0.9, 0.3 + 0.1 * sharedCount);
      links.push({
        sourceFileName,
        targetFileName: candidate.fileName,
        relation: 'related',
        strength,
        explanation: `Shared topics: ${sharedTopics.slice(0, 5).join(', ')}`,
        createdAt: now,
      });
    }
  }

  return links;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Discover relationship links from sourceFileName to other articles.
 * Returns links sorted by strength descending.
 */
export async function discoverLinks(articleFileName: string): Promise<ArticleLink[]> {
  const meta = loadMeta();
  const sourceMeta = meta.find(m => m.fileName === articleFileName);
  if (!sourceMeta) return [];

  // Clear cache for fresh extraction
  clearTopicCache();
  const sourceTopics = getTopicsForArticle(articleFileName);
  if (sourceTopics.length === 0) return [];

  // Get candidate articles: exclude source, search by topics
  const otherArticles = meta.filter(m => m.fileName !== articleFileName);
  if (otherArticles.length === 0) return [];

  // Try FTS search first, fallback to all other meta entries
  const query = sourceTopics.slice(0, 5).join(' ');
  const searched = await searchArticles(query);
  const searchedSet = new Set(searched);

  const candidates: Array<{ fileName: string; title: string; snippet: string }> = [];
  for (const m of otherArticles) {
    const fileName = m.fileName;
    if (!searchedSet.has(fileName) && searched.length > 0) continue;
    const text = readArticleText(fileName);
    candidates.push({
      fileName,
      title: m.title || fileName,
      snippet: text.substring(0, 500),
    });
  }

  if (candidates.length === 0) return [];

  let links: ArticleLink[];

  if (isLlmEnabled()) {
    links = await discoverWithLlm(articleFileName, sourceTopics, candidates);
  } else {
    links = discoverWithTopicOverlap(articleFileName, sourceTopics, candidates);
  }

  // Store links in DB
  const db = openDb();
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO article_links (source_filename, target_filename, relation, strength, explanation, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction((linkList: ArticleLink[]) => {
    for (const link of linkList) {
      insertStmt.run(link.sourceFileName, link.targetFileName, link.relation, link.strength, link.explanation, link.createdAt);
    }
  });

  insertMany(links);
  db.close();

  return links.sort((a, b) => b.strength - a.strength);
}

/**
 * Run discoverLinks for all articles. Returns number of new links found.
 * Skips articles already processed (tracked by checking DB for links from that source).
 */
export async function discoverAllLinks(): Promise<number> {
  const meta = loadMeta();
  let totalNew = 0;

  const db = openDb();
  const hasLinksStmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM article_links WHERE source_filename = ?`
  );
  db.close();

  for (const m of meta) {
    const db2 = openDb();
    const row = hasLinksStmt.get(m.fileName) as { cnt: number };
    db2.close();

    if (row.cnt > 0) {
      console.error(`[synthesis] Skipping ${m.fileName} — already processed`);
      continue;
    }

    try {
      const links = await discoverLinks(m.fileName);
      totalNew += links.length;
      console.error(`[synthesis] ${m.fileName}: found ${links.length} links`);
    } catch (err) {
      console.error(`[synthesis] Failed for ${m.fileName}:`, err instanceof Error ? err.message : err);
    }
  }

  return totalNew;
}

/**
 * Get all links involving this article (as source or target).
 */
export function getLinksForArticle(fileName: string): ArticleLink[] {
  const db = openDb();
  const stmt = db.prepare(
    `SELECT * FROM article_links WHERE source_filename = ? OR target_filename = ? ORDER BY strength DESC`
  );
  const rows = stmt.all(fileName, fileName) as Array<{
    source_filename: string;
    target_filename: string;
    relation: string;
    strength: number;
    explanation: string;
    created_at: number;
  }>;
  db.close();

  return rows.map(r => ({
    sourceFileName: r.source_filename,
    targetFileName: r.target_filename,
    relation: r.relation as ArticleLink['relation'],
    strength: r.strength,
    explanation: r.explanation || '',
    createdAt: r.created_at,
  }));
}

/**
 * Get all links in the database.
 */
export function getAllLinks(): ArticleLink[] {
  const db = openDb();
  const stmt = db.prepare(
    `SELECT * FROM article_links ORDER BY strength DESC`
  );
  const rows = stmt.all() as Array<{
    source_filename: string;
    target_filename: string;
    relation: string;
    strength: number;
    explanation: string;
    created_at: number;
  }>;
  db.close();

  return rows.map(r => ({
    sourceFileName: r.source_filename,
    targetFileName: r.target_filename,
    relation: r.relation as ArticleLink['relation'],
    strength: r.strength,
    explanation: r.explanation || '',
    createdAt: r.created_at,
  }));
}
