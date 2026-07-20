import fs from 'fs';
import path from 'path';
import type { PeriodicSynthesis } from '../types/knowledge';
import { loadMeta, getArticlesDir } from './renderer';
import { chatWithJson, isLlmEnabled, ChatMessage } from './llm';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SYNTHESES_DIR = path.join(DATA_DIR, 'syntheses');

// ── Date helpers ────────────────────────────────────────────────────────

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO week number */
function getWeekNumber(d: Date): string {
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - startOfYear.getTime()) / 86400000);
  const week = Math.ceil((days + startOfYear.getDay() + 1) / 7);
  return `W${pad(week)}`;
}

function getPeriodDir(period: string): string {
  return path.join(SYNTHESES_DIR, period);
}

function synthesisFileName(period: string, d: Date): string {
  switch (period) {
    case 'daily':
      return `${formatDate(d)}.json`;
    case 'weekly':
      return `${d.getFullYear()}-${getWeekNumber(d)}.json`;
    case 'monthly':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}.json`;
    default:
      return `${formatDate(d)}.json`;
  }
}

/** Get the start timestamp for a period (in ms since epoch) */
function periodStart(period: string, now: number): number {
  const d = new Date(now);
  switch (period) {
    case 'daily':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case 'weekly': {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
      return new Date(d.getFullYear(), d.getMonth(), diff).getTime();
    }
    case 'monthly':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    default:
      return now;
  }
}

/** Get the end timestamp for a period */
function periodEnd(period: string, now: number): number {
  const start = periodStart(period, now);
  const d = new Date(start);
  switch (period) {
    case 'daily':
      return start + 86400000 - 1;
    case 'weekly':
      return start + 7 * 86400000 - 1;
    case 'monthly': {
      const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      return nextMonth.getTime() - 1;
    }
    default:
      return now;
  }
}

// ── Plain-text extraction ───────────────────────────────────────────────

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

// ── LLM-based synthesis ─────────────────────────────────────────────────

interface SynthesisContent {
  summary: string;
  highlights: string[];
  connections: Array<{ from: string; to: string; insight: string }>;
  knowledgeGaps: string[];
}

async function generateSynthesisWithLlm(
  period: string,
  periodStartTs: number,
  periodEndTs: number,
  articleEntries: Array<{ fileName: string; title: string; text: string }>
): Promise<SynthesisContent> {
  const articleList = articleEntries
    .map(a => `- [${a.title}] (${a.fileName})\n  ${a.text.substring(0, 400)}`)
    .join('\n');

  // Load the previous synthesis for continuity
  const prev = await getLatestSynthesis(period as 'daily' | 'weekly' | 'monthly');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a knowledge synthesizer. Given a list of articles collected in a time period, produce a structured synthesis.

Return JSON: {
  "summary": "A brief summary of what was collected and learned in this period",
  "highlights": ["Key insights or memorable points (3-5 items)"],
  "connections": [{"from": "article title or topic", "to": "article title or topic", "insight": "how they connect"}],
  "knowledgeGaps": ["Topics you read about but haven't fully understood yet"]
}

Rules:
- Keep the summary concise (2-4 sentences)
- Each highlight should be 1-2 sentences
- Connections should be specific, not generic
- Knowledge gaps should identify areas where more reading is needed
- Write in the same language as the articles (Chinese or English)`,
    },
    {
      role: 'user',
      content: `Articles in this period:\n${articleList}${prev ? `\n\nPrevious period's summary for continuity:\n${prev.summary}` : ''}`,
    },
  ];

  try {
    return await chatWithJson<SynthesisContent>(messages, { temperature: 0.3 });
  } catch (err) {
    console.error('[periodic-synthesis] LLM synthesis error:', err instanceof Error ? err.message : err);
    return {
      summary: `Period synthesis of ${articleEntries.length} articles.`,
      highlights: articleEntries.map(a => a.text.substring(0, 100)).slice(0, 3),
      connections: [],
      knowledgeGaps: [],
    };
  }
}

// ── Fallback aggregation ────────────────────────────────────────────────

function generateSynthesisFallback(
  period: string,
  periodStartTs: number,
  periodEndTs: number,
  articleEntries: Array<{ fileName: string; title: string; text: string }>
): SynthesisContent {
  const highlights = articleEntries.map(a => {
    const firstSentence = a.text.split(/[。.!？\n]/).filter(s => s.trim())[0];
    return `[${a.title}] ${(firstSentence || a.text).substring(0, 150)}`;
  });

  return {
    summary: `${articleEntries.length} articles collected in this period.`,
    highlights: highlights.slice(0, 5),
    connections: [],
    knowledgeGaps: [],
  };
}

// ── Core generation logic ───────────────────────────────────────────────

