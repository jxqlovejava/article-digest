import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Use a temp DB so tests never touch production data.
 * Set env var before requiring the module.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaced-rep-test-'));
process.env.KNOWLEDGE_DB_PATH = path.join(tmpDir, 'knowledge.db');

import {
  gradeAnswer,
  classifyError,
  computeNextState,
  getDueReviews,
  getOverdueCount,
  getReviewStats,
  initializeReviews,
  recordAttempt,
  deleteArticleReviews,
} from './spaced-repetition';

import type { RepetitionState, QuizAttempt, KnowledgeType } from '../types/knowledge';

// Helper to create a base state
function makeState(overrides: Partial<RepetitionState> = {}): RepetitionState {
  return {
    intervalIndex: 0,
    consecutiveCorrect: 0,
    consecutiveWrong: 0,
    nextReviewAt: Date.now() + 86400000,
    knowledgeType: 'memory' as KnowledgeType,
    ...overrides,
  };
}

after(() => {
  // Cleanup temp DB
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

// ── SM-2 Interval Progression ────────────────────────────────────────────────

describe('SM-2 interval progression (computeNextState)', () => {
  it('correct answer increases interval index from 0 to 1 (1 day)', () => {
    const state = makeState({ intervalIndex: 0, nextReviewAt: Date.now() });
    const { state: next } = computeNextState(state, true, 2.5);

    assert.strictEqual(next.intervalIndex, 1);
    assert.strictEqual(next.consecutiveCorrect, 1);
    assert.strictEqual(next.consecutiveWrong, 0);
    // Should schedule ~1 day from now
    assert.ok(next.nextReviewAt > Date.now() + 80000000);
  });

  it('correct answer increases interval across multiple steps', () => {
    let state = makeState({ intervalIndex: 0, nextReviewAt: Date.now() });
    let ef = 2.5;

    // First correct → interval 1
    ({ state, ef } = computeNextState(state, true, ef));
    assert.strictEqual(state.intervalIndex, 1);

    // Second correct → interval 2 (3 days)
    ({ state, ef } = computeNextState(state, true, ef));
    assert.strictEqual(state.intervalIndex, 2);

    // Third correct → interval 3 (7 days)
    ({ state, ef } = computeNextState(state, true, ef));
    assert.strictEqual(state.intervalIndex, 3);
  });

  it('wrong answer resets interval to 0 (1 day) and decreases ef', () => {
    const state = makeState({ intervalIndex: 3, nextReviewAt: Date.now() });
    const { state: next, ef } = computeNextState(state, false, 2.5);

    assert.strictEqual(next.intervalIndex, 0);  // Reset
    assert.strictEqual(next.consecutiveCorrect, 0);
    assert.strictEqual(next.consecutiveWrong, 1);
    assert.strictEqual(next.nextReviewAt < Date.now() + 90000000, true);  // ~1 day
    // EF should decrease by 0.2
    assert.ok(ef < 2.5);
  });

  it('consecutive wrong answers accumulate consecutiveWrong', () => {
    let state = makeState({ intervalIndex: 2 });
    let ef = 2.5;

    ({ state, ef } = computeNextState(state, false, ef));
    assert.strictEqual(state.consecutiveWrong, 1);

    ({ state, ef } = computeNextState(state, false, ef));
    assert.strictEqual(state.consecutiveWrong, 2);
  });

  it('easiness factor never goes below MIN_EASINESS_FACTOR (1.3)', () => {
    let state = makeState({ intervalIndex: 0 });
    let ef = 1.5;

    // Multiple wrong answers should keep ef >= 1.3
    for (let i = 0; i < 5; i++) {
      ({ state, ef } = computeNextState(state, false, ef));
    }
    assert.ok(ef >= 1.3);
  });

  it('correct answer on a reset state progresses normally', () => {
    const state = makeState({
      intervalIndex: 0,
      consecutiveWrong: 2,
      consecutiveCorrect: 0,
      nextReviewAt: Date.now(),
    });
    const { state: next } = computeNextState(state, true, 2.5);

    assert.strictEqual(next.intervalIndex, 1);  // Progresses from 0 → 1
    assert.strictEqual(next.consecutiveCorrect, 1);
    assert.strictEqual(next.consecutiveWrong, 0);  // Wrong counter reset
  });

  it('correct answer increases ef by 0.1', () => {
    const state = makeState({ intervalIndex: 0 });
    const { ef } = computeNextState(state, true, 2.5);

    assert.strictEqual(ef, 2.6);
  });

  it('wrong answer decreases ef by 0.2', () => {
    const state = makeState({ intervalIndex: 1 });
    const { ef } = computeNextState(state, false, 2.5);

    assert.strictEqual(ef, 2.3);
  });
});

// ── gradeAnswer ──────────────────────────────────────────────────────────────

describe('gradeAnswer', () => {
  describe('short answer', () => {
    it('returns false for empty answer', () => {
      assert.strictEqual(gradeAnswer('', 'expected answer', 'short'), false);
    });

    it('returns false for whitespace-only answer', () => {
      assert.strictEqual(gradeAnswer('   ', 'expected answer', 'short'), false);
    });

    it('returns true when answer contains key terms from expected', () => {
      const result = gradeAnswer(
        'SM-2算法使用间隔重复来优化记忆',
        'SM-2算法使用间隔重复和遗忘曲线来优化长期记忆',
        'short'
      );
      assert.strictEqual(result, true);
    });

    it('returns false when answer lacks enough key terms', () => {
      const result = gradeAnswer(
        '今天天气很好',
        'SM-2算法使用间隔重复和遗忘曲线来优化长期记忆',
        'short'
      );
      assert.strictEqual(result, false);
    });

    it('returns true for exact match', () => {
      const result = gradeAnswer('spaced repetition', 'spaced repetition', 'short');
      assert.strictEqual(result, true);
    });

    it('is case insensitive', () => {
      const result = gradeAnswer('SM-2 Interval', 'sm-2 interval', 'short');
      assert.strictEqual(result, true);
    });

    it('returns true for partial match with enough overlap', () => {
      const result = gradeAnswer(
        '使用间隔重复',
        '间隔重复是一种记忆技术',
        'short'
      );
      assert.strictEqual(result, true);
    });
  });

  describe('choice type', () => {
    it('returns true for exact match', () => {
      assert.strictEqual(gradeAnswer('B', 'B', 'choice'), true);
    });

    it('returns false for wrong choice', () => {
      assert.strictEqual(gradeAnswer('A', 'B', 'choice'), false);
    });

    it('returns false for empty choice', () => {
      assert.strictEqual(gradeAnswer('', 'B', 'choice'), false);
    });
  });
});

// ── classifyError ────────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('classifies empty answer as structural', () => {
    assert.strictEqual(classifyError(''), 'structural');
  });

  it('classifies whitespace answer as structural', () => {
    assert.strictEqual(classifyError('   '), 'structural');
  });

  it('classifies partially correct answer as deviation', () => {
    const result = classifyError('SM-2', 'SM-2算法使用间隔重复和遗忘曲线来优化长期记忆');
    assert.strictEqual(result, 'deviation');
  });

  it('classifies answer with meta-cognitive indicators', () => {
    const result = classifyError('我知道这个，但忘了具体内容');
    assert.strictEqual(result, 'metacognitive');
  });

  it('classifies answer with "I knew" as metacognitive', () => {
    const result = classifyError('I knew that but forgot the details');
    assert.strictEqual(result, 'metacognitive');
  });

  it('defaults to deviation for general wrong answers', () => {
    const result = classifyError('完全错误的回答', '正确的预期答案');
    assert.strictEqual(result, 'deviation');
  });

  it('classifies answers with most terms but missing details as application', () => {
    const result = classifyError(
      'SM-2算法使用间隔重复来优化长期记忆',
      'SM-2算法使用间隔重复和遗忘曲线来优化长期记忆'
    );
    assert.strictEqual(result, 'application');
  });
});
