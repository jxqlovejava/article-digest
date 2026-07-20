/**
 * Type declarations for knowledge services being built by other agents.
 * These files don't exist yet — we declare their exports so that
 * dynamic import() calls in knowledge-api.ts and server.ts compile.
 *
 * All paths are relative to src/services/ (same directory as knowledge-api.ts).
 */

declare module './knowledge-classifier' {
  import type { ArticleKnowledge } from '../types/knowledge';
  export function annotateArticle(fileName: string): Promise<ArticleKnowledge>;
  export function classifyArticle(text: string): Promise<ArticleKnowledge>;
}

declare module './quiz-generator' {
  import type { GeneratedQuiz } from '../types/knowledge';
  export function generateQuizForArticle(fileName: string): Promise<GeneratedQuiz>;
  export function getQuizForArticle(fileName: string): Promise<GeneratedQuiz | null>;
  export function saveQuiz(quiz: GeneratedQuiz): Promise<void>;
}

declare module './spaced-repetition' {
  import type { ReviewTask, RepetitionState } from '../types/knowledge';
  export function initializeReviews(fileName: string): Promise<void>;
  export function getDueReviews(): Promise<ReviewTask[]>;
  export function recordAttempt(attempt: { questionId: string; articleFileName: string; isCorrect: boolean; userAnswer: string; selfAttribution: string; timestamp: number }): Promise<{ isCorrect: boolean; state: RepetitionState }>;
  export function getReviewStats(): Promise<{ total: number; due: number; mastered: number }>;
}

declare module './synthesis' {
  import type { ArticleLink } from '../types/knowledge';
  export function discoverLinks(fileName: string): Promise<ArticleLink[]>;
  export function getLinksForArticle(fileName: string): Promise<ArticleLink[]>;
  export function getAllLinks(): Promise<ArticleLink[]>;
  export function discoverAllLinks(): Promise<ArticleLink[]>;
}

declare module './topic-cluster' {
  import type { TopicCluster } from '../types/knowledge';
  export function buildTopicClusters(): Promise<TopicCluster[]>;
  export function getClusters(): Promise<TopicCluster[]>;
}

declare module './periodic-synthesis' {
  import type { PeriodicSynthesis } from '../types/knowledge';
  export function generateDailySynthesis(period: string): Promise<PeriodicSynthesis>;
  export function getLatestSynthesis(): Promise<PeriodicSynthesis | null>;
  export function getAllSyntheses(): Promise<PeriodicSynthesis[]>;
}

declare module './memory/store' {
  import type { L2Document, L3Document } from '../../types/knowledge' with { 'resolution-mode': 'import' };
  export function readL2Doc(surface: string): Promise<L2Document | null>;
  export function writeL2Doc(doc: L2Document): Promise<void>;
  export function addL2Entry(surface: string, section: string, text: string, refs?: string[]): Promise<void>;
  export function readL3Doc(slot: string): Promise<L3Document | null>;
  export function overview(): Promise<Record<string, unknown>>;
}

declare module './memory/trace' {
  import type { TraceEvent } from '../../types/knowledge' with { 'resolution-mode': 'import' };
  export function appendTrace(event: Omit<TraceEvent, 'traceId' | 'timestamp'>): Promise<string>;
  export function readTraces(surface: string, limit?: number): Promise<TraceEvent[]>;
}

declare module './memory/consolidator' {
  import type { L2Document } from '../../types/knowledge' with { 'resolution-mode': 'import' };
  export function consolidateL2(surface: string): Promise<L2Document>;
}
