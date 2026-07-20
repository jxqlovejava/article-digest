/**
 * Knowledge Classifier — classifies articles into 4 knowledge types
 * and extracts key points, self-test questions, and topics.
 *
 * Uses LLM via chatWithJson when available; falls back to heuristic
 * keyword matching.
 */

import type { ArticleKnowledge, KnowledgeType, SelfTestQuestion } from '../types/knowledge';
import { KNOWLEDGE_TYPE_LABELS, KNOWLEDGE_TYPE_PROMPT_HINTS } from '../types/knowledge';
import { chatWithJson, isLlmEnabled } from './llm';

/** JSON shape expected from classifyArticle LLM call. */
interface ClassifyOutput {
  knowledgeType: KnowledgeType;
}

/** JSON shape expected from extractKeyPoints LLM call. */
interface KeyPointsOutput {
  keyPoints: string[];
}

/** JSON shape expected from generateSelfTestQuestions LLM call. */
interface SelfTestOutput {
  questions: {
    question: string;
    expectedAnswer: string;
    questionType: 'short' | 'choice';
    options?: string[];
  }[];
}

/** JSON shape expected from extractTopics LLM call. */
interface TopicsOutput {
  topics: string[];
}

const CLASSIFICATION_SYSTEM_PROMPT = `你将收到一篇中文文章，请将其分类为以下4种知识类型之一：

- memory（事实型）：具体的事实、数据、事件记录
- concept（概念型）：抽象概念、理论框架、思想体系
- procedure（程序型）：操作步骤、方法论、流程指南
- design（设计型）：设计思路、架构决策、策略规划

请仅返回 JSON 格式：{"knowledgeType":"memory"}`;

// ── Heuristic Classification ─────────────────────────────────────────────────

/** Keywords suggesting a procedure type. */
const PROCEDURE_KEYWORDS = [
  '步骤', '方法', '流程', '指南', '教程', '如何', 'how to',
  '首先', '然后', '接下来', '第一步', '第二步', '操作',
  '实现', '搭建', '配置', '部署', '安装', '使用',
];

/** Keywords suggesting a concept type. */
const CONCEPT_KEYWORDS = [
  '概念', '理论', '框架', '思想', '体系', '范式', '原理',
  '定义', '本质', '特征', '特性', '属性', '要素',
  '模型', '模式', '结构', '机制',
];

/** Keywords suggesting a design type. */
const DESIGN_KEYWORDS = [
  '设计', '架构', '策略', '规划', '方案', '决策',
  '权衡', '取舍', '评估', '选型', '对比',
  '体系结构', '设计模式', '最佳实践',
];

/** Remove HTML tags for text extraction. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').trim();
}

/** Classify a text using heuristic keyword matching. */
function heuristicClassify(text: string): KnowledgeType {
  const lower = text.toLowerCase();

  // Count keyword matches for each type
  let procedureScore = 0;
  let conceptScore = 0;
  let designScore = 0;

  for (const kw of PROCEDURE_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) procedureScore++;
  }
  for (const kw of CONCEPT_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) conceptScore++;
  }
  for (const kw of DESIGN_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) designScore++;
  }

  // Check for code blocks (strong indicator of procedure)
  if (text.includes('```') || text.includes('<code') || text.includes('code-block')) {
    procedureScore += 3;
  }

  // Check for comparison/decision patterns (design)
  if (/vs\.?|对比|比较|选择|方案/.test(text)) {
    designScore += 2;
  }

  const max = Math.max(procedureScore, conceptScore, designScore);
  if (max <= 0) return 'memory';
  if (procedureScore >= max && procedureScore > 0) return 'procedure';
  if (conceptScore >= max && conceptScore > 0) return 'concept';
  if (designScore >= max && designScore > 0) return 'design';
  return 'memory';
}

// ── Public Functions ─────────────────────────────────────────────────────────

