import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { ReviewTask, QuizAttempt, ErrorType, RepetitionState, KnowledgeType } from '../types/knowledge';
import { getQuizForArticle } from './quiz-generator';

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
    CREATE TABLE IF NOT EXISTS review_tasks (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      article_filename TEXT NOT NULL,
      question TEXT NOT NULL,
      expected_answer TEXT NOT NULL,
      question_type TEXT DEFAULT 'short',
      options TEXT,
      knowledge_type TEXT DEFAULT 'memory',
      due_at INTEGER NOT NULL,
      priority INTEGER DEFAULT 0,
      interval_index INTEGER DEFAULT 0,
      easiness_factor REAL DEFAULT 2.5,
      consecutive_correct INTEGER DEFAULT 0,
      consecutive_wrong INTEGER DEFAULT 0,
      next_review_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL,
      article_filename TEXT NOT NULL,
      is_correct INTEGER NOT NULL,
      user_answer TEXT,
      error_type TEXT,
      self_attribution TEXT DEFAULT '',
      timestamp INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_review_tasks_due
    ON review_tasks(due_at, priority);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_quiz_attempts_question
    ON quiz_attempts(question_id, timestamp);
  `);

  return db;
}

const db = openDb();

// Prepared statements
const insertTaskStmt = db.prepare(`
  INSERT OR REPLACE INTO review_tasks
    (id, question_id, article_filename, question, expected_answer, question_type, options,
     knowledge_type, due_at, priority, interval_index, easiness_factor,
     consecutive_correct, consecutive_wrong, next_review_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getDueTasksStmt = db.prepare(`
  SELECT * FROM review_tasks WHERE due_at <= ? ORDER BY priority ASC, due_at ASC LIMIT ?
`);

const getOverdueCountStmt = db.prepare(`
  SELECT COUNT(*) AS cnt FROM review_tasks WHERE due_at < ?
`);

const getTaskByIdStmt = db.prepare(`
  SELECT * FROM review_tasks WHERE id = ?
`);

const updateTaskAfterAttemptStmt = db.prepare(`
  UPDATE review_tasks
  SET interval_index = ?, easiness_factor = ?, consecutive_correct = ?,
      consecutive_wrong = ?, due_at = ?, next_review_at = ?, priority = ?
  WHERE id = ?
`);

const insertAttemptStmt = db.prepare(`
  INSERT INTO quiz_attempts
    (question_id, article_filename, is_correct, user_answer, error_type, self_attribution, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const deleteTasksByArticleStmt = db.prepare(`
  DELETE FROM review_tasks WHERE article_filename = ?
`);

const deleteAttemptsByArticleStmt = db.prepare(`
  DELETE FROM quiz_attempts WHERE article_filename = ?
`);

const countAllTasksStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM review_tasks`);
const countDueTasksStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM review_tasks WHERE due_at <= ?`);
const countMasteredStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM review_tasks WHERE interval_index >= 4`);

// ── SM-2 Interval Progression ────────────────────────────────────────────────

const MIN_EASINESS_FACTOR = 1.3;
const INITIAL_EASINESS_FACTOR = 2.5;
const MAX_PRIORITY = 1000;

const SM2_INTERVALS_DAYS = [0, 1, 3, 7, 16, 30, 90, 180, 365];

function getIntervalDays(intervalIndex: number): number {
  if (intervalIndex < 0) return 1;
  if (intervalIndex < SM2_INTERVALS_DAYS.length) return SM2_INTERVALS_DAYS[intervalIndex];
  // For index beyond the table, grow exponentially
  return SM2_INTERVALS_DAYS[SM2_INTERVALS_DAYS.length - 1] * Math.pow(1.5, intervalIndex - SM2_INTERVALS_DAYS.length + 1);
}

/**
 * Apply SM-2 algorithm to compute the next state after a review attempt.
 *
 * Adapted from DeepTutor's scheduler:
 * - Correct: interval advances through SM2_INTERVALS_DAYS * easiness_factor
 * - Wrong: resets to 1 day, easiness_factor -= 0.2 (min 1.3)
 */
export function computeNextState(
  state: RepetitionState,
  isCorrect: boolean,
  easinessFactor: number
): { state: RepetitionState; ef: number } {
  let ef = easinessFactor;

  if (isCorrect) {
    ef = Math.max(MIN_EASINESS_FACTOR, ef + 0.1);
    const newIntervalIndex = state.intervalIndex + 1;
    const intervalDays = getIntervalDays(newIntervalIndex);
    const intervalMs = intervalDays * 24 * 60 * 60 * 1000;

    return {
      state: {
        intervalIndex: newIntervalIndex,
        consecutiveCorrect: state.consecutiveCorrect + 1,
        consecutiveWrong: 0,
        nextReviewAt: Date.now() + intervalMs,
        knowledgeType: state.knowledgeType,
      },
      ef,
    };
  } else {
    ef = Math.max(MIN_EASINESS_FACTOR, ef - 0.2);
    const intervalMs = 1 * 24 * 60 * 60 * 1000; // Reset to 1 day

    return {
      state: {
        intervalIndex: 0,
        consecutiveCorrect: 0,
        consecutiveWrong: state.consecutiveWrong + 1,
        nextReviewAt: Date.now() + intervalMs,
        knowledgeType: state.knowledgeType,
      },
      ef,
    };
  }
}

function computePriority(state: RepetitionState, intervalIndex: number): number {
  // Lower priority = more urgent
  // Priority scales with overdue-ness: new cards have moderate priority,
  // overdue cards have very low priority numbers (high urgency).
  const base = Math.max(0, MAX_PRIORITY - intervalIndex * 100);
  return base;
}

// ── Grade Answer ─────────────────────────────────────────────────────────────

/**
 * Extract key terms from text for fuzzy matching.
 * For Chinese text: also extracts character bigrams.
 * For Latin text: splits by whitespace.
 */
function extractKeyTerms(text: string): string[] {
  const terms = new Set<string>();

  // Split by known delimiters (works for both Latin and Chinese)
  const parts = text.split(/[\s,，。！？、；：""''（）《》【】···…—\-+]+/).filter(t => t.length >= 2);
  for (const p of parts) terms.add(p);

  // For Chinese text: extract character bigrams for fuzzy matching
  if (/[一-鿿]/.test(text)) {
    const chars = [...text].filter(c => /[一-鿿0-9a-zA-Z]/.test(c));
    if (chars.length >= 2) {
      for (let i = 0; i < chars.length - 1; i++) {
        terms.add(chars.slice(i, i + 2).join(''));
      }
    }
  }

  return [...terms];
}

/**
 * Compute character-level bigram similarity (Jaccard-like) between two strings.
 * Returns a value between 0 and 1.
 */
function charBigramSimilarity(a: string, b: string): number {
  const getBigrams = (s: string): Set<string> => {
    const chars = [...s.toLowerCase()];
    const bigrams = new Set<string>();
    for (let i = 0; i < chars.length - 1; i++) {
      bigrams.add(chars.slice(i, i + 2).join(''));
    }
    return bigrams;
  };

  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);

  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  // Jaccard-like: intersection / max(sizeA, sizeB) penalizes length mismatch
  return intersection / Math.max(bigramsA.size, bigramsB.size);
}

