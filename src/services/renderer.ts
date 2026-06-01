import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';
import type { FetchedTweet, TweetPhoto } from './fetcher';

// ---- Marked setup ----
const markedRenderer = new Renderer();
markedRenderer.code = function (token: { text: string; lang?: string; escaped?: boolean }): string {
  const { text, lang } = token;
  if (lang && hljs.getLanguage(lang)) {
    try {
      const highlighted = hljs.highlight(text, { language: lang }).value;
      return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>\n`;
    } catch { /* fall through to auto-detect */ }
  }
  try {
    const highlighted = hljs.highlightAuto(text).value;
    return `<pre><code class="hljs">${highlighted}</code></pre>\n`;
  } catch { /* fall through to escaped text */ }
  return `<pre><code>${text}</code></pre>\n`;
};

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer: markedRenderer,
});

const IMAGE_PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';

function getDownloadAgent() {
  try {
    return new HttpsProxyAgent(IMAGE_PROXY_URL);
  } catch {
    return undefined;
  }
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

// X-style SVG icons (18px, currentColor, stroke-based)
const ICONS = {
  comment: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  repost: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>',
  like: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
};

function ensureDirs() {
  [DATA_DIR, ARTICLES_DIR, IMAGES_DIR, VIDEOS_DIR, PUBLIC_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  // Copy highlight.js CSS to public/ if not already present
  const hlCssDest = path.join(PUBLIC_DIR, 'highlight.css');
  if (!fs.existsSync(hlCssDest)) {
    const hlCssSrc = path.resolve(process.cwd(), 'node_modules/highlight.js/styles/github.css');
    if (fs.existsSync(hlCssSrc)) {
      fs.copyFileSync(hlCssSrc, hlCssDest);
    }
  }
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[^\w一-龥\-]/g, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 80);
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function convertMarkdownToHtml(text: string): string {
  // Preprocess @mentions and #hashtags into markdown links before marked parsing.
  // Only match when not already inside a markdown link (preceded by '[' or '(').
  let processed = text.replace(/(?<![\w([])@(\w{1,15})\b/g, '[@$1](https://twitter.com/$1)');
  processed = processed.replace(/(?<![\w([])#(\w{1,100})\b/g, '[#$1](https://twitter.com/hashtag/$1)');
  return marked.parse(processed) as string;
}

function renderTweetHtml(tweet: FetchedTweet, localImagePaths: string[], allImageUrls: string[], allVideoUrls: string[], localVideoPaths: string[]): string {
  const dateStr = formatDate(tweet.created_timestamp);
  const title = tweet.title || tweet.text.split('\n')[0].substring(0, 80);

  // X-style SVG icons (defined locally, used in stats-bar below)

  // Step 1: replace [IMG:N] and [VIDEO:N] with safe markers
  const imgMap: string[] = [];
  let text = tweet.text.replace(/\[IMG:(\d+)\]/g, (_, idx) => {
    const i = parseInt(idx, 10);
    const src = localImagePaths[i] || allImageUrls[i] || '';
    if (src) {
      imgMap.push(src);
      return `<!--IMG:${imgMap.length - 1}-->`;
    }
    return '';
  });

  // Replace [VIDEO:N] markers with video HTML
  text = text.replace(/\[VIDEO:(\d+)\]/g, (_, idx) => {
    const i = parseInt(idx, 10);
    const src = localVideoPaths[i] || allVideoUrls[i] || '';
    if (src) {
      return `<video src="${src}" controls preload="metadata" class="tweet-inline-video"></video>`;
    }
    return '';
  });

  // Extract first image as header image (before title)
  const authorAvatar = tweet.author.avatar_url;
  function isAvatarUrl(url: string): boolean {
    // Direct match against author's known avatar
    if (url === authorAvatar) return true;
    // Known avatar hosting patterns
    if (url.includes('unavatar.io') ||
      url.includes('profile_images') ||
      /pbs\.twimg\.com\/profile_images\//.test(url)) return true;
    // Twitter avatar size suffixes in filename
    if (/_(normal|mini|bigger|x96|400x400|200x200)(\.[a-z]+)?(?:\?|$)/i.test(url)) return true;
    // Same base path as author avatar (different size variant)
    try {
      const cand = new URL(url);
      const auth = new URL(authorAvatar);
      if (cand.hostname === auth.hostname &&
          cand.pathname.replace(/_[^_/.]+(\.[a-z]+)?$/, '$1') === auth.pathname.replace(/_[^_/.]+(\.[a-z]+)?$/, '$1')) {
        return true;
      }
    } catch {}
    // Local file: check if it's a tiny image (likely an avatar)
    if (url.startsWith('../images/')) {
      try {
        const fPath = path.join(IMAGES_DIR, path.basename(url));
        const stat = fs.statSync(fPath);
        if (stat.size < 10000) return true; // < 10KB = likely avatar
      } catch {}
    }
    return false;
  }
  // Extract the first non-avatar image as header image
  let headerImgHtml = '';
  let headerImgMatch = text.match(/^<!--IMG:(\d+)-->/);
  while (headerImgMatch) {
    const idx = parseInt(headerImgMatch[1], 10);
    const src = imgMap[idx];
    if (src && !isAvatarUrl(src)) {
      headerImgHtml = `<img src="${src}" alt="头图" class="header-img" />`;
      text = text.replace(/^<!--IMG:\d+-->\s*/, '');
      break; // Found a valid header image
    }
    // This image is an avatar — remove it from text and imgMap, try next
    text = text.replace(/^<!--IMG:\d+-->\s*/, '');
    headerImgMatch = text.match(/^<!--IMG:(\d+)-->/);
  }

  // Step 2: convert markdown to HTML via marked
  let contentHtml = convertMarkdownToHtml(text);

  // Step 3: replace image markers with real <img> tags
  contentHtml = contentHtml.replace(/<!--IMG:(\d+)-->/g, (_, idx) => {
    const src = imgMap[parseInt(idx, 10)];
    return src ? `<img src="${src}" alt="推文图片" loading="lazy" class="tweet-inline-img" />` : '';
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="stylesheet" href="/highlight.css">
  <style>
    :root {
      --bg: #f5f5f5; --surface: #fff; --text: #1a1a1a;
      --text-secondary: #888; --text-tertiary: #aaa;
      --accent: #576b95; --accent-bg: #eef2ff;
      --border: #eee; --shadow-sm: rgba(0,0,0,0.05); --shadow-md: rgba(0,0,0,0.1);
    }
    [data-theme="dark"] {
      --bg: #0f0f0f; --surface: #1a1a1a; --text: #e0e0e0;
      --text-secondary: #999; --text-tertiary: #666;
      --accent: #7d93ad; --accent-bg: #1c2738;
      --border: #2a2a2a; --shadow-sm: rgba(0,0,0,0.3); --shadow-md: rgba(0,0,0,0.4);
    }
    [data-theme="dark"] .sort-btn.active {
      background: var(--accent-bg); color: var(--accent); border-color: var(--accent);
    }
    @keyframes skeleton-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.7; } }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.75;
      -webkit-font-smoothing: antialiased; transition: background 0.3s ease, color 0.3s ease;
    }
    .container { max-width: 740px; margin: 0 auto; padding: 20px 16px 40px; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .theme-btn, .refresh-btn {
      width: 32px; height: 32px; border: none; border-radius: 50%;
      background: transparent; color: var(--text-secondary); cursor: pointer;
      display: flex; align-items: center; justify-content: center; transition: all 0.2s;
    }
    .theme-btn:hover, .refresh-btn:hover { color: var(--text); }
    .article-card { background: var(--surface); border-radius: 8px; padding: 32px 24px; box-shadow: 0 1px 3px var(--shadow-sm); }
    .article-header { margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
    .article-title { font-size: 24px; font-weight: 700; line-height: 1.4; color: var(--text); margin-bottom: 16px; word-break: break-word; }
    .article-meta { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text-secondary); }
    .article-meta .avatar { background: var(--border); width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
    .article-meta .author-info { display: flex; flex-direction: column; }
    .article-meta .author-name { font-weight: 400; color: var(--text); font-size: 15px; }
    .article-meta .author-handle { color: var(--text-tertiary); font-size: 13px; }
    .article-meta .divider { color: #ddd; }
    .article-meta .date { color: var(--text-tertiary); font-size: 13px; }
    .article-content { font-size: 16px; line-height: 1.75; color: var(--text); word-break: break-word; overflow-wrap: break-word; }
    .article-content p { margin-bottom: 16px; }
    .article-content a { color: var(--accent); text-decoration: none; }
    .article-content a:hover { text-decoration: underline; }
    .article-content strong { font-weight: 700; color: var(--text); }
    .header-img { display: block; width: calc(100% + 48px); height: auto; margin: -32px -24px 16px -24px; border-radius: 8px 8px 0 0; }
    .tweet-inline-img { display: block; width: 100%; height: auto; border-radius: 4px; margin: 16px 0; }
    .tweet-inline-video { display: block; width: 100%; max-height: 480px; border-radius: 4px; margin: 16px 0; background: #000; }
    .article-footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .source-link { font-size: 14px; color: var(--accent); text-decoration: none; }
    .source-link:hover { text-decoration: underline; }
    .back-link { display: inline-flex; color: var(--accent); align-items: center; margin-bottom: 16px; color: #576b95; text-decoration: none; padding: 8px 0; }
    .back-link:hover { text-decoration: underline; }
    .article-header .stats-bar { display: flex; gap: 16px; font-size: 13px; color: var(--text-secondary); margin-top: 8px; }
    .stats-bar .stat { display: inline-flex; align-items: center; gap: 3px; } display: flex; align-items: center; gap: 4px; }

    /* ---- GFM: Headings ---- */
    .article-content h1, .article-content h2, .article-content h3,
    .article-content h4, .article-content h5, .article-content h6 {
      margin: 24px 0 16px; font-weight: 400; line-height: 1.3; color: #1a1a1a;
    }
    .article-content h1 { font-size: 1.75em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
    .article-content h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
    .article-content h3 { font-size: 1.25em; }
    .article-content h4 { font-size: 1.1em; }

    /* ---- GFM: Lists ---- */
    .article-content ul, .article-content ol { padding-left: 2em; margin-bottom: 16px; }
    .article-content li { margin-bottom: 4px; }
    .article-content li > ul, .article-content li > ol { margin-bottom: 0; margin-top: 4px; }
    .article-content ul { list-style-type: disc; }
    .article-content ul ul { list-style-type: circle; }
    .article-content ul ul ul { list-style-type: square; }

    /* ---- GFM: Task lists ---- */
    .article-content input[type="checkbox"] { margin-right: 8px; accent-color: #576b95; }

    /* ---- GFM: Code ---- */
    .article-content code {
      font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
      background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em;
      color: #d63384;
    }
    .article-content pre {
      background: #f6f8fa; border-radius: 6px; padding: 16px;
      overflow-x: auto; margin-bottom: 16px; line-height: 1.45;
    }
    .article-content pre code {
      background: none; padding: 0; border-radius: 0; color: inherit; font-size: 0.875em;
    }

    /* ---- GFM: Blockquotes ---- */
    .article-content blockquote {
      margin: 0 0 16px; padding: 0 16px; color: #57606a;
      border-left: 4px solid var(--border);
    }
    .article-content blockquote p:last-child { margin-bottom: 0; }

    /* ---- GFM: Tables ---- */
    .article-content table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    .article-content th, .article-content td {
      border: 1px solid var(--border); padding: 8px 12px; text-align: left;
    }
    .article-content th { background: var(--border); font-weight: 400; }
    .article-content tr:nth-child(even) { background: var(--border); }

    /* ---- GFM: Horizontal rule ---- */
    .article-content hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }

    @media (max-width: 480px) {
      .article-card { padding: 24px 16px; }
      .header-img { width: calc(100% + 32px); margin: -24px -16px 12px -16px; }
      .article-title { font-size: 20px; }
      .article-content { font-size: 15px; }
      .article-content pre { padding: 12px; font-size: 0.825em; }
    }
  </style>
</head>
<body>
<div class="container">
    <div class="top-bar">
    <a href="/" class="back-link" style="margin-bottom:0" title="返回列表"><svg width="20" height="16" viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8H2"/><path d="M8 2l-6 6 6 6"/></svg></a>
    <button class="theme-btn" onclick="toggleTheme()" title="切换主题">
      <svg id="theme-icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
      <svg id="theme-icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
    </button>
  </div>
    <article class="article-card">
      ${headerImgHtml}

      <header class="article-header">
        <h1 class="article-title">${escapeHtml(title)}</h1>
        <div class="article-meta">
          <img src="${escapeHtml(tweet.author.avatar_url)}" alt="" class="avatar" loading="lazy" />
          <div class="author-info">
            <span class="author-name">${escapeHtml(tweet.author.name)}</span>
            <span class="author-handle">@${escapeHtml(tweet.author.screen_name)}</span>
          </div>
          <span class="divider">|</span>
          <span class="date">${dateStr}</span>
        </div>
        <div class="stats-bar">
          <span class="stat">${ICONS.comment}<span>${tweet.replies.toLocaleString()}</span></span>
          <span class="stat">${ICONS.repost}<span>${tweet.retweets.toLocaleString()}</span></span>
          <span class="stat">${ICONS.like}<span>${tweet.likes.toLocaleString()}</span></span>
        </div>
      </header>
      <div class="article-content">${contentHtml}</div>
      <div class="article-footer">
        <a href="${escapeHtml(tweet.url)}" class="source-link" target="_blank" rel="noopener">查看原文 →</a>
      </div>
    </article>
<script>
(function(){
  var t=localStorage.getItem('theme');
  if(t) document.documentElement.setAttribute('data-theme',t);
  else if(window.matchMedia('(prefers-color-scheme:dark)').matches) document.documentElement.setAttribute('data-theme','dark');
  updateThemeIcon();
})();
function toggleTheme() {
  var c = document.documentElement.getAttribute('data-theme');
  var n = c === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', n);
  localStorage.setItem('theme', n);
  updateThemeIcon();
}
function updateThemeIcon() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var s = document.getElementById('theme-icon-sun');
  var m = document.getElementById('theme-icon-moon');
  if (s) s.style.display = isDark ? 'none' : '';
  if (m) m.style.display = isDark ? '' : 'none';
}
</script>
</body>
</html>`;
}

// ---- Meta & Index ----

interface ArticleMeta {
  fileName: string;
  title: string;
  author: string;
  authorHandle: string;
  authorAvatar: string;
  tweetUrl: string;
  tweetDate: string;
  savedDate: string;
  tweetTimestamp: number;
  savedTimestamp: number;
  contentKey: string;
  pinned?: boolean;
  pinnedAt?: number;
  unread?: boolean;
  hashtags?: string[];
  likes?: number;
  retweets?: number;
  replies?: number;
}

const META_FILE = path.join(DATA_DIR, 'meta.json');

function loadMeta(): ArticleMeta[] {
  if (!fs.existsSync(META_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); }
  catch { return []; }
}

function saveMeta(meta: ArticleMeta[]) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

export function togglePin(fileName: string, pin: boolean) {
  const meta = loadMeta();
  const idx = meta.findIndex(m => m.fileName === fileName);
  if (idx >= 0) {
    meta[idx].pinned = pin;
    meta[idx].pinnedAt = pin ? Date.now() : 0;
    saveMeta(meta);
    rebuildIndex();
    return true;
  }
  return false;
}

export function markRead(fileName: string) {
  const meta = loadMeta();
  const idx = meta.findIndex(m => m.fileName === fileName);
  if (idx >= 0 && meta[idx].unread) {
    meta[idx].unread = false;
    saveMeta(meta);
    rebuildIndex();
    return true;
  }
  return false;
}

export function markUnread(fileName: string) {
  const meta = loadMeta();
  const idx = meta.findIndex(m => m.fileName === fileName);
  if (idx >= 0) {
    meta[idx].unread = true;
    saveMeta(meta);
    rebuildIndex();
    return true;
  }
  return false;
}

export function deleteArticle(fileName: string): boolean {
  const htmlPath = path.join(ARTICLES_DIR, fileName);
  if (fs.existsSync(htmlPath)) {
    // Also delete associated images
    const base = fileName.replace('.html', '');
    const images = fs.readdirSync(IMAGES_DIR).filter(f => f.startsWith(base));
    images.forEach(f => {
      fs.unlinkSync(path.join(IMAGES_DIR, f));
    });
    fs.unlinkSync(htmlPath);
    // Remove from meta
    const meta = loadMeta().filter(m => m.fileName !== fileName);
    saveMeta(meta);
    rebuildIndex();
    return true;
  }
  return false;
}

function renderIndexHtml(
  articlesBySaved: ArticleMeta[],
  articlesByTweet: ArticleMeta[]
): string {
  const hashtagHtml = (tags: string[] | undefined) =>
    (tags && tags.length > 0)
      ? '<div class="article-tags">' + tags.slice(0, 5).map(t => '<span class="tag">#' + escapeHtml(t) + '</span>').join('') + '</div>'
      : '';

  const buildList = (articles: ArticleMeta[]) =>
    articles.map((a) => {
      const displayTitle = a.title.length > 80 ? a.title.substring(0, 80) + '...' : a.title;
      const pinnedBadge = a.pinned ? '<span class="pinned-badge">置顶</span>' : '';
      const unreadDot = a.unread ? '<span class="unread-dot"></span>' : '';
      const tagsHtml = hashtagHtml(a.hashtags);
      const id = a.fileName.replace(/\.html$/, '');
      return `
          <li class="article-item${a.pinned ? ' pinned' : ''}" id="item-${escapeHtml(id)}">
            <div class="swipe-wrap">
              <div class="item-row swipe-content">
                <a href="articles/${a.fileName}" class="article-link" onclick="markRead('${escapeHtml(id)}')">
                  <div class="article-title-wrap">
                    ${escapeHtml(displayTitle)}
                    ${pinnedBadge}
                  </div>
                  <div class="article-meta">
                    <img src="${escapeHtml(a.authorAvatar || 'https://unavatar.io/x/' + a.authorHandle)}" alt="" class="meta-avatar" loading="lazy" />
                    <span class="meta-author">${escapeHtml(a.author)}</span>
                    <span class="meta-time">收藏于 ${a.savedDate.substring(5)} · 更新于 ${a.tweetDate.substring(5)}</span>
                  </div>
                  <div class="article-stats">
                    <span class="stat">${ICONS.comment}<span>${(a.replies||0)}</span></span>
                    <span class="stat">${ICONS.repost}<span>${(a.retweets||0)}</span></span>
                    <span class="stat">${ICONS.like}<span>${(a.likes||0)}</span></span>
                  </div>
                  ${tagsHtml}
                </a>
                <div class="item-actions">
                  ${unreadDot}
                  <div class="more-wrap">
                    <button class="more-btn" onclick="toggleMenu(event, '${escapeHtml(id)}')" title="更多操作">⋯</button>
                    <div class="dropdown-menu" id="menu-${escapeHtml(id)}">
                      <div class="dropdown-item" onclick="pinItem('${escapeHtml(id)}', ${a.pinned ? 'false' : 'true'})">${a.pinned ? '取消置顶' : '置顶'}</div>
                      <div class="dropdown-item" onclick="${a.unread ? `markRead('${escapeHtml(id)}')` : `markUnread('${escapeHtml(id)}')`}">${a.unread ? '标为已读' : '标为未读'}</div>
                      ${a.tweetUrl ? `<div class="dropdown-item" onclick="window.open('${escapeHtml(a.tweetUrl)}', '_blank')">查看原文</div>` : ''}
                      <div class="dropdown-item delete" onclick="deleteItem('${escapeHtml(id)}')">删除</div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="swipe-actions">
                <button class="swipe-btn pin" onclick="pinItem('${escapeHtml(id)}', ${a.pinned ? 'false' : 'true'})">${a.pinned ? '取消置顶' : '置顶'}</button>
                <button class="swipe-btn read" onclick="${a.unread ? `markRead('${escapeHtml(id)}')` : `markUnread('${escapeHtml(id)}')`}">${a.unread ? '标为已读' : '标为未读'}</button>
                ${a.tweetUrl ? `<button class="swipe-btn source" onclick="window.open('${escapeHtml(a.tweetUrl)}', '_blank')">原文</button>` : ''}
                <button class="swipe-btn delete" onclick="deleteItem('${escapeHtml(id)}')">删除</button>
              </div>
            </div>
          </li>`;
    }).join('');

  const savedList = buildList(articlesBySaved);
  const dataJson = JSON.stringify(
    articlesBySaved.map((a) => ({
      fileName: a.fileName,
      title: a.title.length > 80 ? a.title.substring(0, 80) + '...' : a.title,
      author: a.author,
      authorAvatar: a.authorAvatar || '',
      tweetUrl: a.tweetUrl || '',
      tweetDate: a.tweetDate,
      savedDate: a.savedDate,
      savedTimestamp: a.savedTimestamp,
      tweetTimestamp: a.tweetTimestamp,
      pinned: !!a.pinned,
      pinnedAt: a.pinnedAt || 0,
      unread: !!a.unread,
      hashtags: a.hashtags || [],
      likes: a.likes || 0,
      retweets: a.retweets || 0,
      replies: a.replies || 0,
    }))
  );

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png" />
  <title>推文收藏</title>
  <style>
    :root {
      --bg: #f5f5f5; --surface: #fff; --text: #1a1a1a;
      --text-secondary: #888; --text-tertiary: #aaa;
      --accent: #576b95; --accent-bg: #eef2ff;
      --border: #eee; --shadow-sm: rgba(0,0,0,0.05); --shadow-md: rgba(0,0,0,0.1);
    }
    [data-theme="dark"] {
      --bg: #0f0f0f; --surface: #1a1a1a; --text: #e0e0e0;
      --text-secondary: #999; --text-tertiary: #666;
      --accent: #7d93ad; --accent-bg: #1c2738;
      --border: #2a2a2a; --shadow-sm: rgba(0,0,0,0.3); --shadow-md: rgba(0,0,0,0.4);
    }
    [data-theme="dark"] .sort-btn.active {
      background: var(--accent-bg); color: var(--accent); border-color: var(--accent);
    }
    @keyframes skeleton-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.7; } }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg); color: var(--text); min-height: 100vh;
      -webkit-font-smoothing: antialiased; transition: background 0.3s ease, color 0.3s ease;
    }
    .container { max-width: 740px; margin: 0 auto; padding: 20px 16px 40px; }
    .header {
      background: var(--surface); border-radius: 8px; padding: 24px; margin-bottom: 16px;
      box-shadow: 0 1px 3px var(--shadow-sm);
      display: flex; justify-content: space-between; align-items: center;
      flex-wrap: wrap; gap: 12px;
    }
    .header h1 { font-size: 22px; font-weight: 700; color: var(--text); }
    .header .subtitle { color: var(--text-secondary); font-size: 14px; margin-top: 4px; }
    .sort-buttons { display: flex; gap: 8px; align-items: center; }
    .theme-btn, .refresh-btn {
      width: 32px; height: 32px; border: none; border-radius: 50%;
      background: transparent; color: var(--text-secondary); cursor: pointer;
      display: flex; align-items: center; justify-content: center; transition: all 0.2s;
    }
    .theme-btn:hover, .refresh-btn:hover { color: var(--text); }
    .sort-btn {
      padding: 6px 14px; border: 1px solid var(--border); border-radius: 16px;
      background: var(--surface); color: var(--text-secondary); font-size: 13px;
      cursor: pointer; transition: all 0.2s;
    }
    .sort-btn:hover { border-color: var(--accent); color: var(--accent); }
    .sort-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .article-list { list-style: none; }
    .article-item {
      background: var(--surface); border-radius: 8px; margin-bottom: 12px;
      box-shadow: 0 1px 3px var(--shadow-sm);
      transition: transform 0.2s ease, box-shadow 0.2s ease; position: relative;
    }
    .article-item:hover { transform: translateY(-2px) scale(1.005); box-shadow: 0 8px 24px var(--shadow-md); }
    .article-item.pinned { }
    .item-row { display: flex; align-items: flex-start; padding: 16px; }
    .meta-avatar {
      width: 18px; height: 18px; border-radius: 50%; object-fit: cover;
      flex-shrink: 0; background: var(--border);
    }
    .article-link {
      flex: 1; display: block; padding: 0;
      text-decoration: none; color: inherit; min-width: 0;
    }
    .article-title-wrap {
      font-size: 17px; font-weight: 700; color: var(--text);
      margin-bottom: 6px; line-height: 1.5;
      display: flex; align-items: center; gap: 8px;
    }
    .pinned-badge {
      font-size: 11px; font-weight: 500; color: var(--accent);
      background: var(--accent-bg); padding: 1px 8px; border-radius: 4px; flex-shrink: 0;
    }
    .article-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 13px; margin-bottom: 6px; }
    .meta-author { color: var(--text-tertiary); font-weight: 400; }
    .meta-time { white-space: nowrap; color: var(--text-tertiary); }
    .article-stats { display: flex; gap: 16px; font-size: 12px; color: var(--text-tertiary); margin-bottom: 6px; }
    .stat { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; color: var(--text-secondary); }
    .stat svg { flex-shrink: 0; opacity: 0.7; }
    .article-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .tag {
      font-size: 12px; color: var(--accent); background: var(--accent-bg);
      padding: 1px 8px; border-radius: 4px;
    }
    .item-actions {
      display: flex; align-items: center; gap: 6px;
      padding: 0 12px 0 0; position: relative; flex-shrink: 0;
    }
    .unread-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #fa5151; flex-shrink: 0;
    }
    .more-wrap { position: relative; }
    .more-btn {
      width: 26px; height: 26px; border: none; border-radius: 50%;
      background: transparent; color: var(--text-secondary); font-size: 18px;
      cursor: pointer; display: flex; align-items: center;
      justify-content: center; line-height: 1;
    }
    .more-btn:hover { background: var(--border); color: var(--text); }
    .dropdown-menu {
      position: absolute;
      background: var(--surface); border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      min-width: 120px; z-index: 9999;
      display: none; overflow: hidden;
    }
    .dropdown-menu.show { display: block; }
    .dropdown-item {
      padding: 12px 16px; font-size: 14px; color: var(--text);
      cursor: pointer; transition: background 0.15s;
    }
    .dropdown-item:hover { background: var(--border); }
    .dropdown-item.delete { color: #fa5151; }
    .dropdown-item.delete:hover { background: rgba(250,81,81,0.1); }
    .empty {
      background: var(--surface); border-radius: 8px; padding: 60px 24px;
      text-align: center; color: var(--text-secondary); font-size: 15px;
      box-shadow: 0 1px 3px var(--shadow-sm);
    }
    /* ---- Swipe actions (mobile) ---- */
    .swipe-wrap { position: relative; overflow: hidden; }
    .swipe-content { transition: transform 0.25s ease; width: 100%; }
    .swipe-actions {
      display: none;
      position: absolute;
      right: 0; top: 0; bottom: 0;
      align-items: stretch;
      z-index: 2;
    }
    .swipe-btn {
      border: none; padding: 0 14px; font-size: 13px; color: #fff;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      white-space: nowrap;
    }
    .swipe-btn.pin { background: #576b95; }
    .swipe-btn.read { background: #7d93ad; }
    .swipe-btn.source { background: #888; }
    .swipe-btn.delete { background: #fa5151; }
    .refresh-btn { display: none; }
    @media (max-width: 480px) {
      .header { padding: 20px 16px; }
      .article-link { padding: 16px 0 16px 16px; }
      .item-actions { padding: 16px 12px 16px 4px; }
      .more-btn { display: none; }
      .refresh-btn { display: flex; }
      .article-item { overflow: hidden; }
    }
    @media (min-width: 481px) {
      .swipe-actions { display: none !important; }
    }
  </style>
</head>
<body>
<div class="container">
    <div class="header">
      <div>
        <h1>推文收藏</h1>
        <p class="subtitle" id="count">共 ${articlesBySaved.length} 条</p>
</div>
      <div style="display:flex; align-items:center; gap:12px;">
        <div class="sort-buttons">
          <button class="sort-btn active" onclick="sortBy('saved')" id="btn-saved">按收藏时间</button>
          <button class="sort-btn" onclick="sortBy('tweet')" id="btn-tweet">按发布时间</button>
          <button class="sort-btn" onclick="sortBy('unread')" id="btn-unread">按未读</button>
        </div>
        <button class="theme-btn" onclick="toggleTheme()" title="切换主题">
          <svg id="theme-icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          <svg id="theme-icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
        </button>
        <button class="refresh-btn" onclick="location.reload()" title="刷新">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>
    </div>
    <ul class="article-list" id="article-list">
      ${articlesBySaved.length === 0 ? '<li class="empty">还没有保存的推文</li>' : savedList}
    </ul>
  </div>
  <script>
    let articlesData = ${dataJson};
    let activeMenu = null;
    let activeMenuParent = null;
    let menuJustOpened = false;

    function closeMenu() {
      if (!activeMenu || menuJustOpened) return;
      activeMenu.classList.remove('show');
      if (activeMenuParent) { activeMenuParent.appendChild(activeMenu); activeMenuParent = null; }
      activeMenu = null;
    }

    document.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);

    function toggleMenu(e, id) {
      e.preventDefault(); e.stopPropagation();
      const menu = document.getElementById('menu-' + id);
      if (!menu) return;
      if (activeMenu && activeMenu !== menu) {
        activeMenu.classList.remove('show');
        if (activeMenuParent) { activeMenuParent.appendChild(activeMenu); activeMenuParent = null; }
      }
      menu.classList.toggle('show');
      if (menu.classList.contains('show')) {
        activeMenuParent = menu.parentNode;
        document.body.appendChild(menu);
        const btn = e.currentTarget;
        const rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.right = (window.innerWidth - rect.right) + 'px';
        activeMenu = menu;
        menuJustOpened = true;
        setTimeout(function() { menuJustOpened = false; }, 100);
      } else {
        if (activeMenuParent) { activeMenuParent.appendChild(menu); activeMenuParent = null; }
        activeMenu = null;
      }
    }

    function getSortedData() {
      const isUnread = document.getElementById('btn-unread').classList.contains('active');
      let data = isUnread
        ? articlesData.filter(function(a) { return a.unread; })
        : [...articlesData];
      const isSaved = document.getElementById('btn-saved').classList.contains('active');
      const sortFn = isSaved
        ? function(a, b) { return b.savedTimestamp - a.savedTimestamp; }
        : function(a, b) { return b.tweetTimestamp - a.tweetTimestamp; };
      data.sort(function(a, b) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
        return sortFn(a, b);
      });
      return data;
    }

    function renderList() {
      const list = document.getElementById('article-list');
      const data = getSortedData();
      if (data.length === 0) {
        const isUnread = document.getElementById('btn-unread').classList.contains('active');
        list.innerHTML = '<li class="empty">' + (isUnread ? '你真棒，所有帖子都看完了！' : '还没有保存的推文') + '</li>';
        return;
      }
      const isSaved = document.getElementById('btn-saved').classList.contains('active');
      list.innerHTML = data.map(a => {
        const pinnedBadge = a.pinned ? '<span class="pinned-badge">置顶</span>' : '';
        const unreadDot = a.unread ? '<span class="unread-dot"></span>' : '';
        const pinLabel = a.pinned ? '取消置顶' : '置顶';
        const id = a.fileName.replace('.html', '');
        const avatarUrl = a.authorAvatar || ('https://unavatar.io/x/' + (a.authorHandle || ''));
        var tagsHtml = (a.hashtags && a.hashtags.length > 0) ? '<div class="article-tags">' + a.hashtags.slice(0, 5).map(function(t) { return '<span class="tag">#' + t + '</span>'; }).join('') + '</div>' : '';
        var swipeActions = '<div class="swipe-actions"><button class="swipe-btn pin" onclick="pinItem(\\'' + id + '\\', ' + (a.pinned ? 'false' : 'true') + ')">' + pinLabel + '</button><button class="swipe-btn read" onclick="' + (a.unread ? 'markRead(\\'' + id + '\\')' : 'markUnread(\\'' + id + '\\')') + '">' + (a.unread ? '标为已读' : '标为未读') + '</button>' + (a.tweetUrl ? '<button class="swipe-btn source" onclick="window.open(\\'' + a.tweetUrl + '\\', \\'_blank\\')">原文</button>' : '') + '<button class="swipe-btn delete" onclick="deleteItem(\\'' + id + '\\')">删除</button></div>';
        return '<li class="article-item' + (a.pinned ? ' pinned' : '') + '" id="item-' + id + '"><div class="swipe-wrap"><div class="item-row swipe-content"><a href="articles/' + a.fileName + '" class="article-link" onclick="markRead(\\'' + id + '\\')"><div class="article-title-wrap">' + a.title + pinnedBadge + '</div><div class="article-meta"><img src="' + avatarUrl + '" alt="" class="meta-avatar" loading="lazy" /><span class="meta-author">' + a.author + '</span><span class="meta-time">收藏于 ' + (a.savedDate || '').substring(5) + ' · 更新于 ' + a.tweetDate.substring(5) + '</span></div><div class="article-stats"><span class="stat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' + (a.replies||0) + '</span><span class="stat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>' + (a.retweets||0) + '</span><span class="stat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>' + (a.likes||0) + '</span></div>' + tagsHtml + '</a><div class="item-actions">' + unreadDot + '<div class="more-wrap"><button class="more-btn" onclick="toggleMenu(event, \\'' + id + '\\')">⋯</button><div class="dropdown-menu" id="menu-' + id + '"><div class="dropdown-item" onclick="pinItem(\\'' + id + '\\', ' + (a.pinned ? 'false' : 'true') + ')">' + pinLabel + '</div><div class="dropdown-item" onclick="' + (a.unread ? 'markRead(\\'' + id + '\\')' : 'markUnread(\\'' + id + '\\')') + '">' + (a.unread ? '标为已读' : '标为未读') + '</div>' + (a.tweetUrl ? '<div class="dropdown-item" onclick="window.open(\\'' + a.tweetUrl + '\\', \\'_blank\\')">查看原文</div>' : '') + '<div class="dropdown-item delete" onclick="deleteItem(\\'' + id + '\\')">删除</div></div></div></div></div>' + swipeActions + '</div></li>';
      }).join('');
    }

    function sortBy(type) {
      document.getElementById('btn-saved').classList.toggle('active', type === 'saved');
      document.getElementById('btn-tweet').classList.toggle('active', type === 'tweet');
      document.getElementById('btn-unread').classList.toggle('active', type === 'unread');
      renderList();
    }

    async function pinItem(id, pin) {
      const res = await fetch('/api/pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id + '.html', pin: pin === 'true' || pin === true })
      });
      const d = await res.json();
      if (d.success) {
        const item = articlesData.find(a => a.fileName === id + '.html');
        if (item) { item.pinned = d.pinned; item.pinnedAt = d.pinned ? Date.now() : 0; }
        renderList();
      }
    }

    function markRead(id) {
      const item = articlesData.find(a => a.fileName === id + '.html');
      if (item && item.unread) {
        // Fire-and-forget: sendBeacon for reliable delivery during navigation
        const data = JSON.stringify({ id: id + '.html' });
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/read', new Blob([data], { type: 'application/json' }));
        } else {
          fetch('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true });
        }
        item.unread = false;
        renderList();
      }
    }

    async function markUnread(id) {
      const res = await fetch('/api/unread', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id + '.html' })
      });
      const d = await res.json();
      if (d.success) {
        const item = articlesData.find(a => a.fileName === id + '.html');
        if (item) item.unread = true;
        renderList();
      }
    }

    async function deleteItem(id) {
      if (!confirm('确定要删除这条推文吗？')) return;
      const res = await fetch('/api/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id + '.html' })
      });
      const d = await res.json();
      if (d.success) {
        articlesData = articlesData.filter(a => a.fileName !== id + '.html');
        document.getElementById('count').textContent = '共 ' + articlesData.length + ' 条';
        renderList();
      }
    }

    // ---- Mobile swipe handling ----
    (function initSwipe() {
      var SWIPE_THRESHOLD = 50;
      var ELASTIC_LIMIT = SWIPE_THRESHOLD * 1.2;
      var DAMPING = 0.6;
      var SPEED_THRESHOLD = 0.5;
      var VERTICAL_RATIO = 1.2;
      var TRANSITION_STYLE = 'transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)';

      var startX = 0;
      var startY = 0;
      var startTime = 0;
      var currentX = 0;
      var currentY = 0;
      var activeSwipeContent = null;
      var activeSwipeActions = null;
      var isSwiping = false;
      var isScrolling = false;
      var isExpanded = false;

      function getTranslateX(el) {
        var style = el.style.transform;
        if (!style) return 0;
        var match = style.match(/translateX\(([-\d.]+)px\)/);
        return match ? parseFloat(match[1]) : 0;
      }

      function setTranslateX(el, offset, withTransition) {
        if (withTransition) {
          el.style.transition = TRANSITION_STYLE;
        } else {
          el.style.transition = 'none';
        }
        el.style.transform = 'translateX(' + offset + 'px)';
      }

      function closeAllSwipes() {
        var wraps = document.querySelectorAll('.swipe-wrap');
        for (var i = 0; i < wraps.length; i++) {
          var content = wraps[i].querySelector('.swipe-content');
          var actions = wraps[i].querySelector('.swipe-actions');
          if (content) {
            content.style.transition = TRANSITION_STYLE;
            content.style.transform = '';
          }
          if (actions) actions.style.display = 'none';
        }
        activeSwipeContent = null;
        activeSwipeActions = null;
        isExpanded = false;
      }

      document.addEventListener('click', function(e) {
        if (!e.target.closest('.swipe-actions')) {
          closeAllSwipes();
        }
      });

      document.addEventListener('touchstart', function(e) {
        var wrap = e.target.closest('.swipe-wrap');
        if (!wrap) {
          closeAllSwipes();
          return;
        }
        var content = wrap.querySelector('.swipe-content');
        if (!content) return;

        // Multi-touch guard
        if (e.touches.length > 1) {
          isSwiping = false;
          return;
        }

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startTime = Date.now();
        currentX = startX;
        currentY = startY;
        isSwiping = true;
        isScrolling = false;
        isExpanded = getTranslateX(content) <= -SWIPE_THRESHOLD / 2;

        // Close other open swipes with animation
        if (activeSwipeContent && activeSwipeContent !== content) {
          var otherWrap = activeSwipeContent.closest('.swipe-wrap');
          var otherActions = otherWrap ? otherWrap.querySelector('.swipe-actions') : null;
          activeSwipeContent.style.transition = TRANSITION_STYLE;
          activeSwipeContent.style.transform = '';
          if (otherActions) otherActions.style.display = 'none';
        }

        activeSwipeContent = content;
        activeSwipeActions = wrap.querySelector('.swipe-actions');
      }, { passive: true });

      document.addEventListener('touchmove', function(e) {
        if (!isSwiping || !activeSwipeContent) return;

        // Multi-touch guard
        if (e.touches.length > 1) {
          isSwiping = false;
          return;
        }

        currentX = e.touches[0].clientX;
        currentY = e.touches[0].clientY;
        var deltaX = currentX - startX;
        var deltaY = currentY - startY;

        // Vertical scroll conflict resolution
        if (!isScrolling && Math.abs(deltaY) > Math.abs(deltaX) * VERTICAL_RATIO) {
          isScrolling = true;
          isSwiping = false;
          return;
        }
        if (isScrolling) return;

        // Horizontal swipe — prevent page scroll
        e.preventDefault();

        var offset;
        var currentOffset = getTranslateX(activeSwipeContent);
        var wasExpanded = currentOffset <= -SWIPE_THRESHOLD / 2;

        if (deltaX < 0) {
          // Left swipe (open)
          if (wasExpanded) {
            offset = -SWIPE_THRESHOLD + deltaX * DAMPING;
          } else {
            offset = deltaX * DAMPING;
          }
        } else if (deltaX > 0 && wasExpanded) {
          // Right swipe to close (from expanded state)
          offset = -SWIPE_THRESHOLD + deltaX * DAMPING;
        } else {
          // Right swipe on closed item — ignore
          return;
        }

        // Elastic boundary
        if (offset < -ELASTIC_LIMIT) {
          var over = offset + ELASTIC_LIMIT;
          offset = -ELASTIC_LIMIT + over * 0.3;
        }
        if (offset > 0) offset = 0;

        setTranslateX(activeSwipeContent, offset, false);

        // Show actions when swiping left past threshold
        if (activeSwipeActions && offset < -SWIPE_THRESHOLD / 2) {
          activeSwipeActions.style.display = 'flex';
        }
      }, { passive: false });

      document.addEventListener('touchend', function(e) {
        if (!isSwiping || !activeSwipeContent) return;
        isSwiping = false;

        var deltaX = currentX - startX;
        var elapsed = Date.now() - startTime;
        var speed = elapsed > 0 ? Math.abs(deltaX) / elapsed : 0;
        var currentOffset = getTranslateX(activeSwipeContent);
        var wrap = activeSwipeContent.closest('.swipe-wrap');
        var actions = wrap ? wrap.querySelector('.swipe-actions') : null;

        var shouldExpand = false;

        if (speed > SPEED_THRESHOLD) {
          // Velocity-based snap
          if (deltaX < 0) {
            shouldExpand = true;
          } else if (deltaX > 0 && isExpanded) {
            shouldExpand = false;
          } else {
            shouldExpand = currentOffset <= -SWIPE_THRESHOLD / 2;
          }
        } else {
          // Distance-based snap
          shouldExpand = currentOffset <= -SWIPE_THRESHOLD / 2;
        }

        if (shouldExpand) {
          setTranslateX(activeSwipeContent, -SWIPE_THRESHOLD, true);
          if (actions) actions.style.display = 'flex';
          isExpanded = true;
        } else {
          setTranslateX(activeSwipeContent, 0, true);
          if (actions) actions.style.display = 'none';
          activeSwipeContent = null;
          activeSwipeActions = null;
          isExpanded = false;
        }
      }, { passive: true });

      document.addEventListener('touchcancel', function() {
        if (activeSwipeContent) {
          var wrap = activeSwipeContent.closest('.swipe-wrap');
          var actions = wrap ? wrap.querySelector('.swipe-actions') : null;
          activeSwipeContent.style.transition = TRANSITION_STYLE;
          activeSwipeContent.style.transform = '';
          if (actions) actions.style.display = 'none';
          activeSwipeContent = null;
          activeSwipeActions = null;
        }
        isSwiping = false;
        isScrolling = false;
        isExpanded = false;
      }, { passive: true });
    })();
  </script>
