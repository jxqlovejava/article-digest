import express from 'express';
import { isLlmEnabled } from './llm';
import { loadMeta } from './renderer';
import type { Surface, L3Slot } from '../types/knowledge';

/**
 * Register all knowledge management API routes on the given Express app.
 *
 * Every handler uses dynamic import() so routes work even before the
 * underlying service files exist. Callers see { success, data } on
 * success or { error } with an appropriate HTTP status code.
 */

export function registerKnowledgeRoutes(app: express.Express): void {
  // ── Classification ──────────────────────────────────────────────────────

  app.get('/api/knowledge/classify', async (req, res) => {
    const fileName = req.query.fileName;
    if (typeof fileName !== 'string' || !fileName) {
      res.status(400).json({ error: 'Missing fileName query parameter' });
      return;
    }
    try {
      const { annotateArticle } = await import('./knowledge-classifier');
      const data = await annotateArticle(fileName);
      res.json({ success: true, data });
    } catch (err) {
      console.error('[knowledge] classify error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Classification failed' });
    }
  });

  app.post('/api/knowledge/classify-all', async (_req, res) => {
    try {
      const { classifyArticle } = await import('./knowledge-classifier');
      const meta = loadMeta();
      let classified = 0;
      for (const m of meta) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const knowledge = await classifyArticle(m.fileName);
          classified++;
        } catch {
          // skip individual failures
        }
      }
      res.json({ success: true, classified, total: meta.length });
    } catch (err) {
      console.error('[knowledge] classify-all error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Batch classification failed' });
    }
  });

  // ── Quiz ────────────────────────────────────────────────────────────────

  app.get('/api/knowledge/quiz', async (req, res) => {
    const fileName = req.query.fileName;
    if (typeof fileName !== 'string' || !fileName) {
      res.status(400).json({ error: 'Missing fileName query parameter' });
      return;
    }
    try {
      const { getQuizForArticle } = await import('./quiz-generator');
      const quiz = await getQuizForArticle(fileName);
      res.json({ success: true, data: quiz });
    } catch (err) {
      console.error('[knowledge] quiz get error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get quiz' });
    }
  });

  app.post('/api/knowledge/quiz/generate', async (req, res) => {
    const { fileName } = req.body || {};
    if (typeof fileName !== 'string' || !fileName) {
      res.status(400).json({ error: 'Missing fileName in request body' });
      return;
    }
    if (!isLlmEnabled()) {
      res.status(400).json({ error: 'LLM not configured. Set LLM_API_KEY.' });
      return;
    }
    try {
      const { generateQuizForArticle } = await import('./quiz-generator');
      const quiz = await generateQuizForArticle(fileName);
      res.json({ success: true, data: quiz });
    } catch (err) {
      console.error('[knowledge] quiz generate error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Quiz generation failed' });
    }
  });

  // ── Spaced Repetition ──────────────────────────────────────────────────

  app.get('/api/knowledge/reviews/due', async (_req, res) => {
    try {
      const { getDueReviews } = await import('./spaced-repetition');
      const reviews = await getDueReviews();
      res.json({ success: true, data: reviews });
    } catch (err) {
      console.error('[knowledge] reviews due error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get due reviews' });
    }
  });

  app.post('/api/knowledge/reviews/grade', async (req, res) => {
    const { questionId, answer } = req.body || {};
    if (typeof questionId !== 'string' || !questionId || typeof answer !== 'string') {
      res.status(400).json({ error: 'Missing questionId or answer in request body' });
      return;
    }
    try {
      const { recordAttempt } = await import('./spaced-repetition');
      const attempt = {
        questionId,
        articleFileName: '',
        isCorrect: false, // determined by recordAttempt
        userAnswer: answer,
        selfAttribution: '',
        timestamp: Date.now(),
      };
      const result = await recordAttempt(attempt);
      res.json({ success: true, data: result });
    } catch (err) {
      console.error('[knowledge] review grade error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to record review' });
    }
  });

  app.get('/api/knowledge/reviews/stats', async (_req, res) => {
    try {
      const { getReviewStats } = await import('./spaced-repetition');
      const stats = await getReviewStats();
      res.json({ success: true, data: stats });
    } catch (err) {
      console.error('[knowledge] reviews stats error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get review stats' });
    }
  });

  // ── Cross-Article Links ────────────────────────────────────────────────

  app.get('/api/knowledge/links', async (req, res) => {
    const fileName = req.query.fileName;
    if (typeof fileName !== 'string' || !fileName) {
      res.status(400).json({ error: 'Missing fileName query parameter' });
      return;
    }
    try {
      const { getLinksForArticle } = await import('./synthesis');
      const links = await getLinksForArticle(fileName);
      res.json({ success: true, data: links });
    } catch (err) {
      console.error('[knowledge] links error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get links' });
    }
  });

  app.post('/api/knowledge/links/discover', async (req, res) => {
    const { fileName } = req.body || {};
    try {
      const { discoverLinks } = await import('./synthesis');
      if (typeof fileName === 'string' && fileName) {
        const links = await discoverLinks(fileName);
        res.json({ success: true, data: links });
      } else {
        const { discoverAllLinks } = await import('./synthesis');
        const links = await discoverAllLinks();
        res.json({ success: true, data: links });
      }
    } catch (err) {
      console.error('[knowledge] link discover error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Link discovery failed' });
    }
  });

  // ── Topic Clusters ──────────────────────────────────────────────────────

  app.get('/api/knowledge/clusters', async (_req, res) => {
    try {
      const { getClusters } = await import('./topic-cluster');
      const clusters = await getClusters();
      // Enrich with article titles from meta
      const metaMap = new Map(loadMeta().map(m => [m.fileName, m.title || m.fileName]));
      const enriched = clusters.map(c => ({
        ...c,
        articleTitles: (c.articleFileNames || []).map(fn => metaMap.get(fn) || fn),
      }));
      res.json({ success: true, data: enriched });
    } catch (err) {
      console.error('[knowledge] clusters error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get clusters' });
    }
  });

  app.post('/api/knowledge/clusters/rebuild', async (_req, res) => {
    if (!isLlmEnabled()) {
      res.status(400).json({ error: 'LLM not configured. Set LLM_API_KEY.' });
      return;
    }
    try {
      const { buildTopicClusters } = await import('./topic-cluster');
      const clusters = await buildTopicClusters();
      res.json({ success: true, data: clusters });
    } catch (err) {
      console.error('[knowledge] cluster rebuild error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Cluster rebuild failed' });
    }
  });

  // ── Periodic Synthesis ─────────────────────────────────────────────────

  app.get('/api/knowledge/synthesis/latest', async (_req, res) => {
    try {
      const { getAllSyntheses } = await import('./periodic-synthesis');
      const syntheses = await getAllSyntheses();
      res.json({ success: true, data: syntheses });
    } catch (err) {
      console.error('[knowledge] synthesis latest error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get syntheses' });
    }
  });

  app.post('/api/knowledge/synthesis/generate', async (req, res) => {
    const { period } = req.body || {};
    if (typeof period !== 'string' || !['daily', 'weekly', 'monthly'].includes(period)) {
      res.status(400).json({ error: 'Invalid or missing period. Use daily, weekly, or monthly.' });
      return;
    }
    if (!isLlmEnabled()) {
      res.status(400).json({ error: 'LLM not configured. Set LLM_API_KEY.' });
      return;
    }
    try {
      const { generateDailySynthesis } = await import('./periodic-synthesis');
      const synthesis = await generateDailySynthesis(period);
      res.json({ success: true, data: synthesis });
    } catch (err) {
      console.error('[knowledge] synthesis generate error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Synthesis generation failed' });
    }
  });

  // ── Three-Layer Memory ─────────────────────────────────────────────────

  app.get('/api/knowledge/memory/overview', async (_req, res) => {
    try {
      const { overview } = await import('./memory/store');
      const ov = await overview();
      res.json({ success: true, data: ov });
    } catch (err) {
      console.error('[knowledge] memory overview error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get memory overview' });
    }
  });

  app.get('/api/knowledge/memory/L2', async (req, res) => {
    const surface = req.query.surface;
    if (typeof surface !== 'string' || !surface) {
      res.status(400).json({ error: 'Missing surface query parameter' });
      return;
    }
    try {
      const { readL2Doc } = await import('./memory/store');
      const doc = await readL2Doc(surface as Surface);
      res.json({ success: true, data: doc });
    } catch (err) {
      console.error('[knowledge] L2 read error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read L2 doc' });
    }
  });

  app.post('/api/knowledge/memory/consolidate', async (req, res) => {
    const { surface } = req.body || {};
    if (typeof surface !== 'string' || !surface) {
      res.status(400).json({ error: 'Missing surface in request body' });
      return;
    }
    try {
      const { consolidateL2 } = await import('./memory/consolidator');
      const doc = await consolidateL2(surface as Surface);
      res.json({ success: true, data: doc });
    } catch (err) {
      console.error('[knowledge] consolidate error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Consolidation failed' });
    }
  });

  app.get('/api/knowledge/memory/L3', async (req, res) => {
    const slot = req.query.slot;
    if (typeof slot !== 'string' || !slot) {
      res.status(400).json({ error: 'Missing slot query parameter' });
      return;
    }
    try {
      const { readL3Doc } = await import('./memory/store');
      const doc = await readL3Doc(slot as L3Slot);
      res.json({ success: true, data: doc });
    } catch (err) {
      console.error('[knowledge] L3 read error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read L3 doc' });
    }
  });
}