/**
 * Grade a user answer against the expected answer.
 *
 * For choice type: exact match.
 * For short type: check if user answer contains key terms from expected answer.
 */
export function gradeAnswer(userAnswer: string, expectedAnswer: string, questionType: string): boolean {
  const normalizedUser = userAnswer.trim().toLowerCase();
  const normalizedExpected = expectedAnswer.trim().toLowerCase();

  if (!normalizedUser) return false;

  if (questionType === 'choice') {
    return normalizedUser === normalizedExpected;
  }

  // For short type: combine key term matching with character-bigram similarity
  // Strategy: accept if either key term overlap >= 40% OR bigram similarity >= 25%

  // Approach 1: Key term overlap
  const keyTerms = extractKeyTerms(normalizedExpected);
  let keyTermPass = false;
  if (keyTerms.length > 0) {
    const matchCount = keyTerms.filter(term => normalizedUser.includes(term)).length;
    const matchRate = matchCount / keyTerms.length;
    keyTermPass = matchRate >= 0.4;
  }

  // Approach 2: Character bigram similarity (works well for Chinese partial matches)
  const bigramSim = charBigramSimilarity(normalizedUser, normalizedExpected);
  const bigramPass = bigramSim >= 0.25;

  return keyTermPass || bigramPass;
}