/** Classify an article text into a KnowledgeType. */
async function classifyArticle(articleText: string): Promise<KnowledgeType> {
  if (!isLlmEnabled()) {
    return heuristicClassify(articleText);
  }

  const textSample = articleText.substring(0, 4000);
  try {
    const result = await chatWithJson<ClassifyOutput>([
      { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `请分类以下文章：\n\n${textSample}`,
      },
    ], { temperature: 0.1 });

    const validTypes: KnowledgeType[] = ['memory', 'concept', 'procedure', 'design'];
    if (validTypes.includes(result.knowledgeType)) {
      return result.knowledgeType;
    }
  } catch (err) {
    console.error('[knowledge-classifier] LLM classify failed, falling back to heuristic:',
      err instanceof Error ? err.message : err);
  }

  return heuristicClassify(articleText);
}

/** Extract 3-5 key points from an article. */
async function extractKeyPoints(articleText: string, knowledgeType: KnowledgeType): Promise<string[]> {
  if (!isLlmEnabled()) {
    // Simple heuristic: extract sentences with key markers
    const sentences = articleText.split(/[。！？\n]/).filter(s => s.trim().length > 10);
    const markers = ['是', '就是', '意味着', '关键', '重要', '核心', '本质', '需要', '必须', '因为', '所以', '因此', '但是', '然而'];
    const scored = sentences.map(s => ({
      sentence: s.trim(),
      score: markers.filter(m => s.includes(m)).length,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map(s => s.sentence.substring(0, 100));
  }

  const typeLabel = KNOWLEDGE_TYPE_LABELS[knowledgeType] || knowledgeType;
  const typeHint = KNOWLEDGE_TYPE_PROMPT_HINTS[knowledgeType] || '';

  try {
    const result = await chatWithJson<KeyPointsOutput>([
      {
        role: 'system',
        content: `你是一位知识提炼助手。从文章中提取3-5个关键要点。
文章类型：${typeLabel}（${typeHint}）

返回 JSON 格式：{"keyPoints":["要点1","要点2","要点3"]}`,
      },
      {
        role: 'user',
        content: `请提取以下文章的关键要点：\n\n${articleText.substring(0, 4000)}`,
      },
    ], { temperature: 0.3 });

    return (result.keyPoints || []).slice(0, 5);
  } catch (err) {
    console.error('[knowledge-classifier] LLM keypoints failed:',
      err instanceof Error ? err.message : err);
    return [];
  }
}

/** Generate 1-3 self-test questions for an article. */
async function generateSelfTestQuestions(
  articleText: string,
  knowledgeType: KnowledgeType
): Promise<SelfTestQuestion[]> {
  if (!isLlmEnabled()) {
    // Basic fallback: generate a single recall question
    const typeLabel = KNOWLEDGE_TYPE_LABELS[knowledgeType] || knowledgeType;
    return [{
      id: `q_${Date.now()}`,
      question: `请简述这篇${typeLabel}文章的核心内容。`,
      expectedAnswer: articleText.substring(0, 200),
      questionType: 'short',
    }];
  }

  const typeLabel = KNOWLEDGE_TYPE_LABELS[knowledgeType] || knowledgeType;
  const typeHint = KNOWLEDGE_TYPE_PROMPT_HINTS[knowledgeType] || '';

  try {
    const result = await chatWithJson<SelfTestOutput>([
      {
        role: 'system',
        content: `你是一位测验生成助手。基于文章内容生成1-3道自测题。
文章类型：${typeLabel}（${typeHint}）
题目可以是简答题(short)或选择题(choice)。

返回 JSON 格式：
{
  "questions": [
    {
      "question": "问题内容",
      "expectedAnswer": "标准答案",
      "questionType": "short|choice",
      "options": ["选项A","选项B","选项C","选项D"]
    }
  ]
}

选择题必须提供4个选项，且 expectedAnswer 为正确答案的文字。`,
      },
      {
        role: 'user',
        content: `请基于以下文章生成自测题：\n\n${articleText.substring(0, 4000)}`,
      },
    ], { temperature: 0.3 });

    return (result.questions || []).slice(0, 3).map(q => ({
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      question: q.question,
      expectedAnswer: q.expectedAnswer,
      questionType: q.questionType || 'short',
      options: q.options,
    }));
  } catch (err) {
    console.error('[knowledge-classifier] LLM questions failed:',
      err instanceof Error ? err.message : err);
    return [];
  }
}

/** Extract 3-8 topic tags from an article. */
async function extractTopics(articleText: string): Promise<string[]> {
  if (!isLlmEnabled()) {
    // Simple heuristic: extract noun phrases (non-stop words)
    const text = articleText.substring(0, 2000);
    // Split on common delimiters and take meaningful chunks
    const tokens = text.split(/[\s,，。；;、！？\n#@（）()「」【】《》""'']/).filter(t => t.length >= 2);
    const stopWords = new Set([
      '这个', '那个', '这些', '那些', '什么', '怎么', '如何', '可以',
      '一个', '一种', '不是', '就是', '但是', '而且', '因为', '所以',
      '没有', '如果', '虽然', '还是', '或者', '已经', '可能', '应该',
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
      '都', '一', '上', '也', '很', '到', '说', '要', '去', '你',
      '会', '着', '没有', '看', '好', '自己', '这', '他', '她', '它',
    ]);
    const uniqueTokens = [...new Set(tokens)];
    const meaningful = uniqueTokens.filter(t => !stopWords.has(t) && t.length >= 2 && !/^\d+$/.test(t));
    return meaningful.slice(0, 8);
  }

  try {
    const result = await chatWithJson<TopicsOutput>([
      {
        role: 'system',
        content: `你是一位标签提取助手。从文章中提取3-8个中文主题标签，用于跨文章关联。
标签应简洁、具体，能准确反映文章核心内容。

返回 JSON 格式：{"topics":["标签1","标签2","标签3"]}`,
      },
      {
        role: 'user',
        content: `请提取以下文章的主题标签：\n\n${articleText.substring(0, 4000)}`,
      },
    ], { temperature: 0.3 });

    return (result.topics || []).slice(0, 8);
  } catch (err) {
    console.error('[knowledge-classifier] LLM topics failed:',
      err instanceof Error ? err.message : err);
    return [];
  }
}

/** Full pipeline: read an article HTML file, extract text, classify, annotate. */
async function annotateArticle(fileName: string): Promise<ArticleKnowledge> {
  const fs = await import('fs');
  const path = await import('path');

  const articlesDir = path.resolve(process.cwd(), 'data', 'articles');
  const filePath = path.join(articlesDir, fileName);

  let articleText: string;
  try {
    articleText = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read article file ${fileName}: ${err instanceof Error ? err.message : err}`);
  }

  // Extract readable text from HTML
  const textContent = stripHtml(articleText);

  const [knowledgeType, keyPoints, selfTestQuestions, topics] = await Promise.all([
    classifyArticle(textContent),
    extractKeyPoints(textContent, 'memory'), // placeholder type, will re-call with real type
    generateSelfTestQuestions(textContent, 'memory'),
    extractTopics(textContent),
  ]);

  // Re-extract key points with the actual knowledge type
  const finalKeyPoints = keyPoints.length > 0
    ? keyPoints
    : await extractKeyPoints(textContent, knowledgeType);

  const finalQuestions = selfTestQuestions.length > 0
    ? selfTestQuestions
    : await generateSelfTestQuestions(textContent, knowledgeType);

  return {
    articleFileName: fileName,
    knowledgeType,
    keyPoints: finalKeyPoints,
    selfTestQuestions: finalQuestions,
    topics,
    generatedAt: Date.now(),
  };
}

export {
  classifyArticle,
  extractKeyPoints,
  generateSelfTestQuestions,
  extractTopics,
  annotateArticle,
  heuristicClassify,
};