<script>
(function(){
  var t=localStorage.getItem('theme');
  if(t) document.documentElement.setAttribute('data-theme',t);
  else if(window.matchMedia('(prefers-color-scheme:dark)').matches) document.documentElement.setAttribute('data-theme','dark');
  updateThemeIcon();
})();
function toggleTheme() {
  var c = document.documentElement.getAttribute('data-theme');
  var n = c === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', n);
  localStorage.setItem('theme', n);
  updateThemeIcon();
}
function updateThemeIcon() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var s = document.getElementById('theme-icon-sun');
  var m = document.getElementById('theme-icon-moon');
  if (s) s.style.display = isDark ? 'none' : '';
  if (m) m.style.display = isDark ? '' : 'none';
}
</script>
</body>
</html>`;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    maxRedirects: 5,
    httpsAgent: getDownloadAgent(),
    headers: { 'User-Agent': 'TweetArchive/1.0' },
  });

  // Only reject non-media content types (HTML, JSON, etc.)
  const contentType = String(response.headers['content-type'] || '');
  if (contentType.startsWith('text/html') || contentType.startsWith('application/json')) {
    throw new Error('Not a media file: ' + contentType);
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const timer = setTimeout(() => {
      file.destroy();
      fs.unlink(destPath, () => {});
      reject(new Error('Timeout'));
    }, 20000);

    response.data.pipe(file);
    file.on('finish', () => {
      clearTimeout(timer);
      file.close();
      resolve();
    });
    file.on('error', (err: Error) => {
      clearTimeout(timer);
      file.destroy();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

export function checkTweetExists(tweetId: string): boolean {
  const meta = loadMeta();
  return meta.some(m => m.fileName.includes('_' + tweetId + '.html'));
}

export function isTweetChanged(tweetId: string, tweet: FetchedTweet): boolean {
  const meta = loadMeta();
  const suffix = '_' + tweetId + '.html';
  const existing = meta.find(m => m.fileName.endsWith(suffix));
  if (!existing) return true;
  const newTitle = tweet.title || tweet.text.split('\n')[0].substring(0, 80);
  const newKey = tweet.text.substring(0, 200);
  return (
    existing.title !== newTitle ||
    existing.contentKey !== newKey ||
    existing.likes !== tweet.likes ||
    existing.retweets !== tweet.retweets ||
    existing.replies !== tweet.replies
  );
}

export async function saveTweet(tweet: FetchedTweet): Promise<string> {
  ensureDirs();
  const fileNameBase = sanitizeFileName(tweet.author.screen_name) + '_' + tweet.id;
  const htmlFileName = fileNameBase + '.html';
  const htmlPath = path.join(ARTICLES_DIR, htmlFileName);

  const allImageUrls: string[] = [];
  const photos = tweet.media?.photos || [];
  for (const photo of photos) { allImageUrls.push(photo.url); }

  const allVideoUrls: string[] = [];
  const videos = tweet.media?.videos || [];
  for (const video of videos) { allVideoUrls.push(video.url); }

  const localImagePaths: string[] = [...allImageUrls];
  const localVideoPaths: string[] = [...allVideoUrls];

  // Try to download images (best-effort via proxy)
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const ext = path.extname(new URL(photo.url).pathname) || '.jpg';
    const imgFileName = fileNameBase + '_img' + i + ext;
    const imgPath = path.join(IMAGES_DIR, imgFileName);
    try {
      await downloadFile(photo.url, imgPath);
      localImagePaths[i] = '../images/' + imgFileName;
    } catch (err) {
      // Fall back to original URL
    }
  }

  // Try to download videos (best-effort via proxy)
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const ext = '.mp4';
    const vidFileName = fileNameBase + '_vid' + i + ext;
    const vidPath = path.join(VIDEOS_DIR, vidFileName);
    try {
      await downloadFile(video.url, vidPath);
      localVideoPaths[i] = '../videos/' + vidFileName;
    } catch (err) {
      // Fall back to original URL
    }
  }

  const html = renderTweetHtml(tweet, localImagePaths, allImageUrls, allVideoUrls, localVideoPaths);
  fs.writeFileSync(htmlPath, html, 'utf-8');

  const meta = loadMeta();
  const now = Date.now();
  // Extract hashtags from tweet text
  const hashtagMatches = tweet.text.match(/#(\w+)/g);
  const hashtags = hashtagMatches ? [...new Set(hashtagMatches.map(h => h.substring(1)))] : [];

  const existingIndex = meta.findIndex(m => m.fileName === htmlFileName);
  const existing = existingIndex >= 0 ? meta[existingIndex] : null;
  const metaEntry: ArticleMeta = {
    fileName: htmlFileName,
    title: tweet.title || tweet.text.split('\n')[0].substring(0, 80),
    author: tweet.author.name,
    authorHandle: tweet.author.screen_name,
    authorAvatar: 'https://unavatar.io/x/' + tweet.author.screen_name,
    tweetUrl: tweet.url,
    tweetDate: formatDate(tweet.created_timestamp),
    savedDate: formatDate(Math.floor(now / 1000)),
    tweetTimestamp: tweet.created_timestamp,
    savedTimestamp: Math.floor(now / 1000),
    contentKey: tweet.text.substring(0, 200),
    pinned: existing ? existing.pinned : false,
    pinnedAt: existing ? existing.pinnedAt : undefined,
    unread: existing ? existing.unread : true,
    hashtags,
    likes: tweet.likes,
    retweets: tweet.retweets,
    replies: tweet.replies,
  };
  if (existingIndex >= 0) { meta[existingIndex] = metaEntry; }
  else { meta.push(metaEntry); }
  saveMeta(meta);
  await rebuildIndex();
  return htmlFileName;
}

export async function rebuildIndex(): Promise<void> {
  const meta = loadMeta();
  const existingFiles = new Set(fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html')));
  const validMeta = meta.filter(m => existingFiles.has(m.fileName));
  if (validMeta.length !== meta.length) { saveMeta(validMeta); }

  const sortWithPinned = (sortFn: (a: ArticleMeta, b: ArticleMeta) => number) => {
    return [...validMeta].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return sortFn(a, b);
    });
  };
  const bySaved = sortWithPinned((a, b) => b.savedTimestamp - a.savedTimestamp);
  const byTweet = sortWithPinned((a, b) => b.tweetTimestamp - a.tweetTimestamp);
  const indexHtml = renderIndexHtml(bySaved, byTweet);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), indexHtml, 'utf-8');
}

export function getPublicDir(): string {
  ensureDirs();
  return PUBLIC_DIR;
}
export function getArticlesDir(): string {
  ensureDirs();
  return ARTICLES_DIR;
}
export function getImagesDir(): string {
  ensureDirs();
  return IMAGES_DIR;
}
export function getVideosDir(): string {
  ensureDirs();
  return VIDEOS_DIR;
}
