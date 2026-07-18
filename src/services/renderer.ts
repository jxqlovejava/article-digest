import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';
import type { FetchedTweet, TweetPhoto } from './fetcher';
import { deriveTitle } from './fetcher';
import { insertArticle as insertSearchArticle, deleteArticle as deleteSearchArticle, syncMeta as syncSearchMeta, generateEmbedding } from './search';
import { extractOpinions } from './opinions';
import { normalizeScrapedText, normalizeAuthorField } from '../utils/textDecode';

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
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

// X-style SVG icons (18px, currentColor, stroke-based)
const ICONS = {
  comment: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  repost: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>',
  like: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
  share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
};

function ensureDirs() {
  [DATA_DIR, ARTICLES_DIR, IMAGES_DIR, VIDEOS_DIR, AVATARS_DIR, PUBLIC_DIR].forEach((dir) => {
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

/** @deprecated use normalizeScrapedText — kept as thin alias for local call sites */
function decodeHtmlEntities(text: string): string {
  return normalizeScrapedText(text);
}

/** Ensure tweet text fields are plain Unicode before escapeHtml / meta write. */
function normalizeTweetFields(tweet: FetchedTweet): FetchedTweet {
  return {
    ...tweet,
    title: tweet.title != null ? normalizeScrapedText(tweet.title) : tweet.title,
    text: normalizeScrapedText(tweet.text || ''),
    author: {
      ...tweet.author,
      name: normalizeAuthorField(tweet.author?.name),
      screen_name: normalizeAuthorField(tweet.author?.screen_name) || tweet.author?.screen_name || 'unknown',
    },
  };
}

function convertMarkdownToHtml(text: string): string {
  // Preprocess @mentions and #hashtags into markdown links before marked parsing.
  // Only match when not already inside a markdown link (preceded by '[' or '(').
  let processed = text.replace(/(?<![\w([])@(\w{1,15})\b/g, '[@$1](https://twitter.com/$1)');
  processed = processed.replace(/(?<![\w([])#(\w{1,100})\b/g, '[#$1](https://twitter.com/hashtag/$1)');
  return marked.parse(processed) as string;
}

function renderTweetHtml(tweet: FetchedTweet, localImagePaths: string[], allImageUrls: string[], allVideoUrls: string[], localVideoPaths: string[]): string {
  // Plain text first — otherwise escapeHtml turns &amp; into &amp;amp; (and worse).
  tweet = normalizeTweetFields(tweet);
  const dateStr = formatDate(tweet.created_timestamp);
  const rawTitle = tweet.title || deriveTitle(tweet.text, 80);
  const title = normalizeScrapedText(rawTitle);

  // X-style SVG icons (defined locally, used in stats-bar below)

  // Track which media indices were referenced by markers in the original text
  const referencedImgIndices = new Set<number>();
  const referencedVideoIndices = new Set<number>();

  // Step 1: replace [IMG:N] and [VIDEO:N] with safe markers
  const imgMap: string[] = [];
  let text = tweet.text.replace(/\[IMG:(\d+)\]/g, (_, idx) => {
    const i = parseInt(idx, 10);
    referencedImgIndices.add(i);
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
    referencedVideoIndices.add(i);
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

  // Step 2: convert markdown to HTML via marked (skip for wechat — content is already HTML)
  const isWechat = tweet.sourceType === 'wechat';
  const isWebpage = tweet.sourceType === 'webpage';
  let contentHtml = isWechat ? text : convertMarkdownToHtml(text);

  // Step 3: replace image markers with real <img> tags
  // alt: wechat/webpage use 配图; twitter keeps 推文图片 (screen readers / broken-img fallback)
  const imgAlt = isWechat || isWebpage ? '配图' : '推文图片';
  contentHtml = contentHtml.replace(/<!--IMG:(\d+)-->/g, (_, idx) => {
    const src = imgMap[parseInt(idx, 10)];
    return src ? `<img src="${src}" alt="${imgAlt}" loading="lazy" class="tweet-inline-img" />` : '';
  });

  // Step 4: append unreferenced media (regular tweets without [IMG:N]/[VIDEO:N] markers)
  const unreferencedMedia: string[] = [];
  for (let i = 0; i < allImageUrls.length; i++) {
    if (!referencedImgIndices.has(i)) {
      const src = localImagePaths[i] || allImageUrls[i];
      if (src) {
        unreferencedMedia.push(`<img src="${src}" alt="${imgAlt}" loading="lazy" class="tweet-inline-img" />`);
      }
    }
  }
  for (let i = 0; i < allVideoUrls.length; i++) {
    if (!referencedVideoIndices.has(i)) {
      const src = localVideoPaths[i] || allVideoUrls[i];
      if (src) {
        unreferencedMedia.push(`<video src="${src}" controls preload="metadata" class="tweet-inline-video"></video>`);
      }
    }
  }
  if (unreferencedMedia.length > 0) {
    contentHtml += '\n' + unreferencedMedia.join('\n');
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" href="/favicon.png?v=3" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=3" />
  <link rel="stylesheet" href="/highlight.css" id="hl-theme-light">
  <link rel="stylesheet" href="/highlight-dark.css" id="hl-theme-dark" disabled>
  <style>
    :root {
      --bg: #f5f5f5; --surface: #fff; --text: #1a1a1a;
      --text-secondary: #888; --text-tertiary: #aaa;
      --accent: #5a5a5a; --accent-bg: #f0f0f0;
      --ai-fab-bg: rgba(255,255,255,0.72);
      --ai-fab-fg: #6c63ff;
      --ai-fab-shadow: 0 4px 14px rgba(15,23,42,0.10), 0 1px 3px rgba(15,23,42,0.06);
      --ai-fab-shadow-hover: 0 8px 22px rgba(108,99,255,0.18), 0 2px 6px rgba(15,23,42,0.08);
      --border: #eee; --shadow-sm: rgba(0,0,0,0.05); --shadow-md: rgba(0,0,0,0.1);
      --code-bg: #f2f2f2; --code-color: #d63384;
    }
    [data-theme="dark"] {
      --bg: #0f0f0f; --surface: #1a1a1a; --text: #e8e8e8;
      --text-secondary: #b0b0b0; --text-tertiary: #888;
      --accent: #b0b0b0; --accent-bg: #2a2a2a;
      --ai-fab-bg: rgba(28,28,30,0.68);
      --ai-fab-fg: #b4a7ff;
      --ai-fab-shadow: 0 4px 16px rgba(0,0,0,0.35), 0 1px 3px rgba(0,0,0,0.25);
      --ai-fab-shadow-hover: 0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(180,167,255,0.16);
      --border: #3a3a3a; --shadow-sm: rgba(0,0,0,0.3); --shadow-md: rgba(0,0,0,0.4);
      --code-bg: #2d2d2d; --code-color: #ff8fab;
    }
    [data-theme="dark"] .sort-btn.active,
    [data-theme="dark"] .sort-btn.active:hover,
    [data-theme="dark"] .sort-btn.active:focus,
    [data-theme="dark"] .sort-btn.active:active {
      background: var(--accent-bg); color: var(--accent); border-color: var(--accent-bg);
    }
    @keyframes skeleton-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.7; } }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; overscroll-behavior-x: none; }
    .page-wrapper { overflow-x: hidden; position: relative; min-height: 100vh; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.7;
      -webkit-font-smoothing: antialiased; transition: background 0.3s ease, color 0.3s ease;
    }
    .container { max-width: 720px; margin: 0 auto; padding: 0 0 40px; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; padding: max(8px, env(safe-area-inset-top)) 16px 12px; margin-bottom: 0; }
    .theme-btn, .refresh-btn {
      width: 36px; height: 36px; border: none; border-radius: 50%;
      background: transparent; color: var(--text-secondary); cursor: pointer;
      display: flex; align-items: center; justify-content: center; transition: color 0.2s;
    }
    .theme-btn:hover, .refresh-btn:hover { color: var(--text); }
    .article-card { background: transparent; border-radius: 0; padding: 0; box-shadow: none; }
    .article-header { margin-bottom: 24px; padding: 0 20px; border-bottom: none; }
    .article-title { font-size: 26px; font-weight: 700; line-height: 1.25; color: var(--text); margin-bottom: 16px; word-break: break-word; }
    .article-meta { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text-secondary); }
    .article-meta .avatar { background: var(--border); width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
    .article-meta .author-info { display: flex; flex-direction: column; }
    .article-meta .author-name { font-weight: 400; color: var(--text); font-size: 15px; }
    .article-meta .author-handle { color: var(--text-tertiary); font-size: 13px; }
    .article-meta .divider { color: var(--border); }
    .article-meta .date { color: var(--text-tertiary); font-size: 13px; }
    .article-content { font-size: 17px; line-height: 1.7; color: var(--text); word-break: break-word; overflow-wrap: break-word; overflow-x: auto; padding: 0 16px; }
    .article-content table { max-width: 100%; word-break: break-all; }
    .article-content p { margin-bottom: 1.1em; }
    .article-content a { color: var(--accent); text-decoration: none; }
    .article-content a:hover { text-decoration: underline; }
    .article-content strong { font-weight: 700; color: var(--text); }
    .header-img { display: block; width: 100%; height: auto; margin: 0 0 20px; border-radius: 8px; box-shadow: 0 4px 12px var(--shadow-sm); }
    .tweet-inline-img { display: block; width: 100%; height: auto; border-radius: 8px; margin: 20px 0; box-shadow: 0 4px 12px var(--shadow-sm); }
    .tweet-inline-video { display: block; width: 100%; max-height: 480px; border-radius: 8px; margin: 20px 0; background: #000; box-shadow: 0 4px 12px var(--shadow-sm); }
    [data-theme="dark"] .tweet-inline-img,
    [data-theme="dark"] .header-img { opacity: 0.96; }
    .article-footer { margin-top: 32px; padding: 0 20px; border-top: none; display: flex; justify-content: space-between; align-items: center; }
    .source-link { font-size: 14px; color: var(--accent); text-decoration: none; }
    .source-link:hover { text-decoration: underline; }
    .back-link {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--surface); color: var(--text-secondary); text-decoration: none;
      box-shadow: 0 1px 4px var(--shadow-sm);
      -webkit-tap-highlight-color: transparent;
    }
    .back-link:hover { color: var(--text); }
    .back-link svg { width: 20px; height: 20px; }
    .article-header .stats-bar { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-secondary); margin-top: 8px; }
    .stats-bar .stat { display: inline-flex; align-items: center; gap: 3px; }

    /* ---- GFM: Headings ---- */
    .article-content h1, .article-content h2, .article-content h3,
    .article-content h4, .article-content h5, .article-content h6 {
      margin: 28px 0 16px; line-height: 1.3; color: var(--text);
    }
    .article-content h1 { font-size: 1.7em; font-weight: 700; padding-bottom: 0; border-bottom: none; }
    .article-content h2 { font-size: 1.4em; font-weight: 600; padding-bottom: 0; border-bottom: none; }
    .article-content h3 { font-size: 1.2em; font-weight: 600; }
    .article-content h4 { font-size: 1.05em; font-weight: 600; }
    .article-content h5 { font-size: 1em; font-weight: 600; }
    .article-content h6 { font-size: 0.95em; font-weight: 600; color: var(--text-secondary); }

    /* ---- GFM: Lists ---- */
    .article-content ul, .article-content ol { padding-left: 1.75em; margin-bottom: 0.8em; }
    .article-content li { margin-bottom: 8px; }
    .article-content li > ul, .article-content li > ol { margin-bottom: 0; margin-top: 4px; }
    .article-content ul { list-style-type: disc; }
    .article-content ul ul { list-style-type: circle; }
    .article-content ul ul ul { list-style-type: square; }

    /* ---- GFM: Task lists ---- */
    .article-content input[type="checkbox"] { margin-right: 8px; accent-color: var(--accent); }

    /* ---- GFM: Code ---- */
    .article-content code {
      font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
      background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.9em;
      color: var(--code-color);
    }
    .article-content pre {
      background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px;
      overflow-x: auto; margin-bottom: 0.8em; line-height: 1.5;
    }
    .article-content pre code {
      background: none; padding: 0; border-radius: 0; color: inherit; font-size: 0.85em;
    }
    /* WeChat code-snippet (legacy HTML before normalizeWechatCodeSnippets):
       hide line-number <ul><li> discs and force each <code> line onto its own row */
    .article-content .code-snippet__line-index,
    .article-content ul.code-snippet__line-index {
      display: none !important;
      list-style: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    .article-content .code-snippet__fix {
      margin: 0 0 0.8em;
      overflow: hidden;
    }
    .article-content .code-snippet__fix pre,
    .article-content pre[class*="code-snippet"] {
      margin-bottom: 0;
    }
    .article-content .code-snippet__fix pre > code,
    .article-content pre[class*="code-snippet"] > code {
      display: block;
      background: none;
      padding: 0;
      border-radius: 0;
      color: inherit;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ---- GFM: Blockquotes ---- */
    .article-content blockquote {
      margin: 0 0 1.1em; padding: 10px 16px; color: var(--text-secondary);
      border-left: 3px solid var(--accent); background: var(--surface); border-radius: 0 6px 6px 0;
    }
    .article-content blockquote p:last-child { margin-bottom: 0; }

    /* ---- GFM: Tables ---- */
    .article-content table { border-collapse: collapse; width: 100%; margin-bottom: 0.8em; font-size: 0.95em; }
    .article-content th, .article-content td {
      border: 1px solid var(--border); padding: 8px 12px; text-align: left;
    }
    .article-content th { background: var(--surface); font-weight: 600; }
    .article-content tr:nth-child(even) { background: var(--surface); }

    /* ---- GFM: Horizontal rule ---- */
    .article-content hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }

    @media (min-width: 769px) {
      .article-title { font-size: 30px; }
      .article-content { font-size: 18px; padding: 0 20px; }
      .article-content pre { padding: 16px; }
      .article-content pre code { font-size: 0.875em; }
      .article-header { padding: 0 20px; }
      .article-footer { padding: 0 20px; }
    }
    @media (max-width: 768px) and (min-width: 481px) {
      .article-content { font-size: 17.5px; }
    }
    @media (max-width: 480px) {
      .article-header { padding: 0 16px; }
      .article-content { padding: 0 16px; }
      .article-footer { padding: 0 16px; }
      .header-img { margin: 0 0 16px; }
      .article-title { font-size: 24px; }
      .article-content pre { padding: 12px; font-size: 0.825em; }
    }
    .share-menu-wrap { position: relative; display: inline-flex; align-items: center; }
    .share-btn {
      width: 32px; height: 32px; border: none; border-radius: 50%;
      background: transparent; color: var(--text-secondary); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: all 0.2s; line-height: 0;
      -webkit-appearance: none; appearance: none;
      -webkit-tap-highlight-color: transparent;
    }
    .share-btn:hover { color: var(--text); }
    .share-menu {
      display: none; position: absolute; top: calc(100% + 6px); right: 0; z-index: 10050;
      min-width: 148px; padding: 6px 0;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: 0 8px 28px var(--shadow-md, rgba(0,0,0,0.12));
      overflow: hidden;
    }
    .share-menu.open { display: block; }
    .share-menu-item {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 12px 16px; border: none; background: transparent;
      color: var(--text); font-size: 14px; text-align: left; cursor: pointer;
      font-family: inherit; line-height: 1.3;
      -webkit-tap-highlight-color: transparent;
    }
    .share-menu-item:hover, .share-menu-item:active { background: var(--bg); }
    .share-menu-item svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--text-secondary); }
    .share-menu-backdrop {
      display: none; position: fixed; inset: 0; z-index: 10040; background: transparent;
    }
    .share-menu-backdrop.open { display: block; }
    .share-toast {
      position: fixed; left: 50%; bottom: max(48px, env(safe-area-inset-bottom));
      transform: translateX(-50%) translateY(12px); z-index: 11000;
      padding: 10px 18px; border-radius: 20px;
      background: rgba(0,0,0,0.82); color: #fff; font-size: 14px;
      opacity: 0; pointer-events: none; transition: opacity 0.2s, transform 0.2s;
      white-space: nowrap;
    }
    .share-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    [data-theme="dark"] .share-toast { background: rgba(255,255,255,0.92); color: #111; }
    .share-overlay {
      display: none; position: fixed; inset: 0; z-index: 10000;
      background: rgba(0,0,0,0.6); flex-direction: column;
      justify-content: center; align-items: center;
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    }
    .share-preview {
      background: var(--surface); border-radius: 12px;
      width: calc(100vw - 32px); max-width: 420px; max-height: 85vh;
      display: flex; flex-direction: column;
      box-shadow: 0 16px 48px rgba(0,0,0,0.3);
    }
    .share-preview-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 16px 20px; border-bottom: 1px solid var(--border);
    }
    .share-close-btn {
      width: 28px; height: 28px; border: none; border-radius: 50%;
      background: transparent; color: var(--text-secondary); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .share-close-btn:hover { color: var(--text); }
    .share-preview-body {
      flex: 1; overflow-y: auto; padding: 12px;
      display: flex; justify-content: center; align-items: flex-start;
    }
    .share-preview-body img { width: 100%; height: auto; border-radius: 4px; }
    .share-loading {
      display: flex; align-items: center; gap: 8px;
      padding: 40px 0; color: var(--text-secondary); font-size: 14px;
    }
    .share-preview-footer {
      padding: 16px 20px; border-top: 1px solid var(--border);
      display: flex; justify-content: center;
    }
    .share-save-btn {
      padding: 10px 32px; border: none; border-radius: 20px;
      background: var(--accent); color: #fff; font-size: 15px;
      cursor: pointer; font-weight: 500; transition: opacity 0.2s;
    }
    .share-save-btn:hover { opacity: 0.85; }
    .share-save-btn:disabled { opacity: 0.4; cursor: default; }
    .theme-btn:focus-visible,
    .refresh-btn:focus-visible,
    .share-btn:focus-visible,
    .share-menu-item:focus-visible,
    .back-link:focus-visible,
    .share-save-btn:focus-visible,
    .share-close-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .ask-ai-btn {
      position: fixed; bottom: 24px; right: 20px; z-index: 9999;
      width: 46px; height: 46px; border-radius: 50%;
      border: none;
      background: var(--ai-fab-bg);
      color: var(--ai-fab-fg);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: var(--ai-fab-shadow);
      backdrop-filter: blur(14px) saturate(1.15);
      -webkit-backdrop-filter: blur(14px) saturate(1.15);
      transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1),
                  box-shadow 0.2s ease, background 0.2s ease, color 0.2s ease;
      -webkit-tap-highlight-color: transparent;
      text-decoration: none;
    }
    .ask-ai-btn:hover {
      transform: translateY(-2px);
      box-shadow: var(--ai-fab-shadow-hover);
    }
    .ask-ai-btn:active { transform: translateY(0) scale(0.96); }
    .ask-ai-btn:focus-visible { outline: 2px solid var(--ai-fab-fg); outline-offset: 3px; }
    .ask-ai-btn svg { width: 22px; height: 22px; display: block; }
    @media (max-width: 480px) {
      .ask-ai-btn { bottom: 20px; right: 14px; width: 44px; height: 44px; }
      .ask-ai-btn svg { width: 20px; height: 20px; }
    }
    /* ---- Image lightbox ---- */
    .img-lightbox {
      position: fixed; inset: 0; z-index: 20000;
      background: #000; display: none;
      flex-direction: column; justify-content: center; align-items: center;
      overflow: hidden; touch-action: none;
    }
    .img-lightbox.show { display: flex; }
    .img-lightbox-track {
      display: flex; height: 100%; width: 100%;
      transition: transform 0.25s ease;
      will-change: transform;
    }
    .img-lightbox-item {
      flex: 0 0 100%; height: 100%;
      display: flex; justify-content: center; align-items: center;
      position: relative;
    }
    .img-lightbox-item img {
      max-width: 100%; max-height: 100%;
      object-fit: contain;
      user-select: none; -webkit-user-drag: none;
      -webkit-tap-highlight-color: transparent;
    }
    .img-lightbox-close {
      position: absolute; top: max(12px, env(safe-area-inset-top)); right: 16px; z-index: 20001;
      width: 40px; height: 40px; border: none; border-radius: 50%;
      background: rgba(255,255,255,0.15); color: #fff; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    .img-lightbox-close:hover { background: rgba(255,255,255,0.25); }
    .img-lightbox-close svg { width: 22px; height: 22px; }
    .img-lightbox-counter {
      position: absolute; top: max(20px, env(safe-area-inset-top)); left: 0; right: 0;
      text-align: center; color: rgba(255,255,255,0.85); font-size: 14px;
      pointer-events: none; z-index: 20001;
    }
    .img-lightbox-hint {
      position: absolute; bottom: max(24px, env(safe-area-inset-bottom)); left: 0; right: 0;
      text-align: center; color: rgba(255,255,255,0.45); font-size: 12px;
      pointer-events: none; z-index: 20001;
    }
  </style>
</head>
<body>
<div class="page-wrapper">
<div class="container">
    <div class="top-bar">
    <a href="/" class="back-link" title="返回列表" onclick="history.length>1?history.back():null;return false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12H6"/><path d="M12 5l-7 7 7 7"/></svg>
    </a>
    <div style="display:flex;align-items:center;gap:4px;">
      <div class="share-menu-wrap">
        <span class="share-btn" id="shareBtn" onclick="toggleShareMenu(event)" title="分享" role="button" aria-haspopup="menu" aria-expanded="false">${ICONS.share}</span>
        <div class="share-menu" id="shareMenu" role="menu" aria-label="分享选项">
          <button type="button" class="share-menu-item" role="menuitem" onclick="copyArticleLink()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            复制链接
          </button>
          <button type="button" class="share-menu-item" role="menuitem" onclick="shareAsLongImage()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            分享长图
          </button>
        </div>
      </div>
      <button class="theme-btn" onclick="toggleTheme()" title="切换主题">
        <svg id="theme-icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        <svg id="theme-icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
      </button>
    </div>
    <div class="share-menu-backdrop" id="shareMenuBackdrop" onclick="closeShareMenu()" aria-hidden="true"></div>
    <div class="share-toast" id="shareToast" role="status" aria-live="polite"></div>
  </div>
    <article class="article-card">
      ${headerImgHtml}

      <header class="article-header">
        <h1 class="article-title">${escapeHtml(title)}</h1>
        <div class="article-meta">
          ${tweet.author.avatar_url ? `<img src="${escapeHtml(tweet.author.avatar_url)}" alt="" class="avatar" loading="lazy" />` : ''}
          <div class="author-info">
            <span class="author-name">${escapeHtml(tweet.author.name)}</span>
            <span class="author-handle">${(isWechat || isWebpage) ? escapeHtml(tweet.author.screen_name) : '@' + escapeHtml(tweet.author.screen_name)}</span>
          </div>
          <span class="divider">|</span>
          <span class="date">${dateStr}</span>
        </div>
        ${(Number(tweet.likes) > 0 || Number(tweet.retweets) > 0 || Number(tweet.replies) > 0) ? `<div class="stats-bar">
          <span class="stat">${ICONS.comment}<span>${tweet.replies.toLocaleString()}</span></span>
          <span class="stat">${ICONS.repost}<span>${tweet.retweets.toLocaleString()}</span></span>
          <span class="stat">${ICONS.like}<span>${tweet.likes.toLocaleString()}</span></span>
        </div>` : ''}
      </header>
      <div class="article-content">${contentHtml}</div>
      <div class="article-footer">
        <a href="${escapeHtml(tweet.url)}" class="source-link" target="_blank" rel="noopener">原文：${escapeHtml(tweet.url)}</a>
      </div>
    </article>
<div class="share-overlay" id="shareOverlay" style="display:none">
  <div class="share-preview">
    <div class="share-preview-header">
      <span style="font-size:15px;font-weight:600;color:var(--text)">分享长图</span>
      <button class="share-close-btn" onclick="closeSharePreview()" title="关闭">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="share-preview-body" id="sharePreviewBody">
      <div class="share-loading"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> 正在生成预览...</div>
    </div>
    <div class="share-preview-footer">
      <button class="share-save-btn" id="shareSaveBtn" onclick="saveShareImage()" disabled>保存图片</button>
    </div>
  </div>
</div>
<div class="img-lightbox" id="imgLightbox">
  <div class="img-lightbox-counter" id="imgLightboxCounter"></div>
  <button class="img-lightbox-close" onclick="closeImgLightbox()" aria-label="关闭">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </button>
  <div class="img-lightbox-track" id="imgLightboxTrack"></div>
  <div class="img-lightbox-hint">左右滑动切换 · 下拉关闭</div>
</div>
<script>
// Disable pinch-zoom and page-level horizontal swipe, keep vertical scroll
(function() {
  var lastTouchEnd = 0;
  document.addEventListener('touchstart', function(e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', function(e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', function(e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, false);
  document.addEventListener('gesturestart', function(e) { e.preventDefault(); });
  document.addEventListener('gesturechange', function(e) { e.preventDefault(); });
  document.addEventListener('gestureend', function(e) { e.preventDefault(); });
})();
var title = "${escapeHtml(title)}";
var _shareImageDataUrl = null;
var _html2canvasLoaded = false;
var _shareToastTimer = 0;
function _loadHtml2canvas(callback) {
  if (_html2canvasLoaded) { callback(); return; }
  if (typeof html2canvas !== 'undefined') { _html2canvasLoaded = true; callback(); return; }
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
  s.onload = function() { _html2canvasLoaded = true; callback(); };
  s.onerror = function() {
    var pb = document.getElementById('sharePreviewBody');
    if (pb) pb.innerHTML = '<div class="share-loading" style="color:#fa5151">截图库加载失败，请检查网络后刷新重试</div>';
  };
  document.head.appendChild(s);
}
function showShareToast(msg) {
  var t = document.getElementById('shareToast');
  if (!t) return;
  t.textContent = msg || '';
  t.classList.add('show');
  clearTimeout(_shareToastTimer);
  _shareToastTimer = setTimeout(function() { t.classList.remove('show'); }, 1600);
}
function toggleShareMenu(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  var menu = document.getElementById('shareMenu');
  if (!menu) return;
  if (menu.classList.contains('open')) closeShareMenu();
  else openShareMenu();
}
function openShareMenu() {
  var menu = document.getElementById('shareMenu');
  var backdrop = document.getElementById('shareMenuBackdrop');
  var btn = document.getElementById('shareBtn');
  if (menu) menu.classList.add('open');
  if (backdrop) backdrop.classList.add('open');
  if (btn) btn.setAttribute('aria-expanded', 'true');
}
function closeShareMenu() {
  var menu = document.getElementById('shareMenu');
  var backdrop = document.getElementById('shareMenuBackdrop');
  var btn = document.getElementById('shareBtn');
  if (menu) menu.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
function copyArticleLink() {
  var url = window.location.href.split('#')[0];
  closeShareMenu();
  function ok() { showShareToast('链接已复制'); }
  function fail() {
    try {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var copied = document.execCommand('copy');
      document.body.removeChild(ta);
      if (copied) { ok(); return; }
    } catch (err) {}
    showShareToast('复制失败，请手动复制地址栏');
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(ok).catch(fail);
  } else {
    fail();
  }
}
function shareAsLongImage() {
  closeShareMenu();
  openSharePreview();
}
function openSharePreview() {
  var overlay = document.getElementById('shareOverlay');
  if (!overlay) return;
  closeShareMenu();
  overlay.style.display = 'flex';
  var previewBody = document.getElementById('sharePreviewBody');
  if (!previewBody) return;
  previewBody.innerHTML = '<div class="share-loading">正在生成预览...</div>';
  var saveBtn = document.getElementById('shareSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  _loadHtml2canvas(function() {
    var card = document.querySelector('.article-card');
    if (!card) { previewBody.innerHTML = '<div class="share-loading" style="color:#fa5151">未找到文章内容</div>'; return; }
    var bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f5f5f5';
    html2canvas(card, {
      backgroundColor: bgColor,
      scale: 2,
      useCORS: true,
      logging: false
    }).then(function(canvas) {
      _shareImageDataUrl = canvas.toDataURL('image/png');
      previewBody.innerHTML = '<img src="' + _shareImageDataUrl + '" alt="预览" style="width:100%;height:auto;display:block">';
      var btn = document.getElementById('shareSaveBtn');
      if (btn) btn.disabled = false;
    }).catch(function(err) {
      previewBody.innerHTML = '<div class="share-loading" style="color:#fa5151">生成预览失败，请重试</div>';
    });
  });
}
function closeSharePreview() {
  var overlay = document.getElementById('shareOverlay');
  if (overlay) overlay.style.display = 'none';
  var previewBody = document.getElementById('sharePreviewBody');
  if (previewBody) previewBody.innerHTML = '<div class="share-loading">正在生成预览...</div>';
  var saveBtn = document.getElementById('shareSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  _shareImageDataUrl = null;
}
function saveShareImage() {
  if (!_shareImageDataUrl) return;
  var filename = title.substring(0, 40).replace(/[^a-zA-Z0-9_-]/g, '') + '.png';
  var a = document.createElement('a');
  a.href = _shareImageDataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
(function(){
  var t=localStorage.getItem('theme');
  if(t) document.documentElement.setAttribute('data-theme',t);
  else if(window.matchMedia('(prefers-color-scheme:dark)').matches) document.documentElement.setAttribute('data-theme','dark');
  updateThemeIcon();
})();
function refreshPage(btn) {
  if (btn && btn.classList) {
    btn.classList.add('spinning');
    setTimeout(function() { location.reload(); }, 180);
  } else {
    location.reload();
  }
}
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
  var hlLight = document.getElementById('hl-theme-light');
  var hlDark = document.getElementById('hl-theme-dark');
  if (hlLight) hlLight.disabled = isDark;
  if (hlDark) hlDark.disabled = !isDark;
}
// Set AI button href + prefetch recommended questions while user reads article
(function() {
  function setAiHref() {
    var ctx = decodeURIComponent(window.location.pathname).replace(/^\\/articles\\//, '');
    var btn = document.getElementById('askAiBtn');
    if (btn && ctx) btn.href = '/qa?context=' + encodeURIComponent(ctx) + '&new=1';
    // Warm suggestions cache so /qa?context=… opens with questions ready
    if (ctx && !window.__qaSuggestPrefetched) {
      window.__qaSuggestPrefetched = true;
      try {
        fetch('/api/qa/suggestions?context=' + encodeURIComponent(ctx), {
          credentials: 'same-origin',
          cache: 'no-store'
        }).catch(function() {});
      } catch (e) {}
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setAiHref);
  } else {
    setAiHref();
  }
})();
// ---- Image lightbox ----
(function() {
  var lightbox = document.getElementById('imgLightbox');
  var track = document.getElementById('imgLightboxTrack');
  var counter = document.getElementById('imgLightboxCounter');
  var images = [];
  var current = 0;
  var startX = 0, startY = 0, currentX = 0, currentY = 0;
  var isDragging = false;
  var startTime = 0;

  function openImgLightbox(index) {
    if (!images.length) return;
    current = Math.max(0, Math.min(index, images.length - 1));
    render();
    lightbox.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  window.closeImgLightbox = function() {
    lightbox.classList.remove('show');
    document.body.style.overflow = '';
  };

  function render() {
    track.innerHTML = images.map(function(src) {
      return '<div class="img-lightbox-item"><img src="' + src + '" alt=""></div>';
    }).join('');
    updateTransform();
  }

  function updateTransform() {
    track.style.transform = 'translateX(-' + (current * 100) + '%)';
    counter.textContent = (current + 1) + ' / ' + images.length;
  }

  function goTo(idx) {
    current = Math.max(0, Math.min(idx, images.length - 1));
    updateTransform();
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    isDragging = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentX = 0;
    currentY = 0;
    startTime = Date.now();
    track.style.transition = 'none';
  }

  function onTouchMove(e) {
    if (!isDragging || e.touches.length !== 1) return;
    var x = e.touches[0].clientX;
    var y = e.touches[0].clientY;
    currentX = x - startX;
    currentY = y - startY;
    var offset = -current * window.innerWidth + currentX;
    track.style.transform = 'translateX(' + offset + 'px)';
    var item = track.children[current];
    if (item) item.style.transform = 'translateY(' + currentY + 'px)';
  }

  function onTouchEnd(e) {
    if (!isDragging) return;
    isDragging = false;
    var item = track.children[current];
    if (item) item.style.transform = '';

    // Pull down to close
    if (currentY > 120 && Math.abs(currentX) < Math.abs(currentY)) {
      window.closeImgLightbox();
      track.style.transition = 'transform 0.25s ease';
      updateTransform();
      return;
    }

    track.style.transition = 'transform 0.25s ease';
    var elapsed = Date.now() - startTime;
    var threshold = window.innerWidth * 0.2;
    if (Math.abs(currentX) > threshold || (Math.abs(currentX) > 30 && elapsed < 300)) {
      if (currentX > 0) goTo(current - 1);
      else goTo(current + 1);
    } else {
      updateTransform();
    }
  }

  function init() {
    var imgs = document.querySelectorAll('.article-content img, .header-img');
    images = [];
    imgs.forEach(function(img) {
      if (img.classList.contains('avatar')) return;
      var src = img.getAttribute('src');
      if (src && images.indexOf(src) === -1) images.push(src);
    });
    imgs.forEach(function(img) {
      if (img.classList.contains('avatar')) return;
      img.style.cursor = 'pointer';
      img.addEventListener('click', function() {
        var src = img.getAttribute('src');
        var idx = images.indexOf(src);
        openImgLightbox(idx >= 0 ? idx : 0);
      });
    });
  }

  lightbox.addEventListener('touchstart', onTouchStart, { passive: true });
  lightbox.addEventListener('touchmove', onTouchMove, { passive: true });
  lightbox.addEventListener('touchend', onTouchEnd);
  lightbox.addEventListener('click', function(e) {
    if (e.target === lightbox || e.target === track) window.closeImgLightbox();
  });

  document.addEventListener('keydown', function(e) {
    if (!lightbox.classList.contains('show')) return;
    if (e.key === 'Escape') window.closeImgLightbox();
    if (e.key === 'ArrowLeft') goTo(current - 1);
    if (e.key === 'ArrowRight') goTo(current + 1);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
<a href="/qa" class="ask-ai-btn" title="问 AI" aria-label="问 AI" id="askAiBtn"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="aiSpark" x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#6366f1"/><stop offset="55%" stop-color="currentColor"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs><path d="M12 1.2l2.55 6.75 6.75 2.55-6.75 2.55L12 19.8l-2.55-6.75L2.7 10.5l6.75-2.55L12 1.2z" fill="url(#aiSpark)"/><path d="M19.2 15.1l1.25 3.15 3.15 1.25-3.15 1.25-1.25 3.15-1.25-3.15-3.15-1.25 3.15-1.25 1.25-3.15z" fill="url(#aiSpark)" opacity="0.88"/></svg></a>
</div>
</div>
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
  sourceType?: 'twitter' | 'wechat' | 'webpage';
  pinned?: boolean;
  pinnedAt?: number;
  unread?: boolean;
  likes?: number;
  retweets?: number;
  replies?: number;
}

const META_FILE = path.join(DATA_DIR, 'meta.json');
const BLOCKED_FILE = path.join(DATA_DIR, 'blocked.txt');

export function loadBlockedUrls(): Set<string> {
  if (!fs.existsSync(BLOCKED_FILE)) return new Set();
  try {
    return new Set(fs.readFileSync(BLOCKED_FILE, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean));
  } catch { return new Set(); }
}

function saveBlockedUrl(url: string) {
  const blocked = loadBlockedUrls();
  blocked.add(url);
  fs.writeFileSync(BLOCKED_FILE, [...blocked].join('\n') + '\n', 'utf-8');
}

export function loadMeta(): ArticleMeta[] {
  if (!fs.existsSync(META_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); }
  catch { return []; }
}

export function saveMeta(meta: ArticleMeta[]) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

export async function togglePin(fileName: string, pin: boolean) {
  const meta = loadMeta();
  const idx = meta.findIndex(m => m.fileName === fileName);
  if (idx >= 0) {
    meta[idx].pinned = pin;
    meta[idx].pinnedAt = pin ? Date.now() : 0;
    saveMeta(meta);
    await rebuildIndex();
    return true;
  }
  return false;
}

export async function markRead(fileName: string) {
  const meta = loadMeta();
  const idx = meta.findIndex(m => m.fileName === fileName);
  if (idx >= 0 && meta[idx].unread) {
    meta[idx].unread = false;
    saveMeta(meta);
    await rebuildIndex();
    return true;
  }
  return false;
}

export async function markUnread(fileName: string) {
  const meta = loadMeta();
  const idx = meta.findIndex(m => m.fileName === fileName);
  if (idx >= 0) {
    meta[idx].unread = true;
    saveMeta(meta);
    await rebuildIndex();
    return true;
  }
  return false;
}

export async function deleteArticle(fileName: string): Promise<boolean> {
  const htmlPath = path.join(ARTICLES_DIR, fileName);
  if (fs.existsSync(htmlPath)) {
    // Also delete associated images
    const base = fileName.replace('.html', '');
    const images = fs.readdirSync(IMAGES_DIR).filter(f => f.startsWith(base));
    images.forEach(f => {
      fs.unlinkSync(path.join(IMAGES_DIR, f));
    });
    fs.unlinkSync(htmlPath);
    // Remove from search index
    try { deleteSearchArticle(fileName); } catch (err) {
      console.error('[deleteArticle] Search index delete failed:', err instanceof Error ? err.message : err);
    }
    // Remove from meta & add to blocked list
    const meta = loadMeta();
    const entry = meta.find(m => m.fileName === fileName);
    if (entry?.tweetUrl) saveBlockedUrl(entry.tweetUrl);
    saveMeta(meta.filter(m => m.fileName !== fileName));
    await rebuildIndex();
    return true;
  }
  return false;
}

function renderIndexHtml(
  articlesBySaved: ArticleMeta[],
  articlesByTweet: ArticleMeta[]
): string {
  const buildList = (articles: ArticleMeta[]) =>
    articles.map((a) => {
      // Normalize before escape so stacked &amp;amp; in meta never double-escapes on index
      const plainTitle = normalizeScrapedText(a.title || '');
      const plainAuthor = normalizeAuthorField(a.author || '');
      const displayTitle = plainTitle.length > 80 ? plainTitle.substring(0, 80) + '...' : plainTitle;
      const pinnedBadge = a.pinned ? '<span class="pinned-badge">置顶</span>' : '';
      const unreadDot = a.unread ? '<span class="unread-dot"></span>' : '';
      const id = a.fileName.replace(/\.html$/, '');
      return `
          <li class="article-item${a.pinned ? ' pinned' : ''}" id="item-${escapeHtml(id)}">
            <div class="swipe-wrap">
              <div class="item-row swipe-content">
                <a href="articles/${a.fileName}" class="article-link" onclick="markReadNoRender('${escapeHtml(id)}')">
                  <div class="article-title-wrap">
                    ${escapeHtml(displayTitle)}
                    ${pinnedBadge}
                  </div>
                  <div class="article-meta">
                    <img src="${escapeHtml(a.authorAvatar || 'https://unavatar.io/x/' + a.authorHandle)}" alt="" class="meta-avatar" loading="lazy" />
                    <span class="meta-author">${escapeHtml(plainAuthor)}</span>
                    <span class="meta-time">收藏于 ${a.savedDate.substring(5)} · 更新于 ${a.tweetDate.substring(5)}</span>
                  </div>
                  ${(a.sourceType !== 'wechat' && a.sourceType !== 'webpage' && (Number(a.replies) > 0 || Number(a.retweets) > 0 || Number(a.likes) > 0)) ? `<div class="article-stats">
                    <span class="stat">${ICONS.comment}<span>${(a.replies||0)}</span></span>
                    <span class="stat">${ICONS.repost}<span>${(a.retweets||0)}</span></span>
                    <span class="stat">${ICONS.like}<span>${(a.likes||0)}</span></span>
                  </div>` : ''}
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
                <button class="swipe-btn pin" onclick="event.stopPropagation(); pinItem('${escapeHtml(id)}', ${a.pinned ? 'false' : 'true'})">${a.pinned ? '取消置顶' : '置顶'}</button>
                <button class="swipe-btn read" onclick="event.stopPropagation(); ${a.unread ? `markRead('${escapeHtml(id)}')` : `markUnread('${escapeHtml(id)}')`}">${a.unread ? '标为已读' : '标为未读'}</button>
                ${a.tweetUrl ? `<button class="swipe-btn source" onclick="event.stopPropagation(); window.open('${escapeHtml(a.tweetUrl)}', '_blank')">原文</button>` : ''}
                <button class="swipe-btn delete" onclick="event.stopPropagation(); deleteItem('${escapeHtml(id)}')">删除</button>
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
      sourceType: a.sourceType || 'twitter',
      pinned: !!a.pinned,
      pinnedAt: a.pinnedAt || 0,
      unread: !!a.unread,
      likes: a.likes || 0,
      retweets: a.retweets || 0,
      replies: a.replies || 0,
    }))
  );

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0f0f0f" media="(prefers-color-scheme: dark)">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="icon" type="image/png" href="/favicon.png?v=3" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=3" />
  <title>开卷有益</title>
  <style>
    :root {
      --bg: #f5f5f5; --surface: #fff; --text: #1a1a1a;
      --text-secondary: #888; --text-tertiary: #aaa;
      --accent: #5a5a5a; --accent-bg: #f0f0f0;
      --border: #eee; --shadow-sm: rgba(0,0,0,0.05); --shadow-md: rgba(0,0,0,0.1);
      --code-bg: #f2f2f2; --code-color: #d63384;
      --sidebar-w: min(260px, 82vw);
    }
    [data-theme="dark"] {
      --bg: #0f0f0f; --surface: #1a1a1a; --text: #e8e8e8;
      --text-secondary: #b0b0b0; --text-tertiary: #888;
      --accent: #b0b0b0; --accent-bg: #2a2a2a;
      --border: #3a3a3a; --shadow-sm: rgba(0,0,0,0.3); --shadow-md: rgba(0,0,0,0.4);
      --code-bg: #2d2d2d; --code-color: #ff8fab;
    }
    [data-theme="dark"] .sort-btn.active,
    [data-theme="dark"] .sort-btn.active:hover,
    [data-theme="dark"] .sort-btn.active:focus,
    [data-theme="dark"] .sort-btn.active:active {
      background: var(--accent-bg); color: var(--accent); border-color: var(--accent-bg);
    }
    @keyframes skeleton-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.7; } }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: var(--bg); }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg); color: var(--text); min-height: 100vh; min-height: 100dvh;
      -webkit-font-smoothing: antialiased; transition: background 0.3s ease, color 0.3s ease;
      line-height: 1.7;
    }
    body.sidebar-open { overflow: hidden; }
    /* Do NOT display:none nav — reflows list mid-animation (jank vs QA). */
    .page-wrapper { overflow-x: hidden; position: relative; min-height: 100vh; min-height: 100dvh; }
    .container { max-width: 740px; margin: 0 auto; padding: 0 16px 40px; }
    /* Solid nav bar for flush top on iOS Safari */
    .nav-bar {
      position: sticky; top: 0; z-index: 50;
      display: flex; flex-direction: column; gap: 4px;
      padding: max(8px, env(safe-area-inset-top)) 16px 10px;
      margin-bottom: 12px;
      background: var(--bg);
      border: none;
      box-shadow: none;
      -webkit-transform: translateZ(0);
      transform: translateZ(0);
    }
    .nav-bar::before {
      content: '';
      position: absolute;
      left: 0; right: 0;
      bottom: 100%;
      height: 200px;
      background: inherit;
      pointer-events: none;
    }
    .nav-bar .nav-row1 { display: flex; align-items: center; gap: 8px; }
    .nav-bar .nav-row2 { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
    .nav-bar .nav-title { font-size: 20px; font-weight: 700; color: var(--text); white-space: nowrap; }
    /* Align count with title text (hamburger 36px + row gap 8px), not with menu button */
    .nav-bar .nav-count {
      font-size: 13px; color: var(--text-secondary); white-space: nowrap;
      margin-left: 44px;
    }
    .hamburger {
      width: 36px; height: 36px; border: none; border-radius: 50%; flex-shrink: 0;
      background: var(--surface); color: var(--text-secondary); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 1px 4px var(--shadow-sm);
      -webkit-tap-highlight-color: transparent;
    }
    .hamburger:hover { color: var(--text); }
    .hamburger svg { width: 18px; height: 18px; }
    .sort-buttons { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
    .header-controls { display: flex; gap: 8px; align-items: center; flex-shrink: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .theme-btn, .refresh-btn {
      width: 32px; height: 32px; border: none; border-radius: 50%; flex-shrink: 0;
      background: transparent; color: var(--text-secondary); cursor: pointer;
      display: flex; align-items: center; justify-content: center; transition: all 0.2s;
    }
    .theme-btn:hover, .refresh-btn:hover { color: var(--text); }
    /* Solid chips only — no hollow border that paints before fill */
    .sort-btn {
      padding: 5px 10px;
      border: 1px solid transparent;
      border-radius: 14px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      outline: none;
      white-space: nowrap;
      transition: none !important;
      -webkit-tap-highlight-color: transparent;
      -webkit-appearance: none;
      appearance: none;
    }
    .sort-btn:hover:not(.active),
    .sort-btn:focus:not(.active),
    .sort-btn:active:not(.active) {
      border-color: transparent;
      color: var(--text);
      background: var(--accent-bg);
    }
    .sort-btn.active,
    .sort-btn.active:hover,
    .sort-btn.active:focus,
    .sort-btn.active:active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
      transition: none !important;
    }
    .search-input {
      padding: 5px 10px; border: 1px solid var(--border); border-radius: 14px;
      background: transparent; color: var(--text); font-size: 13px;
      width: 140px; outline: none; transition: all 0.2s;
    }
    .search-input::placeholder { color: var(--text-tertiary); font-size: 12px; }
    .search-input:focus { border-color: var(--accent); width: 160px; }
    .article-list { list-style: none; }
    .article-item {
      background: var(--surface); border-radius: 16px; margin-bottom: 12px;
      box-shadow: 0 1px 3px var(--shadow-sm);
      transition: transform 0.2s ease, box-shadow 0.2s ease; position: relative;
      overflow: hidden;
    }
    .article-item:hover { transform: translateY(-2px) scale(1.005); box-shadow: 0 8px 24px var(--shadow-md); }
    .article-item:active { background: rgba(128,128,128,0.25); transition: background 0.05s; }
    .article-item.pinned { }
    .item-row { display: flex; align-items: flex-start; padding: 16px; }
    .meta-avatar {
      width: 18px; height: 18px; border-radius: 50%; object-fit: cover;
      flex-shrink: 0; background: var(--border);
    }
    .article-link {
      flex: 1; display: block; padding: 0;
      text-decoration: none; color: inherit; min-width: 0;
      -webkit-tap-highlight-color: transparent;
      outline: none;
    }
    .article-link:focus { outline: none; }
    .article-link:active { background: transparent; }
    .article-title-wrap {
      font-size: 17px; font-weight: 700; color: var(--text);
      margin-bottom: 6px; line-height: 1.5;
      display: flex; align-items: center; gap: 8px;
    }
    .pinned-badge {
      font-size: 11px; font-weight: 500; color: var(--accent);
      background: var(--accent-bg); padding: 1px 8px; border-radius: 6px; flex-shrink: 0;
    }
    .article-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 13px; margin-bottom: 6px; }
    .meta-author { color: var(--text); font-weight: 500; }
    .meta-time { color: var(--text-secondary); }
    .article-stats { display: flex; gap: 16px; font-size: 12px; color: var(--text-tertiary); margin-bottom: 6px; }
    .stat { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; color: var(--text-secondary); }
    .stat svg { flex-shrink: 0; opacity: 0.7; }
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
      background: var(--surface); border-radius: 16px; padding: 60px 24px;
      text-align: center; color: var(--text-secondary); font-size: 15px;
      box-shadow: 0 1px 3px var(--shadow-sm);
    }
    /* ---- Swipe actions (mobile) ---- */
    .swipe-wrap { position: relative; overflow: hidden; touch-action: pan-y; -webkit-touch-callout: none; background: var(--surface); }
    .swipe-content { position: relative; z-index: 2; background: var(--surface); transition: transform 0.25s ease; width: 100%; }
    .swipe-actions {
      display: none;
      position: absolute;
      right: 0; top: 0; bottom: 0;
      align-items: stretch;
      z-index: 3;
      transform: translateX(100%);
      transition: transform 0.25s ease;
    }
    .swipe-btn {
      border: none; padding: 0 14px; font-size: 13px; color: #fff;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      white-space: nowrap;
    }
    .swipe-btn.pin { background: #5a5a5a; }
    .swipe-btn.read { background: #7d93ad; }
    .swipe-btn.source { background: #888; }
    .swipe-btn.delete { background: #fa5151; }
    /* 刷新路径占满 viewBox，比太阳略「显大」→ 用 15px 对齐视觉重量 */
    .refresh-btn svg { width: 15px; height: 15px; }
    .refresh-btn.spinning svg { animation: refresh-spin 0.6s linear; }
    @keyframes refresh-spin { to { transform: rotate(360deg); } }
    @media (max-width: 480px) {
      .nav-bar { padding: max(4px, env(safe-area-inset-top)) 12px 8px; }
      .nav-bar .nav-title { font-size: 17px; }
      .nav-bar .nav-count { font-size: 12px; }
      .sort-btn { padding: 4px 8px; font-size: 11px; }
      .article-link { padding: 16px 0 16px 16px; }
      .item-actions { padding: 16px 12px 16px 4px; }
      .more-btn { display: none; }
    }
    @media (min-width: 481px) {
      .swipe-actions { display: none !important; }
    }
    .theme-btn:focus-visible,
    .refresh-btn:focus-visible,
    .sort-btn:focus-visible,
    .more-btn:focus-visible,
    .dropdown-item:focus-visible,
    .article-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    /*
     * Doubao-style drawer:
     * Outer shell full physical height incl. status bar; right edge continuous to top.
     * Safe-area only on .sidebar-inner. Overlay only to the right of shell.
     */
    .sidebar {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      width: var(--sidebar-w);
      top: calc(0px - env(safe-area-inset-top, 0px));
      height: calc(100% + env(safe-area-inset-top, 0px));
      height: calc(100dvh + env(safe-area-inset-top, 0px));
      height: calc(100svh + env(safe-area-inset-top, 0px));
      min-height: calc(100% + env(safe-area-inset-top, 0px));
      box-sizing: border-box;
      padding: 0;
      margin: 0;
      background: var(--surface);
      z-index: 1000;
      border: none;
      outline: none;
      /* Match QA: GPU transform only (never animate left/width/height) */
      -webkit-transform: translate3d(-100%, 0, 0);
      transform: translate3d(-100%, 0, 0);
      transition: transform 0.25s ease;
      will-change: transform;
      -webkit-backface-visibility: hidden;
      backface-visibility: hidden;
      box-shadow: 2px 0 16px var(--shadow-sm);
      overflow: visible;
    }
    .sidebar.open {
      -webkit-transform: translate3d(0, 0, 0);
      transform: translate3d(0, 0, 0);
    }
    .sidebar::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: -80px;
      height: 80px;
      background: var(--surface);
      pointer-events: none;
    }
    .sidebar-inner {
      position: relative;
      z-index: 1;
      height: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      /* extra space below status-bar time so 「导航」不贴系统时钟 */
      padding-top: calc(env(safe-area-inset-top, 0px) + 20px);
      padding-bottom: env(safe-area-inset-bottom, 0px);
      background: transparent;
    }
    .sidebar-overlay {
      position: fixed;
      top: calc(0px - env(safe-area-inset-top, 0px));
      right: 0;
      bottom: 0;
      left: var(--sidebar-w);
      width: auto;
      height: calc(100% + env(safe-area-inset-top, 0px));
      height: calc(100dvh + env(safe-area-inset-top, 0px));
      background: rgba(0, 0, 0, 0.45);
      z-index: 999;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
      border: none;
    }
    .sidebar-overlay.show {
      opacity: 1;
      pointer-events: auto;
    }
    .sidebar-header {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 8px 16px 16px;
      flex-shrink: 0;
      background: transparent;
      border: none;
    }
    .sidebar-header h3 { font-size: 18px; font-weight: 700; }
    .sidebar-search-wrap {
      position: relative;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .sidebar-search {
      width: 100%; padding: 8px 12px 8px 32px;
      border: 1px solid var(--border); border-radius: 10px;
      background: #fafafa; color: var(--text);
      font-size: 14px; outline: none; font-family: inherit;
      cursor: pointer;
      pointer-events: none;
    }
    [data-theme="dark"] .sidebar-search { background: #242424; }
    .sidebar-search::placeholder { color: var(--text-tertiary); }
    .sidebar-search:focus { border-color: var(--border); outline: none; }
    .sidebar-search-icon {
      position: absolute; left: 10px; top: 50%;
      transform: translateY(-50%);
      width: 16px; height: 16px; color: var(--text-tertiary);
      pointer-events: none;
    }
    .search-segment {
      padding: 10px 16px; color: var(--text-secondary); font-size: 12px;
      text-transform: uppercase; letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border); background: var(--surface);
    }
    .search-posts-btn {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px; border-bottom: 1px solid var(--border);
      cursor: pointer; transition: background 0.15s;
      color: var(--text); font-size: 14px;
    }
    .search-posts-btn:hover, .search-posts-btn:active { background: var(--bg); }
    .search-posts-btn svg { flex-shrink: 0; color: var(--accent); }
    .post-result-item {
      display: block; padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      text-decoration: none; color: inherit;
      transition: background 0.15s;
    }
    .post-result-item:hover, .post-result-item:active { background: var(--bg); }
    .post-result-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; color: var(--text); }
    .post-result-meta { font-size: 12px; color: var(--text-secondary); }
    .post-result-snippet {
      font-size: 13px; color: var(--text-secondary); margin-top: 4px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .post-result-snippet em { color: var(--accent); font-style: normal; font-weight: 600; }
    .sidebar-nav { flex: 1; overflow-y: auto; }
    .sidebar-nav a {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 16px; text-decoration: none; color: var(--text);
      font-size: 15px; transition: background 0.15s;
    }
    .sidebar-nav a:hover, .sidebar-nav a:active { background: var(--bg); }
    .sidebar-nav a.active { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
    .sidebar-nav a svg {
      width: 18px; height: 18px; flex-shrink: 0; color: var(--text-secondary);
    }
    .sidebar-nav a.active svg { color: var(--accent); }
  </style>
</head>
<body>
<div class="sidebar" id="sidebar">
  <div class="sidebar-inner">
    <div class="sidebar-header">
      <h3>导航</h3>
      <div class="sidebar-search-wrap" onclick="location.href='/search'" role="link" aria-label="搜索">
        <svg class="sidebar-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="sidebar-search" id="sidebarSearch" placeholder="搜索帖子和历史记录..." readonly tabindex="-1" aria-hidden="true">
      </div>
    </div>
    <div class="sidebar-list" id="sidebarList"></div>
    <nav class="sidebar-nav">
      <a href="/qa?new=1" onclick="closeSidebar()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        <span>知识问答</span>
      </a>
    </nav>
  </div>
</div>
<div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>
<div class="page-wrapper">
<!-- Nav bar -->
<div class="nav-bar" id="navBar">
  <div class="nav-row1">
    <button class="hamburger" onclick="openSidebar()" aria-label="菜单">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <div class="nav-title" style="flex:1">开卷有益</div>
    <button class="refresh-btn" type="button" onclick="refreshPage(this)" title="刷新" aria-label="刷新">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
    </button>
    <button class="theme-btn" onclick="toggleTheme()" title="切换主题" aria-label="切换主题">
      <svg id="theme-icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
      <svg id="theme-icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
    </button>
  </div>
  <div class="nav-row2">
    <div class="nav-count" id="count">共 ${articlesBySaved.length} 条</div>
    <div class="header-controls">
      <div class="sort-buttons">
        <button class="sort-btn active" onclick="sortBy('saved')" id="btn-saved">收藏</button>
        <button class="sort-btn" onclick="sortBy('tweet')" id="btn-tweet">更新</button>
        <button class="sort-btn" onclick="sortBy('unread')" id="btn-unread">未读</button>
      </div>
    </div>
  </div>
</div>
<div class="container">
    <ul class="article-list" id="article-list">
      ${articlesBySaved.length === 0 ? '<li class="empty">还没有保存的推文</li>' : savedList}
    </ul>
  </div>
  <script>
    let articlesData = ${dataJson};
    const originalArticlesData = articlesData.slice();
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
    // Re-render on bfcache restore so Read/Unread dots reflect current data
    window.addEventListener('pageshow', function(e) {
      if (e.persisted) renderList();
    });

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
        const isWechat = a.sourceType === 'wechat' || (a.tweetUrl && /mp\.weixin\.qq\.com|weixin\.qq\.com/.test(a.tweetUrl));
        const isWebpage = a.sourceType === 'webpage';
        const statsHtml = (!isWechat && !isWebpage && (Number(a.replies) > 0 || Number(a.retweets) > 0 || Number(a.likes) > 0))
          ? '<div class="article-stats"><span class="stat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' + (a.replies||0) + '</span><span class="stat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>' + (a.retweets||0) + '</span><span class="stat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>' + (a.likes||0) + '</span></div>'
          : '';
        var swipeActions = '<div class="swipe-actions"><button class="swipe-btn pin" onclick="event.stopPropagation(); pinItem(\\'' + id + '\\', ' + (a.pinned ? 'false' : 'true') + ')">' + pinLabel + '</button><button class="swipe-btn read" onclick="event.stopPropagation(); ' + (a.unread ? 'markRead(\\'' + id + '\\')' : 'markUnread(\\'' + id + '\\')') + '">' + (a.unread ? '标为已读' : '标为未读') + '</button>' + (a.tweetUrl ? '<button class="swipe-btn source" onclick="event.stopPropagation(); window.open(\\'' + a.tweetUrl + '\\', \\'_blank\\')">原文</button>' : '') + '<button class="swipe-btn delete" onclick="event.stopPropagation(); deleteItem(\\'' + id + '\\')">删除</button></div>';
        return '<li class="article-item' + (a.pinned ? ' pinned' : '') + '" id="item-' + id + '"><div class="swipe-wrap"><div class="item-row swipe-content"><a href="articles/' + a.fileName + '" class="article-link" onclick="markReadNoRender(\\'' + id + '\\')"><div class="article-title-wrap">' + a.title + pinnedBadge + '</div><div class="article-meta"><img src="' + avatarUrl + '" alt="" class="meta-avatar" loading="lazy" /><span class="meta-author">' + a.author + '</span><span class="meta-time">收藏于 ' + (a.savedDate || '').substring(5) + ' · 更新于 ' + a.tweetDate.substring(5) + '</span></div>' + statsHtml + '</a><div class="item-actions">' + unreadDot + '<div class="more-wrap"><button class="more-btn" onclick="toggleMenu(event, \\'' + id + '\\')">⋯</button><div class="dropdown-menu" id="menu-' + id + '"><div class="dropdown-item" onclick="pinItem(\\'' + id + '\\', ' + (a.pinned ? 'false' : 'true') + ')">' + pinLabel + '</div><div class="dropdown-item" onclick="' + (a.unread ? 'markRead(\\'' + id + '\\')' : 'markUnread(\\'' + id + '\\')') + '">' + (a.unread ? '标为已读' : '标为未读') + '</div>' + (a.tweetUrl ? '<div class="dropdown-item" onclick="window.open(\\'' + a.tweetUrl + '\\', \\'_blank\\')">查看原文</div>' : '') + '<div class="dropdown-item delete" onclick="deleteItem(\\'' + id + '\\')">删除</div></div></div></div></div>' + swipeActions + '</div></li>';
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
        setTimeout(renderList, 150);
      }
    }

    function markReadNoRender(id) {
      const item = articlesData.find(a => a.fileName === id + '.html');
      if (item && item.unread) {
        item.unread = false;
        // Immediately hide the red dot in DOM so it's gone on back-navigation
        var dot = document.querySelector('#item-' + id + ' .unread-dot');
        if (dot) dot.style.display = 'none';
        const data = JSON.stringify({ id: id + '.html' });
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/read', new Blob([data], { type: 'application/json' }));
        } else {
          fetch('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true });
        }
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

    // ---- Mobile swipe handling (WeChat-style) ----
    (function initSwipe() {
      var DAMPING = 1.0;
      var VERTICAL_RATIO = 1.2;
      var TRANSITION_DURATION = 2500;
      var TRANSITION_STYLE = 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
      var OVERSCROLL = 40;
      var CLICK_THRESHOLD = 20;
      var CLICK_TIME = 300;

      var startX = 0, startY = 0, startTime = 0;
      var currentX = 0, currentY = 0;
      var activeSwipeContent = null, activeSwipeActions = null;
      var isSwiping = false, isScrolling = false, isExpanded = false;
      var actionsWidth = 0;
      // Track which item is expanded so closeAllSwipes can check actual state
      var expandedContent = null;

      function getTranslateX(el) {
        var style = window.getComputedStyle(el).transform;
        if (!style || style === 'none') return 0;
        var match = style.match(/matrix\(([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^)]+)\)/);
        if (match) return parseFloat(match[5]);
        var match3d = style.match(/matrix3d\(([^)]+)\)/);
        if (match3d) {
          var values = match3d[1].split(',');
          return values.length >= 13 ? parseFloat(values[12]) : 0;
        }
        return 0;
      }

      function setTranslateX(el, offset, withTransition) {
        el.style.transition = withTransition ? TRANSITION_STYLE : 'none';
        el.style.transform = 'translateX(' + offset + 'px)';
      }

      function hideSwipeActions(actions) {
        if (!actions) return;
        if (actions._closing) return; // animation in progress
        actions.style.transition = TRANSITION_STYLE;
        void actions.offsetWidth;
        actions.style.transform = 'translateX(100%)';
        setTimeout(function() {
          if (actions.style.transform === 'translateX(100%)') actions.style.display = 'none';
        }, TRANSITION_DURATION);
      }

      function showSwipeActions(actions) {
        if (!actions) return;
        _cancelCloseAnim(actions);
        actions.style.display = 'flex';
        actions.style.transition = 'none';
        actions.style.transform = 'translateX(100%)';
        // force reflow
        void actions.offsetWidth;
      }

      function _parseTranslateX(el) {
        var computed = window.getComputedStyle(el).transform;
        if (!computed || computed === 'none') return 0;
        var m = computed.match(/matrix\(([^)]+)\)/);
        if (m) {
          var parts = m[1].split(',');
          return parseFloat(parts[4]) || 0;
        }
        var m3d = computed.match(/matrix3d\(([^)]+)\)/);
        if (m3d) {
          var p = m3d[1].split(',');
          return parseFloat(p[12]) || 0;
        }
        return 0;
      }

      function _startCloseAnim(actions) {
        if (!actions) return;
        _cancelCloseAnim(actions);
        actions._closing = true;
        actions.style.display = 'flex';
        // Safari may not start a CSS transition for changes made during
        // a touch event (touchend). Defer to the next macrotask so the
        // browser has fully exited the touch sequence.
        setTimeout(function() {
          if (!actions._closing) return;
          // Reset to visible position. Must use explicit '0px' — setting ''
          // reverts to the CSS default translateX(100%) = off-screen, so the
          // "animation" goes from 100%→100% = no change = no transition.
          actions.style.transition = 'none';
          actions.style.transform = 'translateX(0px)';
          void actions.offsetWidth;
          actions.style.transition = TRANSITION_STYLE;
          actions.style.transform = 'translateX(100%)';
          var tid;
          var handler = function() {
            clearTimeout(tid);
            actions.removeEventListener('transitionend', handler);
            actions._closing = false;
            actions.style.display = 'none';
          };
          actions.addEventListener('transitionend', handler);
          // Fallback: Safari may not fire transitionend; force cleanup after animation duration
          tid = setTimeout(handler, 400);
        }, 0);
      }

      function _cancelCloseAnim(actions) {
        if (!actions) return;
        actions._closing = false;
      }

      function closeAllSwipes() {
        if (isSwiping) return;
        // Check actual content position, not the isExpanded flag which
        // can get out of sync in Safari's event timing.
        if (expandedContent && getTranslateX(expandedContent) < -10) return;
        expandedContent = null;
        var wraps = document.querySelectorAll('.swipe-wrap');
        for (var i = 0; i < wraps.length; i++) {
          var content = wraps[i].querySelector('.swipe-content');
          var actions = wraps[i].querySelector('.swipe-actions');
          if (content) {
            content.style.transition = TRANSITION_STYLE;
            content.style.transform = '';
          }
          hideSwipeActions(actions);
        }
        activeSwipeContent = null;
        activeSwipeActions = null;
        isExpanded = false;
      }

      document.addEventListener('click', function(e) {
        if (e.target.closest('.swipe-actions')) return;
        // Defer to let <a> navigation happen first
        setTimeout(closeAllSwipes, 0);
      });

      document.addEventListener('touchstart', function(e) {
        var wrap = e.target.closest('.swipe-wrap');
        // If touch is outside swipe-wrap but an item is expanded, don't
        // close it — iOS hard press can shift touch coordinates.
        if (!wrap) {
          if (!expandedContent || !(getTranslateX(expandedContent) < -10)) {
            closeAllSwipes();
          }
          return;
        }
        var content = wrap.querySelector('.swipe-content');
        if (!content) return;
        if (e.touches.length > 1) { isSwiping = false; return; }

        var newActions = wrap.querySelector('.swipe-actions');

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startTime = Date.now();
        currentX = startX; currentY = startY;
        isSwiping = true; isScrolling = false;

        var currentOffset = getTranslateX(content);
        isExpanded = currentOffset < -10;
        actionsWidth = 0;

        // When expanded, lock buttons in visible position during the gesture.
        if (isExpanded && newActions) {
          newActions.style.display = 'flex';
          newActions.style.transition = 'none';
          newActions.style.transform = 'translateX(0px)';
        }

        // Close other open swipes before setting active
        if (activeSwipeContent && activeSwipeContent !== content) {
          var otherWrap = activeSwipeContent.closest('.swipe-wrap');
          if (otherWrap) {
            var otherContent = otherWrap.querySelector('.swipe-content');
            var otherActions = otherWrap.querySelector('.swipe-actions');
            if (otherContent) {
              otherContent.style.transition = TRANSITION_STYLE;
              otherContent.style.transform = '';
            }
            hideSwipeActions(otherActions);
          }
        }

        activeSwipeContent = content;
        activeSwipeActions = newActions;
      }, { passive: true });

      document.addEventListener('touchmove', function(e) {
        if (!isSwiping || !activeSwipeContent) return;
        if (e.touches.length > 1) { isSwiping = false; return; }

        currentX = e.touches[0].clientX;
        currentY = e.touches[0].clientY;
        var deltaX = currentX - startX;
        var deltaY = currentY - startY;

        // Resolve vertical scroll conflict
        if (!isScrolling && Math.abs(deltaY) > Math.abs(deltaX) * VERTICAL_RATIO) {
          isScrolling = true; isSwiping = false; return;
        }
        if (isScrolling) return;

        // Lazy-init: show swipe actions only when user actually swipes (not on tap)
        if (!actionsWidth && Math.abs(deltaX) > 5 && activeSwipeActions) {
          if (!isExpanded) {
            showSwipeActions(activeSwipeActions);
          }
          actionsWidth = activeSwipeActions.offsetWidth || activeSwipeActions.scrollWidth || 200;
        }
        if (!actionsWidth) return;

        var offset;
        if (deltaX < 0) {
          // Left swipe — content follows finger, buttons slide in from right
          offset = isExpanded ? -actionsWidth + deltaX * DAMPING : deltaX * DAMPING;
          // Once buttons are fully visible, don't let content go further
          // left and create a white gap (applies in both open and closed states).
          if (offset < -actionsWidth) {
            var over = offset + actionsWidth;
            offset = -actionsWidth + over * 0.12; // tight elastic dampening
          }
        } else if (deltaX > 0 && isExpanded) {
          // Right swipe to close — from expanded state
          offset = -actionsWidth + deltaX * DAMPING;
        } else {
          return; // Right swipe on closed item — ignore
        }

        // Elastic overscroll
        if (offset < -actionsWidth - OVERSCROLL) {
          var over = offset + actionsWidth + OVERSCROLL;
          offset = -actionsWidth - OVERSCROLL + over * 0.12;
        }
        if (offset > OVERSCROLL) {
          offset = OVERSCROLL + (offset - OVERSCROLL) * 0.12;
        }

        setTranslateX(activeSwipeContent, offset, false);

        // On right-swipe (close): keep buttons visible, only track content.
        // Buttons slide out via _startCloseAnim at touchend instead.
        // On left-swipe (open): track buttons in sync with content.
        if (activeSwipeActions && !(deltaX > 0 && isExpanded)) {
          var btnOffset = Math.max(0, Math.min(actionsWidth, actionsWidth + offset));
          activeSwipeActions.style.transition = 'none';
          activeSwipeActions.style.transform = 'translateX(' + btnOffset + 'px)';
        }
      }, { passive: true });

      document.addEventListener('touchend', function() {
        if (!isSwiping || !activeSwipeContent || !actionsWidth) return;
        isSwiping = false;

        var deltaX = currentX - startX;
        var elapsed = Date.now() - startTime;

        // Treat as tap/click if minimal movement and short duration
        if (Math.abs(deltaX) <= CLICK_THRESHOLD && elapsed < CLICK_TIME) {
          // Let click event fire naturally; don't mutate DOM here
          activeSwipeContent = null;
          activeSwipeActions = null;
          isExpanded = false;
          expandedContent = null;
          return;
        }

        var currentOffset = getTranslateX(activeSwipeContent);
        var speed = elapsed > 0 ? Math.abs(deltaX) / elapsed : 0;

        // Right swipe always collapses; left swipe expands if past threshold or fast
        if (deltaX > 0) {
          setTranslateX(activeSwipeContent, 0, true);
          if (activeSwipeActions) {
            _startCloseAnim(activeSwipeActions);
          }
          activeSwipeContent = null;
          activeSwipeActions = null;
          isExpanded = false;
          expandedContent = null;
        } else if (currentOffset <= -actionsWidth / 4 || speed > 0.5) {
          setTranslateX(activeSwipeContent, -actionsWidth, true);
          if (activeSwipeActions) {
            _cancelCloseAnim(activeSwipeActions);
            activeSwipeActions.style.transition = TRANSITION_STYLE;
            activeSwipeActions.style.transform = 'translateX(0)';
          }
          isExpanded = true;
          expandedContent = activeSwipeContent;
        } else {
          setTranslateX(activeSwipeContent, 0, true);
          if (activeSwipeActions) {
            _startCloseAnim(activeSwipeActions);
          }
          activeSwipeContent = null;
          activeSwipeActions = null;
          isExpanded = false;
          expandedContent = null;
        }
      }, { passive: true });

      document.addEventListener('touchcancel', function() {
        if (activeSwipeContent) {
          var wrap = activeSwipeContent.closest('.swipe-wrap');
          var actions = wrap ? wrap.querySelector('.swipe-actions') : null;
          activeSwipeContent.style.transition = TRANSITION_STYLE;
          activeSwipeContent.style.transform = '';
          if (actions && !actions._closing) {
            _startCloseAnim(actions);
          }
          activeSwipeContent = null;
          activeSwipeActions = null;
        }
        isSwiping = false; isScrolling = false; isExpanded = false;
        expandedContent = null;
      }, { passive: true });

      // Search box: trigger on Enter, fetch results, and re-render list.
      (function() {
        var input = document.getElementById('search-input');
        if (!input) return;
        input.addEventListener('keydown', async function(e) {
          if (e.key !== 'Enter') return;
          var q = input.value.trim();
          if (!q) {
            articlesData = originalArticlesData.slice();
            document.getElementById('count').textContent = '共 ' + articlesData.length + ' 条';
            renderList();
            return;
          }
          input.disabled = true;
          try {
            var res = await fetch('/api/search?q=' + encodeURIComponent(q));
            var d = await res.json();
            if (d.success) {
              articlesData = d.results;
              document.getElementById('count').textContent = '共 ' + articlesData.length + ' 条';
              renderList();
            }
          } catch (err) {
            console.error('Search failed:', err);
          } finally {
            input.disabled = false;
          }
        });
      })();
    })();
  </script>
<script>
(function(){
  var t=localStorage.getItem('theme');
  if(t) document.documentElement.setAttribute('data-theme',t);
  else if(window.matchMedia('(prefers-color-scheme:dark)').matches) document.documentElement.setAttribute('data-theme','dark');
  updateThemeIcon();
})();
function _setThemeColorForSidebar(open) {
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var openColor = isDark ? '#1a1a1a' : '#ffffff';
  var closedColor = isDark ? '#0f0f0f' : '#f5f5f5';
  for (var i = 0; i < metas.length; i++) {
    metas[i].setAttribute('content', open ? openColor : closedColor);
  }
}
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('show');
  document.body.classList.add('sidebar-open');
  // Defer theme-color so first paint of transform is not blocked by chrome repaint
  requestAnimationFrame(function() { _setThemeColorForSidebar(true); });
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
  document.body.classList.remove('sidebar-open');
  requestAnimationFrame(function() { _setThemeColorForSidebar(false); });
  // Match QA: only re-render after search state, and after slide finishes
  if (sidebarQuery || sidebarPostResults.length > 0) {
    sidebarQuery = '';
    sidebarPostResults = [];
    var input = document.getElementById('sidebarSearch');
    if (input) input.value = '';
    setTimeout(function() { renderSidebar(); }, 260);
  }
}
// Swipe-left to close sidebar
(function() {
  var sb = document.getElementById('sidebar');
  if (!sb) return;
  var startX = 0;
  sb.addEventListener('touchstart', function(e) {
    startX = e.touches[0].clientX;
  }, { passive: true });
  sb.addEventListener('touchend', function(e) {
    var touch = e.changedTouches[0] || e.touches[0];
    if (!touch) return;
    var dx = touch.clientX - startX;
    if (dx < -50) closeSidebar();
  });
})();
var sidebarQuery = '';
var sidebarPostResults = [];
function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function handleSidebarSearch(value) {
  sidebarQuery = (value || '').trim();
  sidebarPostResults = [];
  renderSidebar();
}
function handleSidebarSearchKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchPostsFromSidebar();
  }
}
async function searchPostsFromSidebar() {
  if (!sidebarQuery || sidebarQuery.length < 2) return;
  var list = document.getElementById('sidebarList');
  if (list) list.innerHTML = '<div class="sidebar-empty" style="padding:40px 16px;text-align:center;color:var(--text-tertiary);font-size:14px;">搜索中...</div>';
  try {
    var res = await fetch('/api/search?q=' + encodeURIComponent(sidebarQuery));
    var data = await res.json();
    sidebarPostResults = (data && data.results) || [];
  } catch (err) {
    sidebarPostResults = [];
  }
  renderSidebar();
}
function renderSidebar() {
  var list = document.getElementById('sidebarList');
  if (!list) return;
  var html = '';
  if (sidebarQuery && sidebarPostResults.length === 0) {
    html += '<div class="search-posts-btn" onclick="searchPostsFromSidebar()">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
      '<span>在帖子中搜索「' + escapeHtml(sidebarQuery) + '」</span>' +
      '</div>';
  }
  if (sidebarPostResults.length > 0) {
    html += '<div class="search-segment">帖子</div>';
    html += sidebarPostResults.map(function(r) {
      var title = escapeHtml(r.title || r.fileName || '');
      return '<a class="post-result-item" href="/articles/' + r.fileName + '" onclick="closeSidebar()">' +
        '<div class="post-result-title">' + title + '</div>' +
        (r.author ? '<div class="post-result-meta">' + escapeHtml(r.author) + '</div>' : '') +
        (r.snippet ? '<div class="post-result-snippet">' + escapeHtml(r.snippet) + '</div>' : '') +
        '</a>';
    }).join('');
  }
  if (sidebarQuery && sidebarPostResults.length === 0) {
    html += '<div class="sidebar-empty" style="padding:40px 16px;text-align:center;color:var(--text-tertiary);font-size:14px;">未找到相关帖子</div>';
  }
  list.innerHTML = html;
}
function refreshPage(btn) {
  if (btn && btn.classList) {
    btn.classList.add('spinning');
    setTimeout(function() { location.reload(); }, 180);
  } else {
    location.reload();
  }
}
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
  var hlLight = document.getElementById('hl-theme-light');
  var hlDark = document.getElementById('hl-theme-dark');
  if (hlLight) hlLight.disabled = isDark;
  if (hlDark) hlDark.disabled = !isDark;
}
// Prefetch global QA suggestions while user browses list (sidebar → /qa ready)
(function() {
  if (window.__qaGlobalPrefetched) return;
  window.__qaGlobalPrefetched = true;
  try {
    fetch('/api/qa/suggestions', { credentials: 'same-origin', cache: 'no-store' })
      .catch(function() {});
  } catch (e) {}
})();
</script>
</div>
</body>
</html>`;
}

async function downloadAvatar(url: string, basePath: string): Promise<string | null> {
  // Check if already exists (any extension)
  const dir = path.dirname(basePath);
  const base = path.basename(basePath);
  if (fs.existsSync(dir)) {
    const existing = fs.readdirSync(dir).find(f => f.startsWith(base + '.'));
    if (existing) return path.join(dir, existing);
  }

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      httpsAgent: getDownloadAgent(),
      headers: { 'User-Agent': 'TweetArchive/1.0' },
    });

    const contentType = String(response.headers['content-type'] || '');
    let ext = '.jpg';
    if (contentType.includes('image/png')) ext = '.png';
    else if (contentType.includes('image/webp')) ext = '.webp';
    else if (contentType.includes('image/gif')) ext = '.gif';

    const finalPath = basePath + ext;
    fs.writeFileSync(finalPath, Buffer.from(response.data));
    return finalPath;
  } catch (err) {
    console.error(`[avatar] Failed to download ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Guess image extension from URL path / query (WeChat uses /0?wx_fmt=png).
 * Prefer sniffing file magic after download — this is only an initial hint.
 */
export function guessImageExtFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const wx = (u.searchParams.get('wx_fmt') || u.searchParams.get('tp') || '').toLowerCase();
    if (wx === 'png' || wx === 'jpeg' || wx === 'jpg' || wx === 'gif' || wx === 'webp' || wx === 'svg') {
      return wx === 'jpeg' ? '.jpg' : `.${wx}`;
    }
    // path like .../mmbiz_png/... or .../mmbiz_jpg/...
    const pathHint = u.pathname.match(/mmbiz_(png|jpg|jpeg|gif|webp|svg)/i);
    if (pathHint) {
      const t = pathHint[1].toLowerCase();
      return t === 'jpeg' ? '.jpg' : `.${t}`;
    }
    const ext = path.extname(u.pathname).toLowerCase();
    if (ext && ext.length <= 5 && /^\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch { /* ignore */ }
  return '.jpg';
}

/** Detect real image type from file header (WeChat often has no extension). */
export function detectImageExtFromBuffer(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;
  // PNG
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return '.png';
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return '.webp';
  }
  // SVG (text) — browsers refuse <img src="….jpg"> when body is SVG
  const head = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || /^<svg[\s>]/i.test(head)) {
    return '.svg';
  }
  return null;
}

/**
 * After download, if magic bytes disagree with file extension, rename to match.
 * Returns the final absolute path (may equal destPath).
 */
export function ensureImageExtMatchesContent(destPath: string): string {
  try {
    if (!fs.existsSync(destPath)) return destPath;
    const buf = Buffer.alloc(256);
    const fd = fs.openSync(destPath, 'r');
    const n = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const detected = detectImageExtFromBuffer(buf.subarray(0, n));
    if (!detected) return destPath;
    const cur = path.extname(destPath).toLowerCase();
    const curNorm = cur === '.jpeg' ? '.jpg' : cur;
    if (curNorm === detected) return destPath;
    const next = destPath.slice(0, destPath.length - cur.length) + detected;
    if (fs.existsSync(next)) {
      // Prefer the correctly-typed path; drop mislabeled one
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      return next;
    }
    fs.renameSync(destPath, next);
    return next;
  } catch {
    return destPath;
  }
}

async function downloadFile(url: string, destPath: string, referer?: string): Promise<void> {
  // Feishu/Lark CDN often requires browser-like UA + Referer, otherwise returns 403 HTML.
  // WeChat mmbiz CDN also prefers a page Referer.
  let ref = referer || '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!ref && /(feishu|lark|bytedance|feishucdn|larksuitecdn)/i.test(host)) {
      ref = 'https://www.feishu.cn/';
    }
    if (!ref && /(qpic\.cn|mmbiz)/i.test(host)) {
      ref = 'https://mp.weixin.qq.com/';
    }
  } catch { /* ignore */ }

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  };
  if (ref) headers.Referer = ref;

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    maxRedirects: 5,
    httpsAgent: getDownloadAgent(),
    headers,
  });

  // Only reject non-media content types (HTML, JSON, etc.)
  // Allow image/svg+xml and empty/octet-stream (WeChat sometimes omits type).
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
  // Defense in depth: every source path normalizes before disk / meta write
  tweet = normalizeTweetFields(tweet);
  const fileNameBase = sanitizeFileName(tweet.author.screen_name) + '_' + tweet.id;
  const htmlFileName = fileNameBase + '.html';
  const htmlPath = path.join(ARTICLES_DIR, htmlFileName);

  // Download avatar: prefer original pbs.twimg.com URL (via proxy), fallback to unavatar
  if (tweet.author.avatar_url && !tweet.author.avatar_url.startsWith('../')) {
    const platform = tweet.sourceType === 'wechat' ? 'wechat' : tweet.sourceType === 'webpage' ? 'webpage' : 'twitter';
    const safeName = sanitizeFileName(tweet.author.name || tweet.author.screen_name);
    const avatarBaseName = `${platform}_${tweet.author.screen_name}_${safeName}`;
    const avatarBasePath = path.join(AVATARS_DIR, avatarBaseName);
    // Try original URL first (direct pbs.twimg.com via proxy), then unavatar fallback
    const downloadUrl = tweet.author.original_avatar_url || tweet.author.avatar_url;
    let avatarLocalPath = await downloadAvatar(downloadUrl, avatarBasePath);
    if (!avatarLocalPath && tweet.author.original_avatar_url) {
      avatarLocalPath = await downloadAvatar(tweet.author.avatar_url, avatarBasePath);
    }
    if (avatarLocalPath) {
      tweet.author.avatar_url = '../avatars/' + path.basename(avatarLocalPath);
    }
  }

  const allImageUrls: string[] = [];
  const photos = tweet.media?.photos || [];
  for (const photo of photos) { allImageUrls.push(photo.url); }

  const allVideoUrls: string[] = [];
  const videos = tweet.media?.videos || [];
  for (const video of videos) { allVideoUrls.push(video.url); }

  const localImagePaths: string[] = [...allImageUrls];
  const localVideoPaths: string[] = [...allVideoUrls];

  // Try to download images (best-effort via proxy); skip if already exists
  // Feishu/Lark images: pass article URL as Referer so CDN allows the fetch.
  const imgReferer = tweet.url || undefined;
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    // Initial ext from URL (wx_fmt / mmbiz_png / path); corrected by magic sniff after download
    let ext = guessImageExtFromUrl(photo.url);
    let imgFileName = fileNameBase + '_img' + i + ext;
    let imgPath = path.join(IMAGES_DIR, imgFileName);

    // Already on disk under any common ext? Reuse + fix extension if mislabeled
    if (!(fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0)) {
      for (const tryExt of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']) {
        const cand = path.join(IMAGES_DIR, fileNameBase + '_img' + i + tryExt);
        if (fs.existsSync(cand) && fs.statSync(cand).size > 0) {
          imgPath = cand;
          imgFileName = path.basename(cand);
          break;
        }
      }
    }

    if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0) {
      const fixed = ensureImageExtMatchesContent(imgPath);
      localImagePaths[i] = '../images/' + path.basename(fixed);
      continue;
    }

    try {
      await downloadFile(photo.url, imgPath, imgReferer);
      // Detect real type if extension was wrong and file is tiny/empty error page
      if (fs.existsSync(imgPath) && fs.statSync(imgPath).size < 200) {
        // likely HTML error body; drop and keep remote URL fallback
        fs.unlinkSync(imgPath);
        throw new Error('Downloaded file too small (likely blocked)');
      }
      // SVG mislabeled as .jpg → naturalWidth 0 in browser; PNG-as-jpg often works but fix anyway
      const fixed = ensureImageExtMatchesContent(imgPath);
      localImagePaths[i] = '../images/' + path.basename(fixed);
    } catch (err) {
      console.error(`[save] Failed to download image ${i}: ${photo.url} — ${err instanceof Error ? err.message : err}`);
    }
  }

  // Try to download videos (best-effort via proxy); skip if already exists
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const ext = '.mp4';
    const vidFileName = fileNameBase + '_vid' + i + ext;
    const vidPath = path.join(VIDEOS_DIR, vidFileName);
    if (fs.existsSync(vidPath) && fs.statSync(vidPath).size > 0) {
      localVideoPaths[i] = '../videos/' + vidFileName;
      continue;
    }
    try {
      await downloadFile(video.url, vidPath);
      localVideoPaths[i] = '../videos/' + vidFileName;
    } catch (err) {
      console.error(`[save] Failed to download video ${i}: ${video.url} — ${err instanceof Error ? err.message : err}`);
    }
  }

  const html = renderTweetHtml(tweet, localImagePaths, allImageUrls, allVideoUrls, localVideoPaths);
  fs.writeFileSync(htmlPath, html, 'utf-8');

  const meta = loadMeta();
  const now = Date.now();

  const existingIndex = meta.findIndex(m => m.fileName === htmlFileName);
  const existing = existingIndex >= 0 ? meta[existingIndex] : null;
  const metaEntry: ArticleMeta = {
    fileName: htmlFileName,
    title: tweet.title || tweet.text.split('\n')[0].substring(0, 80),
    author: tweet.author.name,
    authorHandle: tweet.author.screen_name,
    authorAvatar: tweet.author.avatar_url?.startsWith('../')
      ? tweet.author.avatar_url.replace(/^\.\.\//, '/')
      : 'https://unavatar.io/x/' + tweet.author.screen_name,
    tweetUrl: tweet.url,
    tweetDate: formatDate(tweet.created_timestamp),
    savedDate: formatDate(Math.floor(now / 1000)),
    tweetTimestamp: tweet.created_timestamp,
    savedTimestamp: Math.floor(now / 1000),
    contentKey: tweet.text.substring(0, 200),
    sourceType: tweet.sourceType || 'twitter',
    pinned: existing ? existing.pinned : false,
    pinnedAt: existing ? existing.pinnedAt : undefined,
    unread: existing ? existing.unread : true,
    likes: tweet.likes,
    retweets: tweet.retweets,
    replies: tweet.replies,
  };
  if (existingIndex >= 0) { meta[existingIndex] = metaEntry; }
  else { meta.push(metaEntry); }
  saveMeta(meta);

  // Update keyword index immediately; generate embedding in the background.
  try {
    insertSearchArticle({
      fileName: metaEntry.fileName,
      title: metaEntry.title,
      author: metaEntry.author,
      authorHandle: metaEntry.authorHandle,
      body: tweet.text,
    });
    generateEmbedding(metaEntry.fileName, `${metaEntry.title}\n${metaEntry.author}\n${tweet.text}`).catch(() => {});
    // Extract opinions asynchronously (don't block save)
    extractOpinions(metaEntry.fileName).catch(err =>
      console.error('[saveTweet] Opinion extraction failed:', err instanceof Error ? err.message : err));
  } catch (err) {
    console.error('[saveTweet] Search index update failed:', err instanceof Error ? err.message : err);
  }

  await rebuildIndex();
  return htmlFileName;
}

export async function rebuildIndex(): Promise<void> {
  const meta = loadMeta();
  const existingFiles = new Set(fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html')));
  const validMeta = meta.filter(m => existingFiles.has(m.fileName));
  if (validMeta.length !== meta.length) { saveMeta(validMeta); }

  // Prune search index entries for missing articles.
  try { syncSearchMeta(validMeta.map(m => m.fileName)); } catch (err) {
    console.error('[rebuildIndex] Search meta sync failed:', err instanceof Error ? err.message : err);
  }

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
export function getAvatarsDir(): string {
  ensureDirs();
  return AVATARS_DIR;
}
export function getVideosDir(): string {
  ensureDirs();
  return VIDEOS_DIR;
}
