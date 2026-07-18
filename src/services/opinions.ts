import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { chatWithJson, isLlmEnabled, ChatMessage } from './llm';
import { loadMeta } from './renderer';
import { getArticlesDir } from './renderer';

const DB_PATH = process.env.SEARCH_DB_PATH
  ? path.resolve(process.env.SEARCH_DB_PATH)
  : path.join(process.cwd(), 'data', 'search.db');

function ensureDbDir(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

function openOpinionsDb(): Database.Database {
  ensureDbDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS opinions (
      id TEXT PRIMARY KEY,
      article_filename TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'claim',
      status TEXT DEFAULT 'active',
      created_at INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS opinion_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      strength REAL DEFAULT 0.5,
      UNIQUE(source_id, target_id)
    );
  `);

  return db;
}

const db = openOpinionsDb();

const insertOpinionStmt = db.prepare(
  `INSERT OR REPLACE INTO opinions (id, article_filename, content, category, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
);
const getByArticleStmt = db.prepare(
  `SELECT * FROM opinions WHERE article_filename = ? AND status = 'active' ORDER BY created_at`
);
const deleteByArticleStmt = db.prepare(
  `DELETE FROM opinions WHERE article_filename = ?`
);
const getAllOpinionsStmt = db.prepare(
  `SELECT * FROM opinions WHERE status = 'active' ORDER BY created_at DESC`
);
const getOpinionByIdStmt = db.prepare(
  `SELECT * FROM opinions WHERE id = ?`
);
const insertLinkStmt = db.prepare(
  `INSERT OR REPLACE INTO opinion_links (source_id, target_id, relation, strength) VALUES (?, ?, ?, ?)`
);
const getLinksStmt = db.prepare(
  `SELECT * FROM opinion_links WHERE source_id = ? OR target_id = ?`
);

export interface Opinion {
  id: string;
  article_filename: string;
  content: string;
  category: 'claim' | 'method' | 'fact' | 'critique';
  status: 'active' | 'superseded' | 'contradicted';
  created_at: number;
}

export interface OpinionLink {
  id: number;
  source_id: string;
  target_id: string;
  relation: 'supports' | 'contradicts' | 'extends' | 'relates_to';
  strength: number;
}

interface ExtractedOpinion {
  content: string;
  category: 'claim' | 'method' | 'fact' | 'critique';
}

interface ExtractionResult {
  opinions: ExtractedOpinion[];
}

function extractArticleText(html: string): string {
  // Extract plain text from article HTML
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

function generateId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export async function extractOpinions(articleFilename: string): Promise<Opinion[]> {
  if (!isLlmEnabled()) {
    console.warn('[opinions] LLM not configured, skipping opinion extraction');
    return [];
  }

  const articlesDir = getArticlesDir();
  const htmlPath = path.join(articlesDir, articleFilename);
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Article not found: ${articleFilename}`);
  }

  const html = fs.readFileSync(htmlPath, 'utf-8');
  const text = extractArticleText(html);
  // Limit context to avoid token blowout
  const truncatedText = text.length > 6000 ? text.substring(0, 6000) + '...' : text;

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You extract key opinions/claims from articles. For each article, identify 1-5 independent, valuable opinions.
Each opinion should be 1-3 sentences, self-contained, and capture a specific insight (not a summary of the whole article).

Classify each opinion as:
- "claim": a debatable assertion or argument
- "method": a technique, approach, or how-to
- "fact": a verifiable statement or data point
- "critique": a criticism or limitation of something

Return JSON: {"opinions": [{"content": "...", "category": "claim|method|fact|critique"}]}

Rules:
- Extract only substantive opinions, not trivial observations
- If the article is too short or has no clear opinions, return empty array
- Keep the original language (Chinese or English), don't translate`,
    },
    {
      role: 'user',
      content: truncatedText,
    },
  ];

  const result = await chatWithJson<ExtractionResult>(messages, { temperature: 0.2 });

  // Remove existing opinions for this article
  deleteByArticleStmt.run(articleFilename);

  const opinions: Opinion[] = [];
  for (const op of result.opinions || []) {
    if (!op.content || op.content.trim().length < 10) continue;
    const opinion: Opinion = {
      id: generateId(),
      article_filename: articleFilename,
      content: op.content.trim(),
      category: op.category || 'claim',
      status: 'active',
      created_at: Date.now(),
    };
    insertOpinionStmt.run(
      opinion.id,
      opinion.article_filename,
      opinion.content,
      opinion.category,
      opinion.status,
      opinion.created_at
    );
    opinions.push(opinion);
  }

  return opinions;
}

export async function extractAllOpinions(onProgress?: (current: number, total: number, filename: string) => void): Promise<{ total: number; extracted: number; errors: number }> {
  const meta = loadMeta();
  let extracted = 0;
  let errors = 0;

  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    if (onProgress) onProgress(i + 1, meta.length, m.fileName);
    try {
      const opinions = await extractOpinions(m.fileName);
      if (opinions.length > 0) extracted++;
    } catch (err) {
      errors++;
      console.error(`[opinions] Failed for ${m.fileName}:`, err instanceof Error ? err.message : err);
    }
  }

  return { total: meta.length, extracted, errors };
}