async function generateSynthesis(period: 'daily' | 'weekly' | 'monthly'): Promise<PeriodicSynthesis> {
  const now = Date.now();
  const pStart = periodStart(period, now);
  const pEnd = periodEnd(period, now);

  const meta = loadMeta();
  const inPeriod = meta.filter(m => {
    const ts = m.tweetTimestamp * 1000;
    return ts >= pStart && ts <= pEnd;
  });

  // Build article entries
  const articleEntries: Array<{ fileName: string; title: string; text: string }> = [];
  for (const m of inPeriod) {
    const text = readArticleText(m.fileName);
    articleEntries.push({
      fileName: m.fileName,
      title: m.title || m.fileName,
      text: text.substring(0, 2000),
    });
  }

  const articles = articleEntries.map(a => a.fileName);

  let content: SynthesisContent;

  if (isLlmEnabled() && articleEntries.length > 0) {
    content = await generateSynthesisWithLlm(period, pStart, pEnd, articleEntries);
  } else {
    content = generateSynthesisFallback(period, pStart, pEnd, articleEntries);
  }

  const synthesis: PeriodicSynthesis = {
    id: `${period}-${formatDate(new Date(now))}`,
    period,
    periodStart: pStart,
    periodEnd: pEnd,
    articles,
    summary: content.summary,
    highlights: content.highlights,
    connections: content.connections,
    generatedAt: now,
  };

  // Save to disk
  await saveSynthesis(synthesis);

  return synthesis;
}

// ── Storage ─────────────────────────────────────────────────────────────

async function saveSynthesis(synthesis: PeriodicSynthesis): Promise<void> {
  const periodDir = getPeriodDir(synthesis.period);
  fs.mkdirSync(periodDir, { recursive: true });

  const fileName = synthesisFileName(synthesis.period, new Date(synthesis.periodStart));
  const filePath = path.join(periodDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(synthesis, null, 2), 'utf-8');
}

async function loadSynthesisFile(periodDir: string, fileName: string): Promise<PeriodicSynthesis | null> {
  const filePath = path.join(periodDir, fileName);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PeriodicSynthesis;
  } catch {
    return null;
  }
}

function getSynthesisFileNames(periodDir: string): string[] {
  try {
    if (!fs.existsSync(periodDir)) return [];
    return fs.readdirSync(periodDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate synthesis for a given period.
 * Accepts a period string for compatibility with knowledge-api.ts.
 */
export async function generateDailySynthesis(period?: string): Promise<PeriodicSynthesis> {
  const p = period as 'daily' | 'weekly' | 'monthly' || 'daily';
  if (p === 'weekly') return generateWeeklySynthesis();
  if (p === 'monthly') return generateMonthlySynthesis();
  return generateSynthesis('daily');
}

/**
 * Generate a daily synthesis for today's articles.
 */
export async function generateWeeklySynthesis(): Promise<PeriodicSynthesis> {
  return generateSynthesis('weekly');
}

/**
 * Generate a monthly synthesis for this month's articles.
 */
export async function generateMonthlySynthesis(): Promise<PeriodicSynthesis> {
  return generateSynthesis('monthly');
}

/**
 * Get the latest synthesis for a given period.
 * @param period The period type: 'daily', 'weekly', or 'monthly'.
 */
export async function getLatestSynthesis(period: 'daily' | 'weekly' | 'monthly'): Promise<PeriodicSynthesis | null> {
  const periodDir = getPeriodDir(period);
  const fileNames = getSynthesisFileNames(periodDir);
  if (fileNames.length === 0) return null;

  const latest = fileNames[0]; // Already sorted reverse
  return loadSynthesisFile(periodDir, latest);
}

/**
 * Get all syntheses for a given period, optionally limited.
 * When period is omitted, returns syntheses from all periods (newest first).
 */
export async function getAllSyntheses(period?: 'daily' | 'weekly' | 'monthly', limit?: number): Promise<PeriodicSynthesis[]> {
  if (period) {
    const periodDir = getPeriodDir(period);
    const fileNames = getSynthesisFileNames(periodDir);
    const selected = limit ? fileNames.slice(0, limit) : fileNames;
    const results: PeriodicSynthesis[] = [];
    for (const fn of selected) {
      const s = await loadSynthesisFile(periodDir, fn);
      if (s) results.push(s);
    }
    return results;
  }

  // No period specified: return latest from each period
  const allPeriods: Array<'daily' | 'weekly' | 'monthly'> = ['daily', 'weekly', 'monthly'];
  const results: PeriodicSynthesis[] = [];
  for (const p of allPeriods) {
    const latest = await getLatestSynthesis(p);
    if (latest) results.push(latest);
  }
  return results.sort((a, b) => b.generatedAt - a.generatedAt);
}
