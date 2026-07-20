import fs from 'fs';
import path from 'path';
import { chatWithJson, isLlmEnabled } from './llm';
import type { ChatMessage } from './llm';
import type { GeneratedQuiz, SelfTestQuestion, KnowledgeType } from '../types/knowledge';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const QUIZZES_DIR = path.join(DATA_DIR, 'quizzes');

function ensureDir(): void {
  fs.mkdirSync(QUIZZES_DIR, { recursive: true });
}

/** Extract plain text from an article HTML file by stripping all tags. */
function extractPlainText(fileName: string): string {
  const htmlPath = path.join(DATA_DIR, 'articles', fileName);
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Article not found: ${fileName}`);
  }
  const html = fs.readFileSync(htmlPath, 'utf-8');
  // Remove <style> blocks
  let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove <script> blocks
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x60;/g, '`')
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

interface LlmQuizResponse {
  questions: Array<{
    id: string;
    question: string;
    expectedAnswer: string;
    questionType: 'short' | 'choice';
    options?: string[];
    knowledgeType: KnowledgeType;
  }>;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/** Generate a unique question id from article fileName and question text. */
function makeQuestionId(fileName: string, questionText: string): string {
  const base = fileName.replace(/\.html$/, '');
  return `q_${base}_${simpleHash(questionText).slice(0, 8)}`;
}

/**
 * System prompt for LLM-based question generation.
 * Describes the 4 knowledge types and appropriate question styles.
 */
function buildSystemPrompt(): string {
  return `你是一个知识测试生成器。根据用户提供的文章内容，生成 1-3 道自测题。

知识类型及对应的出题风格：
1. 事实型(memory) — 具体的事实、数据、事件记录 → 事实回忆题，如"文章的结论是什么？""文中提到的数据是多少？"
2. 概念型(concept) — 抽象概念、理论框架、思想体系 → 用自己的话解释 / Feynman 风格，如"如何理解 XXX 这个概念？""XXX 的核心思想是什么？"
3. 程序型(procedure) — 操作步骤、方法论、流程指南 → 步骤/流程题，如"实现 XXX 需要哪些步骤？""按照什么顺序完成？"
4. 设计型(design) — 设计思路、架构决策、策略规划 → 权衡分析题，如"为什么选择 X 而不是 Y？""XXX 的设计权衡是什么？"

请输出 JSON 格式，包含一个 questions 数组。每个 question 包含：
- id: 唯一标识（用简短英文标识符）
- question: 问题文本
- expectedAnswer: 期望的正确答案
- questionType: "short" 或 "choice"
- options: 如果是选择题，提供 3-5 个选项数组（仅 questionType 为 choice 时提供）
- knowledgeType: 该问题对应的知识类型（"memory" | "concept" | "procedure" | "design"）`;
}

function buildUserPrompt(articleText: string): string {
  const truncated = articleText.slice(0, 3000);
  return `请根据以下文章内容生成自测题：\n\n${truncated}`;
}

/** Fallback: extract sentences ending with "?" as questions when LLM is disabled. */
function fallbackGenerateQuestions(fileName: string, articleText: string): SelfTestQuestion[] {
  const questions: SelfTestQuestion[] = [];
  const sentences = articleText.split(/[。！？\n]+/);
  const keySentences: string[] = [];

  // Collect sentences ending with "?" as potential questions
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith('？') || trimmed.endsWith('?')) {
      // Use the sentence before as expected answer if available
      const prevIdx = sentences.indexOf(s) - 1;
      const answer = prevIdx >= 0 && sentences[prevIdx].trim().length > 10
        ? sentences[prevIdx].trim().slice(0, 100)
        : '请参照原文';
      questions.push({
        id: makeQuestionId(fileName, trimmed),
        question: trimmed.slice(0, 120),
        expectedAnswer: answer,
        questionType: 'short',
      });
    }
    if (trimmed.length > 15) {
      keySentences.push(trimmed);
    }
  }

  // If no questions found from "?" sentences, create questions from key sentences
  if (questions.length === 0) {
    const pick = keySentences.slice(0, Math.min(3, keySentences.length));
    for (let i = 0; i < pick.length; i++) {
      const text = pick[i];
      questions.push({
        id: makeQuestionId(fileName, text),
        question: `文中提到：「${text.slice(0, 40)}...」，请问具体内容是什么？`,
        expectedAnswer: text.slice(0, 150),
        questionType: 'short',
      });
    }
  }

  return questions;
}

/**
 * Generate a complete quiz for an article.
 * Uses LLM when available, falls back to heuristic extraction.
 */