/**
 * Classify the type of error based on user answer.
 *
 * Inspired by DeepTutor's classify_error.
 */
export function classifyError(userAnswer: string, expectedAnswer?: string): ErrorType {
  const normalizedUser = userAnswer.trim().toLowerCase();
  const normalizedExpected = (expectedAnswer || '').trim().toLowerCase();

  // Empty answer → structural (knowledge gap)
  if (!normalizedUser) {
    return 'structural';
  }

  // If expected answer provided, check for partial correctness
  if (normalizedExpected) {
    const keyTerms = extractKeyTerms(normalizedExpected);

    if (keyTerms.length > 0) {
      const matchCount = keyTerms.filter(t => normalizedUser.includes(t)).length;
      const matchRate = matchCount / keyTerms.length;

      // Partially correct (20-40%) → deviation
      if (matchRate > 0 && matchRate < 0.4) {
        return 'deviation';
      }

      // Some terms match but details wrong → application
      if (matchRate >= 0.4 && matchRate < 0.8) {
        return 'application';
      }
    }
  }

  // Check for metacognitive indicators
  const metaIndicators = [
    '知道', '明白', '了解', '懂', '忘了', '忘记',
    'i knew', 'i know', 'i understand', 'i forgot',
  ];
  if (metaIndicators.some(ind => normalizedUser.includes(ind))) {
    return 'metacognitive';
  }

  // Default: deviation
  return 'deviation';
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize review tasks for an article by reading its cached quiz and
 * inserting review_tasks rows into the DB. Returns the number of tasks created.
 */
export async function initializeReviews(fileName: string): Promise<number> {
  const quiz = getQuizForArticle(fileName);
  if (!quiz || !quiz.questions || quiz.questions.length === 0) {
    console.error(`[spaced-repetition] No quiz found for ${fileName}`);
    return 0;
  }

  const now = Date.now();
  let count = 0;

  const insertMany = db.transaction(() => {
    for (const q of quiz.questions) {
      const taskId = `r_${q.id}`;
      const intervalMs = getIntervalDays(0) * 24 * 60 * 60 * 1000;
      const dueAt = now + intervalMs;
      const priority = computePriority(
        { intervalIndex: 0, consecutiveCorrect: 0, consecutiveWrong: 0, nextReviewAt: dueAt, knowledgeType: quiz.knowledgeType },
        0
      );

      insertTaskStmt.run(
        taskId,                    // id
        q.id,                      // question_id
        fileName,                  // article_filename
        q.question,                // question
        q.expectedAnswer,          // expected_answer
        q.questionType,            // question_type
        q.options ? JSON.stringify(q.options) : null,  // options
        quiz.knowledgeType,  // knowledge_type
        dueAt,                     // due_at
        priority,                  // priority
        0,                         // interval_index
        INITIAL_EASINESS_FACTOR,   // easiness_factor
        0,                         // consecutive_correct
        0,                         // consecutive_wrong
        dueAt,                     // next_review_at
        now                        // created_at
      );
      count++;
    }
  });

  insertMany();
  return count;
}

/**
 * Get due review tasks. Ordered by priority (lower = more urgent) then due_at.
 */
export function getDueReviews(limit: number = 20): ReviewTask[] {
  const now = Date.now();
  const rows = getDueTasksStmt.all(now, limit) as Array<Record<string, unknown>>;

  return rows.map(rowToReviewTask);
}

function rowToReviewTask(row: Record<string, unknown>): ReviewTask {
  const state: RepetitionState = {
    intervalIndex: Number(row.interval_index) || 0,
    consecutiveCorrect: Number(row.consecutive_correct) || 0,
    consecutiveWrong: Number(row.consecutive_wrong) || 0,
    nextReviewAt: Number(row.next_review_at) || 0,
    knowledgeType: (row.knowledge_type as KnowledgeType) || 'memory',
  };

  return {
    id: String(row.id),
    questionId: String(row.question_id),
    articleFileName: String(row.article_filename),
    question: String(row.question),
    expectedAnswer: String(row.expected_answer),
    questionType: (String(row.question_type) as 'short' | 'choice') || 'short',
    options: row.options ? JSON.parse(String(row.options)) : undefined,
    knowledgeType: (row.knowledge_type as KnowledgeType) || 'memory',
    dueAt: Number(row.due_at) || 0,
    priority: Number(row.priority) || 0,
    state,
  };
}

/**
 * Count how many tasks are overdue (due_at < now).
 */
export function getOverdueCount(): number {
  const row = getOverdueCountStmt.get(Date.now()) as { cnt: number };
  return row?.cnt || 0;
}

/**
 * Record a quiz attempt and update the associated review task's SM-2 state.
 */
export async function recordAttempt(attempt: QuizAttempt): Promise<void> {
  const now = attempt.timestamp || Date.now();

  // Insert attempt record
  insertAttemptStmt.run(
    attempt.questionId,
    attempt.articleFileName,
    attempt.isCorrect ? 1 : 0,
    attempt.userAnswer || null,
    attempt.errorType || null,
    attempt.selfAttribution || '',
    now
  );

  // Find the associated review task
  const taskRow = getTaskByIdStmt.get(`r_${attempt.questionId}`) as Record<string, unknown> | undefined;
  if (!taskRow) {
    console.error(`[spaced-repetition] No review task found for question ${attempt.questionId}`);
    return;
  }

  // Build current state
  const currentState: RepetitionState = {
    intervalIndex: Number(taskRow.interval_index) || 0,
    consecutiveCorrect: Number(taskRow.consecutive_correct) || 0,
    consecutiveWrong: Number(taskRow.consecutive_wrong) || 0,
    nextReviewAt: Number(taskRow.next_review_at) || 0,
    knowledgeType: (taskRow.knowledge_type as KnowledgeType) || 'memory',
  };

  const currentEf = Number(taskRow.easiness_factor) || INITIAL_EASINESS_FACTOR;

  // Compute new state
  const { state: newState, ef: newEf } = computeNextState(currentState, attempt.isCorrect, currentEf);
  const dueAt = newState.nextReviewAt;
  const priority = computePriority(newState, newState.intervalIndex);

  updateTaskAfterAttemptStmt.run(
    newState.intervalIndex,
    newEf,
    newState.consecutiveCorrect,
    newState.consecutiveWrong,
    dueAt,
    newState.nextReviewAt,
    priority,
    `r_${attempt.questionId}`
  );
}

/**
 * Get aggregate review statistics.
 */
export function getReviewStats(): { total: number; due: number; mastered: number } {
  const total = (countAllTasksStmt.get() as { cnt: number })?.cnt || 0;
  const due = (countDueTasksStmt.get(Date.now()) as { cnt: number })?.cnt || 0;
  const mastered = (countMasteredStmt.get() as { cnt: number })?.cnt || 0;

  return { total, due, mastered };
}

/**
 * Delete all review tasks and attempts for a given article.
 */
export function deleteArticleReviews(fileName: string): void {
  const cleanup = db.transaction(() => {
    deleteTasksByArticleStmt.run(fileName);
    deleteAttemptsByArticleStmt.run(fileName);
  });
  cleanup();
}
