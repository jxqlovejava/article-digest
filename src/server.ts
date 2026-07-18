import fs from 'fs';
import express from 'express';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { parseTweetUrl } from './utils/url';
import { fetchTweet, fetchWechatArticle, fetchWebPage, fetchBookmarks, fetchLikes } from './services/fetcher';
import { saveTweet, isTweetChanged, togglePin, markRead, markUnread, deleteArticle, getPublicDir, getArticlesDir, getImagesDir, getVideosDir, getAvatarsDir, loadMeta, loadBlockedUrls } from './services/renderer';
import { searchArticles } from './services/search';
import { extractOpinions, extractAllOpinions, getOpinionsByArticle, linkOpinions } from './services/opinions';
import { answerQuestion, answerQuestionStream, generateSuggestedQuestions, getOrGenerateSuggestions, useSuggestion } from './services/synthesize';
import { isLlmEnabled } from './services/llm';

export function createServer(): express.Express {
  const app = express();

  // Behind tweet-nginx: required so express-rate-limit accepts X-Forwarded-For
  // (without this, rateLimit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
  app.set('trust proxy', 1);

  const searchRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many search requests, please slow down' });
    },
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Auto mark as read when accessing article pages
  app.use('/articles', async (req, _res, next) => {
    const match = req.path.match(/^\/([^/]+\.html)$/);
    if (match) {
      try { await markRead(match[1]); } catch {}
    }
    next();
  });

  // Serve static files
  app.use('/articles', express.static(getArticlesDir()));
  app.use('/images', express.static(getImagesDir()));
  app.use('/avatars', express.static(getAvatarsDir()));
  app.use('/videos', express.static(getVideosDir()));
  app.use(express.static(getPublicDir(), { index: false }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.get('/api/search/keywords', (_req, res) => {
    try {
      const { getSearchSuggestions } = require('./services/search');
      const keywords = getSearchSuggestions(5);
      res.json({ success: true, keywords });
    } catch (err) {
      console.error('[search] Keywords error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Keywords failed' });
    }
  });

  // Full-text search (keyword + semantic)
  app.get('/api/search', searchRateLimit, async (req, res) => {
    const q = req.query.q;
    if (typeof q !== 'string' || q.trim().length < 2) {
      res.status(400).json({ error: 'Query too short' });
      return;
    }
    try {
      const { searchArticles, getSnippets } = await import('./services/search');
      const fileNames = await searchArticles(q.trim());
      const snippets = getSnippets(q.trim(), fileNames);
      const metaMap = new Map(loadMeta().map(m => [m.fileName, m]));
      // Keep relevance order from searchArticles — do NOT re-sort by date
      // (date sort buried exact title hits under weakly related recent posts).
      const results = fileNames
        .map(name => {
          const m = metaMap.get(name);
          if (!m) return null;
          return { ...m, snippet: snippets.get(name) || '' };
        })
        .filter((r): r is NonNullable<typeof r> => !!r);
      res.json({ success: true, results });
    } catch (err) {
      console.error('[search] Error:', err);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  function isWechatUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return u.hostname === 'mp.weixin.qq.com' || u.hostname.endsWith('.mp.weixin.qq.com');
    } catch {
      return false;
    }
  }

  // Archive endpoint
  app.post('/api/archive', async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    // WeChat article
    if (isWechatUrl(url)) {
      try {
        console.log(`[archive] Fetching WeChat article: ${url}`);
        const article = await fetchWechatArticle(url);
        const fileName = await saveTweet(article);
        console.log(`[archive] Saved WeChat article to ${fileName}`);
        res.json({
          success: true,
          fileName,
          tweet: {
            id: article.id,
            author: article.author.name,
            text: article.text.substring(0, 100) + (article.text.length > 100 ? '...' : ''),
          },
        });
        return;
      } catch (err) {
        console.error('[archive] WeChat fetch error:', err);
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ error: message });
        return;
      }
    }

    // Tweet
    const parsed = parseTweetUrl(url);
    if (!parsed) {
      // Generic web page (non-Twitter, non-WeChat) → Jina AI
      try {
        console.log(`[archive] Fetching web page: ${url}`);
        const article = await fetchWebPage(url);
        const fileName = await saveTweet(article);
        console.log(`[archive] Saved web page to ${fileName}`);
        res.json({
          success: true,
          fileName,
          tweet: {
            id: article.id,
            author: article.author.name,
            text: article.text.substring(0, 100) + (article.text.length > 100 ? '...' : ''),
          },
        });
        return;
      } catch (err) {
        console.error('[archive] Web page fetch error:', err);
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ error: message });
        return;
      }
    }

    try {
      console.log(`[archive] Fetching tweet: ${parsed.username}/status/${parsed.tweetId}`);
      const tweet = await fetchTweet(parsed);

      if (!isTweetChanged(parsed.tweetId, tweet)) {
        console.log(`[archive] Tweet unchanged, skipping: ${parsed.tweetId}`);
        res.json({ success: true, skipped: true, message: '未更新，已跳过' });
        return;
      }

      const fileName = await saveTweet(tweet);

      console.log(`[archive] Saved to ${fileName}`);
      res.json({
        success: true,
        fileName,
        tweet: {
          id: tweet.id,
          author: tweet.author.name,
          text: tweet.text.substring(0, 100) + (tweet.text.length > 100 ? '...' : ''),
        },
      });
    } catch (err) {
      console.error('[archive] Error:', err);
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Pin / Unpin
  app.post('/api/pin', async (req, res) => {
    const { id, pin } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
    const ok = await togglePin(id, !!pin);
    res.json({ success: ok, pinned: !!pin });
  });

  // Mark as read
  app.post('/api/read', async (req, res) => {
    const { id } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
    const ok = await markRead(id);
    res.json({ success: ok });
  });

  // Mark as unread
  app.post('/api/unread', async (req, res) => {
    const { id } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
    const ok = await markUnread(id);
    res.json({ success: ok });
  });

  // Delete article
  app.post('/api/delete', async (req, res) => {
    const { id } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
    try {
      const ok = await deleteArticle(id);
      res.json({ success: ok });
    } catch (err) {
      console.error('[delete] Error:', err);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // Sync X bookmarks → auto-archive
  app.post('/api/sync-bookmarks', async (_req, res) => {
    try {
      const meta = loadMeta();
      const blockedUrls = loadBlockedUrls();
      const knownUrls = new Set(meta.map(m => m.tweetUrl || ''));
      const [bookmarkUrls, likeUrls] = await Promise.all([
        fetchBookmarks(5),
        fetchLikes(5),
      ]);
      const allUrls = [...new Set([...bookmarkUrls, ...likeUrls])].filter(u => !blockedUrls.has(u));
      let added = 0;
      let skipped = 0;
      for (const url of allUrls) {
        if (knownUrls.has(url)) continue;
        const parsed = parseTweetUrl(url);
        if (!parsed) continue;
        try {
          if (!isTweetChanged(parsed.tweetId, { id: parsed.tweetId, text: '' } as any)) continue;
          const tweet = await fetchTweet(parsed);
          await saveTweet(tweet);
          added++;
          knownUrls.add(url);
        } catch (err) {
          console.error(`[sync-bookmarks] Failed to archive ${url}:`, err instanceof Error ? err.message : err);
        }
      }
      res.json({ success: true, added, totalChecked: allUrls.length, skippedBlocked: skipped });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  // Background: poll X bookmarks every 5 minutes
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let syncing = false;
  async function syncLoop() {
    if (syncing) return;
    syncing = true;
    try {
      const meta = loadMeta();
      const blockedUrls = loadBlockedUrls();
      const knownUrls = new Set(meta.map(m => m.tweetUrl || ''));
      // Merge bookmarks + likes, dedup, skip blocked
      const [bookmarkUrls, likeUrls] = await Promise.all([
        fetchBookmarks(5),
        fetchLikes(5),
      ]);
      const allUrls = [...new Set([...bookmarkUrls, ...likeUrls])].filter(u => !blockedUrls.has(u));
      for (const url of allUrls) {
        if (knownUrls.has(url)) continue;
        const parsed = parseTweetUrl(url);
        if (!parsed) continue;
        try {
          if (!isTweetChanged(parsed.tweetId, { id: parsed.tweetId, text: '' } as any)) continue;
          const tweet = await fetchTweet(parsed);
          await saveTweet(tweet);
          console.log(`[sync] Auto-archived: ${url}`);
          knownUrls.add(url);
        } catch { /* skip failed individual archives */ }
      }
    } catch { /* skip transient errors */ }
    syncing = false;
  }

  syncTimer = setInterval(syncLoop, 5 * 60 * 1000);
  setTimeout(syncLoop, 15000);

  // ---- Opinion extraction ----

  app.post('/api/opinions/extract', async (req, res) => {
    const { fileName } = req.body;
    if (!fileName || typeof fileName !== 'string') {
      res.status(400).json({ error: 'Missing fileName' });
      return;
    }
    try {
      const opinions = await extractOpinions(fileName);
      res.json({ success: true, opinions, count: opinions.length });
    } catch (err) {
      console.error('[opinions] Extract error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Extraction failed' });
    }
  });

  app.post('/api/opinions/extract-all', async (_req, res) => {
    if (!isLlmEnabled()) {
      res.status(400).json({ error: 'LLM not configured. Set LLM_API_KEY.' });
      return;
    }
    try {
      const result = await extractAllOpinions();
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[opinions] Extract-all error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Batch extraction failed' });
    }
  });

  app.get('/api/opinions', (req, res) => {
    const fileName = req.query.fileName;
    if (typeof fileName === 'string') {
      const opinions = getOpinionsByArticle(fileName);
      res.json({ success: true, opinions });
      return;
    }
    // List all
    const { getAllOpinions } = require('./services/opinions');
    const opinions = getAllOpinions();
    res.json({ success: true, opinions });
  });

  app.post('/api/opinions/link', async (_req, res) => {
    if (!isLlmEnabled()) {
      res.status(400).json({ error: 'LLM not configured.' });
      return;
    }
    try {
      const count = await linkOpinions();
      res.json({ success: true, linksCreated: count });
    } catch (err) {
      console.error('[opinions] Link error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Linking failed' });
    }
  });

  // ---- Q&A ----

  app.post('/api/qa', async (req, res) => {
    const { question, contextArticle, history } = req.body;
    if (!question || typeof question !== 'string' || question.trim().length < 2) {
      res.status(400).json({ error: 'Question too short' });
      return;
    }
    if (!isLlmEnabled()) {
      res.status(400).json({ error: 'LLM not configured. Set LLM_API_KEY.' });
      return;
    }
    try {
      const result = await answerQuestion(question.trim(), {
        contextArticle,
        history: Array.isArray(history) ? history : undefined,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[qa] Error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Q&A failed' });
    }
  });

  // ---- Q&A streaming ----

  app.post('/api/qa/stream', async (req, res) => {
    const { question, contextArticle, history } = req.body;
    if (!question || typeof question !== 'string' || question.trim().length < 2) {
      res.status(400).json({ error: 'Question too short' });
      return;
    }
    if (!isLlmEnabled()) {
      res.status(400).json({ error: 'LLM not configured. Set LLM_API_KEY.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Hint reverse proxies not to buffer SSE
      'X-Accel-Buffering': 'no',
    });
    // Disable Nagle-ish buffering on the socket when available
    try {
      (res as { flushHeaders?: () => void }).flushHeaders?.();
    } catch { /* ignore */ }

    try {
      for await (const event of answerQuestionStream(question.trim(), {
        contextArticle,
        history: Array.isArray(history) ? history : undefined,
      })) {
        res.write(
          `event: ${event.type}\ndata: ${JSON.stringify(
            event.type === 'sources'
              ? event.sources
              : event.type === 'delta'
                ? { delta: event.delta }
                : { error: event.error }
          )}\n\n`
        );
      }
    } catch (err) {
      console.error('[qa/stream] Error:', err instanceof Error ? err.message : err);
      res.write(
        `event: error\ndata: ${JSON.stringify({
          error: err instanceof Error ? err.message : 'Q&A failed',
        })}\n\n`
      );
    }
    res.end();
  });

  app.get('/api/qa/suggestions', async (req, res) => {
    try {
      const context = typeof req.query.context === 'string' ? req.query.context : undefined;
      const questions = await getOrGenerateSuggestions(3, context);
      res.json({ success: true, questions });
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate suggestions' });
    }
  });

  app.post('/api/qa/suggestions/use', (req, res) => {
    const { context, count } = req.body || {};
    useSuggestion(typeof context === 'string' ? context || undefined : undefined, Math.max(1, count || 1));
    res.json({ success: true });
  });

  // Serve Q&A page
  // Serve search page
  app.get('/search', (_req, res) => {
    const p = path.join(getPublicDir(), 'search.html');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(fs.readFileSync(p, 'utf-8'));
    } else { res.status(404).send('Search page not ready'); }
  });

  app.get('/qa', (_req, res) => {
    const qaPath = path.join(getPublicDir(), 'qa.html');
    if (fs.existsSync(qaPath)) {
      const html = fs.readFileSync(qaPath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(html);
    } else {
      res.status(404).send('Q&A page not ready');
    }
  });

  // Fallback: serve index.html for root (force no-cache)
  app.get('/', (_req, res) => {
    const indexPath = path.join(getPublicDir(), 'index.html');
    if (fs.existsSync(indexPath)) {
      const html = fs.readFileSync(indexPath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(html);
    } else {
      res.status(404).send('Index not ready');
    }
  });

  return app;
}