export async function generateQuizForArticle(fileName: string): Promise<GeneratedQuiz> {
  ensureDir();

  // Check if already cached
  const cached = getQuizForArticle(fileName);
  if (cached) return cached;

  const articleText = extractPlainText(fileName);
  if (!articleText) {
    throw new Error(`Empty article text for ${fileName}`);
  }

  let questions: SelfTestQuestion[];

  if (isLlmEnabled()) {
    try {
      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt(articleText);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const response = await chatWithJson<LlmQuizResponse>(messages);

      questions = (response.questions || []).map((q: LlmQuizResponse['questions'][number]) => ({
        id: makeQuestionId(fileName, q.question),
        question: q.question,
        expectedAnswer: q.expectedAnswer,
        questionType: q.questionType,
        options: q.options,
        knowledgeType: q.knowledgeType || 'memory',
      }));

      if (questions.length === 0) {
        throw new Error('LLM returned empty questions');
      }
    } catch (err) {
      console.error('[quiz-generator] LLM generation failed, falling back:', err instanceof Error ? err.message : err);
      questions = fallbackGenerateQuestions(fileName, articleText);
    }
  } else {
    questions = fallbackGenerateQuestions(fileName, articleText);
  }

  const quiz: GeneratedQuiz = {
    articleFileName: fileName,
    questions,
    knowledgeType: 'memory',
    generatedAt: Date.now(),
  };

  await saveQuiz(quiz);
  return quiz;
}

/**
 * Regenerate questions for an article, avoiding questions with the same text
 * as those in previousQuestions.
 */
export async function regenerateQuestions(
  fileName: string,
  previousQuestions: SelfTestQuestion[]
): Promise<SelfTestQuestion[]> {
  const articleText = extractPlainText(fileName);
  if (!articleText) {
    throw new Error(`Empty article text for ${fileName}`);
  }

  // Build a set of known question texts to avoid
  const knownTexts = new Set(previousQuestions.map(q => q.question.trim().toLowerCase()));

  if (isLlmEnabled()) {
    const systemPrompt = buildSystemPrompt() +
      '\n\n注意：请生成与以下列表中不重复的新问题。避免问题的措辞和考察点重复。';
    const previousList = previousQuestions.map(q => `- ${q.question}`).join('\n');
    const userPrompt = buildUserPrompt(articleText) +
      `\n\n已存在的问题（请避免重复）：\n${previousList}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    try {
      const response = await chatWithJson<LlmQuizResponse>(messages);
      const fresh = response.questions || [];

      // Filter out any that accidentally match previous questions
      const unique = fresh.filter(
        q => !knownTexts.has(q.question.trim().toLowerCase())
      );

      if (unique.length > 0) {
        return unique.map(q => ({
          id: makeQuestionId(fileName, q.question),
          question: q.question,
          expectedAnswer: q.expectedAnswer,
          questionType: q.questionType,
          options: q.options,
          knowledgeType: q.knowledgeType || 'memory',
        }));
      }
    } catch (err) {
      console.error('[quiz-generator] Regeneration failed:', err instanceof Error ? err.message : err);
    }
  }

  // Fallback: pick sentences that were not used before
  const sentences = articleText.split(/[。！？\n]+/).filter(s => s.trim().length > 15);
  const freshSentences = sentences.filter(s => !knownTexts.has(s.trim().slice(0, 40).toLowerCase()));
  const pick = freshSentences.slice(0, Math.min(3, freshSentences.length));

  if (pick.length === 0) {
    // If no fresh sentences, return a default
    return [{
      id: makeQuestionId(fileName, 'review'),
      question: `请回顾这篇文章的主要内容。`,
      expectedAnswer: '请参照原文自行总结。',
      questionType: 'short',
    }];
  }

  return pick.map(text => ({
    id: makeQuestionId(fileName, text),
    question: `请解释文中提到的「${text.slice(0, 40)}...」`,
    expectedAnswer: text.slice(0, 150),
    questionType: 'short',
  }));
}

/** Read cached quiz from disk. Returns null if not found. */
export function getQuizForArticle(fileName: string): GeneratedQuiz | null {
  const quizPath = path.join(QUIZZES_DIR, fileName);
  if (!fs.existsSync(quizPath)) return null;
  try {
    const raw = fs.readFileSync(quizPath, 'utf-8');
    return JSON.parse(raw) as GeneratedQuiz;
  } catch (err) {
    console.error('[quiz-generator] Failed to read cached quiz:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Save a quiz to disk. */
export async function saveQuiz(quiz: GeneratedQuiz): Promise<void> {
  ensureDir();
  const quizPath = path.join(QUIZZES_DIR, quiz.articleFileName);
  fs.writeFileSync(quizPath, JSON.stringify(quiz, null, 2), 'utf-8');
}

/** Delete a cached quiz file. */
export function deleteQuiz(fileName: string): void {
  const quizPath = path.join(QUIZZES_DIR, fileName);
  if (fs.existsSync(quizPath)) {
    fs.unlinkSync(quizPath);
  }
}
