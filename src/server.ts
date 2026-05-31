import express from 'express';
import path from 'path';
import { parseTweetUrl } from './utils/url';
import { fetchTweet } from './services/fetcher';
import { saveTweet, isTweetChanged, togglePin, markRead, markUnread, deleteArticle, getPublicDir, getArticlesDir, getImagesDir, getVideosDir, rebuildIndex } from './services/renderer';

export function createServer(): express.Express {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Generate default index.html on startup if missing
  rebuildIndex().catch(err => console.error('[init] Failed to build index:', err));

  // Auto mark as read when accessing article pages
  app.use('/articles', (req, _res, next) => {
    const match = req.path.match(/^\/([^/]+\.html)$/);
    if (match) {
      try { markRead(match[1]); } catch {}
    }
    next();
  });

  // Serve static files
  app.use('/articles', express.static(getArticlesDir()));
  app.use('/images', express.static(getImagesDir()));
  app.use('/videos', express.static(getVideosDir()));
  app.use(express.static(getPublicDir()));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Archive endpoint
  app.post('/api/archive', async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    const parsed = parseTweetUrl(url);
    if (!parsed) {
      res.status(400).json({ error: 'Invalid tweet URL' });
      return;
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
  app.post('/api/pin', (req, res) => {
    const { id, pin } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
    const ok = togglePin(id, !!pin);
    res.json({ success: ok, pinned: !!pin });
  });

  // Mark as read
  app.post('/api/read', (req, res) => {
    const { id } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
    const ok = markRead(id);
    res.json({ success: ok });
  });

  // Mark as unread
  app.post('/api/unread', (req, res) => {
    const { id } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
    const ok = markUnread(id);
    res.json({ success: ok });
  });

  // Delete article
  app.post('/api/delete', (req, res) => {
    const { id } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }
    try {
      const ok = deleteArticle(id);
      res.json({ success: ok });
    } catch (err) {
      console.error('[delete] Error:', err);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // Fallback: serve index.html for root
  app.get('/', (_req, res) => {
    const indexPath = path.join(getPublicDir(), 'index.html');
    res.sendFile(indexPath);
  });

  return app;
}