export function getOpinionsByArticle(articleFilename: string): Opinion[] {
  return getByArticleStmt.all(articleFilename) as Opinion[];
}

export function getAllOpinions(): Opinion[] {
  return getAllOpinionsStmt.all() as Opinion[];
}

export function getOpinionById(id: string): Opinion | undefined {
  return getOpinionByIdStmt.get(id) as Opinion | undefined;
}

export async function linkOpinions(): Promise<number> {
  if (!isLlmEnabled()) return 0;

  const opinions = getAllOpinions();
  if (opinions.length < 2) return 0;

  // Process in batches of 30 to stay within token limits
  let totalLinks = 0;
  const batchSize = 30;

  for (let i = 0; i < opinions.length; i += batchSize) {
    const batch = opinions.slice(i, i + batchSize);
    const opinionsList = batch.map(o => `[${o.id.substring(0, 8)}] ${o.content.substring(0, 120)}`).join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `Find relationships between the following opinions. For each pair that has a meaningful connection, describe their relationship.

Relations: "supports" (one supports the other), "contradicts" (one contradicts the other), "extends" (one builds upon the other), "relates_to" (general relatedness).

Return JSON: {"links": [{"source": "opinion_id_prefix", "target": "opinion_id_prefix", "relation": "supports|contradicts|extends|relates_to", "strength": 0.8}]}

Only include links where you're reasonably confident. Do NOT link every pair - only the meaningful ones (max ~15 links per batch).`,
      },
      {
        role: 'user',
        content: opinionsList,
      },
    ];

    try {
      const result = await chatWithJson<{ links: Array<{ source: string; target: string; relation: string; strength: number }> }>(
        messages,
        { temperature: 0.1 }
      );

      for (const link of result.links || []) {
        // Find full opinion IDs matching the prefixes
        const sourceOpinion = opinions.find(o => o.id.startsWith(link.source));
        const targetOpinion = opinions.find(o => o.id.startsWith(link.target));
        if (!sourceOpinion || !targetOpinion) continue;
        if (sourceOpinion.id === targetOpinion.id) continue;

        try {
          insertLinkStmt.run(
            sourceOpinion.id,
            targetOpinion.id,
            link.relation || 'relates_to',
            link.strength || 0.5
          );
          totalLinks++;
        } catch { /* skip duplicate */ }
      }
    } catch (err) {
      console.error('[opinions] Link error:', err instanceof Error ? err.message : err);
    }
  }

  return totalLinks;
}

export function getOpinionLinks(opinionId: string): OpinionLink[] {
  return getLinksStmt.all(opinionId, opinionId) as OpinionLink[];
}

export function closeOpinionsDb(): void {
  db.close();
}
