/**
 * Knowledge system types — inspired by DeepTutor's knowledge management model.
 *
 * Three-layer memory (L1→L2→L3), knowledge classification (4 types),
 * spaced repetition, content→quiz generation, cross-article synthesis.
 */

// ── Knowledge Classification ──────────────────────────────────────────────

export type KnowledgeType = 'memory' | 'concept' | 'procedure' | 'design';

export const KNOWLEDGE_TYPE_LABELS: Record<KnowledgeType, string> = {
  memory: '事实型',
  concept: '概念型',
  procedure: '程序型',
  design: '设计型',
};

export const KNOWLEDGE_TYPE_PROMPT_HINTS: Record<KnowledgeType, string> = {
  memory: '具体的事实、数据、事件记录',
  concept: '抽象概念、理论框架、思想体系',
  procedure: '操作步骤、方法论、流程指南',
  design: '设计思路、架构决策、策略规划',
};

// ── Article Knowledge Annotation ──────────────────────────────────────────

export interface ArticleKnowledge {
  /** Article fileName this annotation belongs to */
  articleFileName: string;
  /** Primary knowledge type */
  knowledgeType: KnowledgeType;
  /** 3-5 key points extracted from the article */
  keyPoints: string[];
  /** 1-3 self-test questions (for spaced repetition) */
  selfTestQuestions: SelfTestQuestion[];
  /** Topics / tags for cross-article linking */
  topics: string[];
  /** When this was generated */
  generatedAt: number;
}

export interface SelfTestQuestion {
  id: string;
  question: string;
  /** Short expected answer (for grading reference, never shown to model) */
  expectedAnswer: string;
  questionType: 'short' | 'choice';
  options?: string[]; // for choice type
  knowledgePointId?: string;
}

// ── Three-Layer Memory ────────────────────────────────────────────────────

/** L1: Raw event trace entry (append-only JSONL per surface per day) */
export interface TraceEvent {
  traceId: string;
  surface: Surface;
  eventType: 'archive' | 'read' | 'quiz_attempt' | 'review' | 'synthesis' | 'opinion';
  payload: Record<string, unknown>;
  timestamp: number;
}

export type Surface = 'articles' | 'quiz' | 'opinions' | 'search';

export const SURFACES: Surface[] = ['articles', 'quiz', 'opinions', 'search'];

/** L2: Per-surface consolidated memory entry */
export interface L2Entry {
  id: string;
  section: string;
  text: string;
  /** Refs to source traceIds or article filenames */
  refs: string[];
  createdAt: number;
  updatedAt: number;
}

/** L2 document: sectioned markdown with footnote citations */
export interface L2Document {
  surface: Surface;
  title: string;
  sections: { name: string; entries: L2Entry[] }[];
  updatedAt: number;
}

/** L3: Cross-surface synthesis slots */
export type L3Slot = 'recent' | 'profile' | 'scope' | 'preferences';

export const L3_SLOTS: L3Slot[] = ['recent', 'profile', 'scope', 'preferences'];

export const L3_SLOT_LABELS: Record<L3Slot, string> = {
  recent: '近期摘要',
  profile: '知识画像',
  scope: '知识范围',
  preferences: '偏好设置',
};

export interface L3Document {
  slot: L3Slot;
  title: string;
  sections: { name: string; entries: L2Entry[] }[];
  updatedAt: number;
}

// ── Spaced Repetition ─────────────────────────────────────────────────────

export interface RepetitionState {
  /** Current interval index (0 = new, grows with each correct review) */
  intervalIndex: number;
  /** Consecutive correct reviews */
  consecutiveCorrect: number;
  /** Consecutive wrong attempts */
  consecutiveWrong: number;
  /** Next review timestamp (ms) */
  nextReviewAt: number;
  /** Knowledge type for interval tuning */
  knowledgeType: KnowledgeType;
}

export interface ReviewTask {
  id: string;
  questionId: string;
  articleFileName: string;
  question: string;
  expectedAnswer: string;
  questionType: 'short' | 'choice';
  options?: string[];
  knowledgeType: KnowledgeType;
  dueAt: number;
  priority: number; // lower = higher priority (0 = overdue)
  state: RepetitionState;
}

export interface QuizAttempt {
  questionId: string;
  articleFileName: string;
  isCorrect: boolean;
  userAnswer: string;
  errorType?: ErrorType;
  selfAttribution: string;
  timestamp: number;
}

export type ErrorType = 'structural' | 'deviation' | 'application' | 'metacognitive';

export const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  structural: '知识缺口',
  deviation: '理解偏差',
  application: '应用错误',
  metacognitive: '元认知偏差',
};

// ── Cross-Article Synthesis ────────────────────────────────────────────────

export interface ArticleLink {
  sourceFileName: string;
  targetFileName: string;
  relation: 'supports' | 'contradicts' | 'extends' | 'summarizes' | 'related';
  strength: number; // 0..1
  explanation: string;
  createdAt: number;
}

export interface TopicCluster {
  topic: string;
  articleFileNames: string[];
  summary: string;
  /** Key agreements across articles */
  agreements: string[];
  /** Key disagreements / tensions */
  disagreements: string[];
  generatedAt: number;
}

// ── Content → Quiz ────────────────────────────────────────────────────────

export interface GeneratedQuiz {
  articleFileName: string;
  questions: SelfTestQuestion[];
  /** Knowledge type the quiz targets */
  knowledgeType: KnowledgeType;
  generatedAt: number;
}

// ── Periodic Synthesis ────────────────────────────────────────────────────

export interface PeriodicSynthesis {
  id: string;
  period: 'daily' | 'weekly' | 'monthly';
  periodStart: number;
  periodEnd: number;
  /** Article fileNames covered */
  articles: string[];
  summary: string;
  highlights: string[];
  /** Cross-article connections discovered */
  connections: { from: string; to: string; insight: string }[];
  generatedAt: number;
}
