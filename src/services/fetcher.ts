import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getFxTwitterApiUrl, parseTweetUrl, generateWebPageId } from '../utils/url';
import type { ParsedTweetUrl } from '../utils/url';
import { normalizeScrapedText, normalizeAuthorField } from '../utils/textDecode';
import {
  htmlToMarkdown,
  cleanWebpageMarkdown,
  contentScore,
  extractMarkdownImages,
  pushPhoto as pushPhotoShared,
  type PhotoSink,
} from './htmlToMarkdown';
import { convertHtmlWithMarkitdown } from './markitdownBridge';
import { isLlmEnabled, chatWithJson } from './llm';
import * as fs from 'fs';
import * as path from 'path';

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
const USE_PROXY = process.env.USE_PROXY === '1' || process.env.USE_PROXY === 'true';

function getAgent() {
  if (!USE_PROXY) return undefined;
  try {
    return new HttpsProxyAgent(PROXY_URL);
  } catch {
    return undefined;
  }
}

async function resolveUrl(url: string): Promise<string> {
  try {
    const res = await axios.head(url, {
      maxRedirects: 0,
      validateStatus: status => status >= 300 && status < 400,
      timeout: 10000,
      httpsAgent: getAgent(),
      headers: { 'User-Agent': 'TweetArchive/1.0' },
    });
    const location = res.headers.location;
    if (location) {
      return new URL(location, url).href;
    }
  } catch {
    // fall back to input URL
  }
  return url;
}

type ArticleContent = { title: string; text: string; photos: TweetPhoto[]; videos: TweetVideo[]; authorName: string; authorScreenName: string; authorAvatar: string; likes: number; retweets: number; replies: number };

/** Fetch full X Article content via Playwright (headless Chromium).
 *  Renders the article page with auth cookies so all inline links are preserved.
 *  Used as primary path for link-card tweets where GraphQL only returns preview_text. */
export async function fetchArticleViaPlaywright(tweetUrl: string): Promise<ArticleContent | null> {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  if (!authToken) return null;

  let browser: any = null;
  let owned = false;
  try {
    const { chromium } = await import('playwright');

    // Try connecting to an existing Chrome via CDP first (best anti-detection)
    const cdpPorts = [64355, 9222, 9223, 9224, 9225];
    for (const port of cdpPorts) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        owned = false;
        break;
      } catch { /* try next port */ }
    }

    // Fall back: launch a new browser
    if (!browser) {
      browser = await chromium.launch({
        headless: true,
        proxy: USE_PROXY ? { server: PROXY_URL } : undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--enable-features=NetworkService,NetworkServiceInProcess',
        ],
      });
      owned = true;
    }

    const context = owned
      ? await browser.newContext({
          viewport: { width: 1280, height: 900 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          bypassCSP: true,
        })
      : browser.contexts()[0];

    await context.addCookies([
      { name: 'auth_token', value: authToken, domain: '.x.com', path: '/' },
      { name: 'ct0', value: ct0 || '', domain: '.x.com', path: '/' },
    ]);

    const page = await context.newPage();
    await page.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    `);

    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // DOM-to-markdown loaded from external .js file to avoid
    // TypeScript/tsx helpers breaking page.evaluate().
    const extractScript = fs.readFileSync(path.join(__dirname, 'pw-extract.js'), 'utf-8');
    const result = await page.evaluate(`(${extractScript})`);

    if (!result?.text) return null;

    return {
      title: result.title || '',
      text: result.text,
      photos: [],
      videos: [],
      authorName: '',
      authorScreenName: '',
      authorAvatar: '',
      likes: 0,
      retweets: 0,
      replies: 0,
    };
  } catch (e) {
    console.error('[playwright] Article fetch failed:', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    if (browser && owned) await browser.close().catch(() => {});
  }
}

/** @deprecated Replaced by fetchArticleViaPlaywright — kept as thin wrapper. */
async function fetchArticleViaBrowser(articleId: string): Promise<ArticleContent | null> {
  return null;
}

/** Fetch X Article card content via X internal GraphQL API.
 *  Returns preview_text when full content_state is not available.
 *  Falls back gracefully if auth_token is not configured or request fails. */
async function fetchArticleViaGraphQL(tweetId: string): Promise<{ title: string; text: string; photos: TweetPhoto[]; videos: TweetVideo[]; authorName: string; authorScreenName: string; authorAvatar: string; likes: number; retweets: number; replies: number } | null> {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  if (!authToken) return null;

  try {
    // Auth-only endpoint: guest activation often 403s; auth cookies are enough.
    const headers: Record<string, string> = {
      'User-Agent': 'TweetArchive/1.0',
      'authorization': `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'cookie': `auth_token=${authToken}; ct0=${ct0 || ''};`,
      'x-csrf-token': ct0 || '',
    };

    const variables = {
      focalTweetId: tweetId,
      with_rux_injections: false,
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withArticleRichContent: true,
      withBirdwatchNotes: false,
      withVoice: true,
      withDownvotePerspective: false,
      withReactionsMetadata: false,
      withReactionsPerspective: false,
    };

    const res = await axios.get(
      `https://x.com/i/api/graphql/iFEr5AcP121Og4wx9Yqo3w/TweetDetail`,
      {
        params: {
          variables: JSON.stringify(variables),
          features: JSON.stringify(DEFAULT_FEATURES),
        },
        headers,
        timeout: 15000,
        httpsAgent: getAgent(),
      }
    );

    const instructions = res.data?.data?.threaded_conversation_with_injections_v2?.instructions;
    if (!instructions) return null;

    // Walk instructions to find the tweet entry (handle TweetWithVisibilityResults wrapper)
    let articleResult: any = null;
    let tweetLegacy: any = null;
    let tweetCore: any = null;
    let tweetStats: any = null;
    for (const inst of instructions) {
      const entries = inst.entries || inst.moduleItems || [];
      for (const entry of entries) {
        const outer = entry.content?.itemContent?.tweet_results?.result || entry.entry?.content?.itemContent?.tweet_results?.result;
        const tweet = outer?.tweet || outer;
        const legacy = tweet?.legacy;
        if (!legacy) continue;
        tweetLegacy = legacy;
        tweetCore = tweet?.core;
        tweetStats = tweet?.views || legacy;
        const article = tweet?.article?.article_results?.result;
        if (article?.title || article?.preview_text) {
          articleResult = article;
        }
      }
    }

    if (!articleResult) return null;

    // Parse using existing Draft.js parser; content_state may be empty for link-card previews.
    const contentState = articleResult.content_state || {};
    const parsed = parseArticleContent({
      title: articleResult.title,
      content: { entityMap: contentState.entityMap || [], blocks: contentState.blocks || [] },
      cover_media: articleResult.cover_media,
      media_entities: articleResult.media_entities || [],
    });
    // entityMap keys from GraphQL are strings; parseDraftJsBlocks expects number keys
    // to match entityRanges[].key. Inconsistent key types cause formatting to silently
    // fail (links, bold, etc. get dropped).
    const gqlEntityMap = new Map<number, any>();
    for (const e of (contentState.entityMap || [])) {
      const k = parseInt(String(e.key), 10);
      if (!isNaN(k)) gqlEntityMap.set(k, e.value);
    }
    parsed.text = parseDraftJsBlocks(
      contentState.blocks || [],
      gqlEntityMap
    );
    // Fallback to preview text when full article body is not exposed.
    if (!parsed.text?.trim() && articleResult.preview_text) {
      parsed.text = articleResult.preview_text;
    }

    const userResult = tweetCore?.user_results?.result?.legacy || {};
    return {
      title: articleResult.title || parsed.title,
      text: parsed.text,
      photos: parsed.photos,
      videos: parsed.videos,
      authorName: userResult.name || tweetLegacy?.screen_name || '',
      authorScreenName: userResult.screen_name || tweetLegacy?.screen_name || '',
      authorAvatar: userResult.profile_image_url_https || '',
      likes: tweetLegacy?.favorite_count || 0,
      retweets: tweetLegacy?.retweet_count || 0,
      replies: tweetLegacy?.reply_count || 0,
    };
  } catch {
    return null;
  }
}

const DEFAULT_FEATURES = {
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled_new: true,
  tweetypie_media_fields_no_typeahead_url: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
} as Record<string, boolean>;

/** Expand quoted tweets and no-comment retweets so saved pages show real content. */
async function expandQuoteOrRetweet(tweet: any, depth = 0): Promise<any> {
  if (depth > 1 || !tweet) return tweet;

  /** Try to resolve a link-card tweet (empty text, raw_text is a t.co URL) into article content. */
  async function resolveLinkCard(linkCard: any): Promise<{ title: string; text: string; photos: TweetPhoto[]; videos: TweetVideo[] } | null> {
    if (!linkCard?.id) return null;

    // 1) Try GraphQL first (fast, no browser overhead)
    const graphQlResult = await fetchArticleViaGraphQL(linkCard.id);
    const gqlText = graphQlResult?.text?.trim() || '';
    const gqlTextIsLong = gqlText.length > 100;

    if (gqlTextIsLong) {
      // GraphQL returned full content (content_state blocks with body text)
      return {
        title: graphQlResult!.title,
        text: gqlText,
        photos: graphQlResult!.photos || [],
        videos: graphQlResult!.videos || [],
      };
    }

    // 2) GraphQL returned only preview_text (short) — try Playwright for full body.
    // Prefer whichever source has longer text.
    let pwText = '';
    let pwTitle = '';
    if (linkCard.url) {
      const pwResult = await fetchArticleViaPlaywright(linkCard.url);
      pwText = pwResult?.text?.trim() || '';
      pwTitle = pwResult?.title || '';
    }

    if (pwText && pwText.length > gqlText.length) {
      return {
        title: pwTitle || graphQlResult?.title || '',
        text: pwText,
        photos: [],
        videos: [],
      };
    }

    // 3) Fall back to GraphQL text (preview_text > nothing)
    if (gqlText) {
      return {
        title: graphQlResult!.title,
        text: gqlText,
        photos: graphQlResult!.photos || [],
        videos: graphQlResult!.videos || [],
      };
    }

    return null;
  }

  // Quote tweet: always expand the quoted original alongside the commentary.
  if (tweet.quote?.url) {
    let q = tweet.quote;

    // If the quote carries little or no text (often just a t.co card URL),
    // fetch the original tweet/article so we can include its real content.
    if (!q.text || q.text.trim().length <= 30) {
      try {
        const parsed = parseTweetUrl(q.url);
        if (parsed) {
          const original = await fetchFromFxTwitter(parsed);
          q = await expandQuoteOrRetweet(original, depth + 1);
        }
      } catch {
        // Keep the quote as-is; the card preview is still better than nothing.
      }
    }

    // Still empty? It may be a link-card / X Article whose body FxTwitter does not expose.
    // Check both t.co (link-card) and article presence (X Article without t.co).
    if (!q.text?.trim() && (q.raw_text?.text?.includes('t.co') || q.article)) {
      const resolved = await resolveLinkCard(q);
      if (resolved) {
        q = {
          ...q,
          text: resolved.text,
          title: resolved.title,
          media: { photos: resolved.photos, videos: resolved.videos },
        };
      }
    }

    if (q.text?.trim()) {
      const comment = tweet.text?.trim() || '';
      const originalText = q.text.trim();
      const separator = '\n\n**以下是原文：**\n\n';

      // Merge quote media into the main tweet and re-index any [IMG:N]/[VIDEO:N]
      // markers so they point at the appended photos/videos.
      const mergedPhotos: TweetPhoto[] = [...(tweet.media?.photos || [])];
      const mergedVideos: TweetVideo[] = [...(tweet.media?.videos || [])];

      let reindexedOriginal = originalText;
      reindexedOriginal = reindexedOriginal.replace(/\[IMG:(\d+)\]/g, (_m: string, idx: string) => {
        const i = parseInt(idx, 10);
        const photo = q.media?.photos?.[i];
        if (photo) {
          const newIdx = mergedPhotos.length;
          mergedPhotos.push(photo);
          return `[IMG:${newIdx}]`;
        }
        return '';
      });
      reindexedOriginal = reindexedOriginal.replace(/\[VIDEO:(\d+)\]/g, (_m: string, idx: string) => {
        const i = parseInt(idx, 10);
        const video = q.media?.videos?.[i];
        if (video) {
          const newIdx = mergedVideos.length;
          mergedVideos.push(video);
          return `[VIDEO:${newIdx}]`;
        }
        return '';
      });

      // Append any unreferenced quote photos/videos as new markers.
      if (q.media?.photos) {
        for (const photo of q.media.photos) {
          if (!mergedPhotos.some(p => p.url === photo.url)) {
            mergedPhotos.push(photo);
            reindexedOriginal += `\n[IMG:${mergedPhotos.length - 1}]`;
          }
        }
      }
      if (q.media?.videos) {
        for (const video of q.media.videos) {
          if (!mergedVideos.some(v => v.url === video.url)) {
            mergedVideos.push(video);
            reindexedOriginal += `\n[VIDEO:${mergedVideos.length - 1}]`;
          }
        }
      }

      const fullText = comment ? `${comment}${separator}${reindexedOriginal}` : reindexedOriginal;

      return {
        ...tweet,
        text: fullText,
        title: q.title || deriveTitle(q.text, 80) || tweet.title || '',
        media: {
          photos: mergedPhotos,
          videos: mergedVideos,
        },
      };
    }
  }

  // No-comment retweet: FxTwitter returns empty text and raw_text contains a t.co link.
  // Only treat as retweet when the raw_text is essentially just a URL (or RT @user: + URL).
  // A short tweet with a link (e.g. "Check this https://t.co/abc") should NOT be expanded.
  if ((!tweet.text || tweet.text.trim().length <= 30) && tweet.raw_text?.text) {
    const raw = tweet.raw_text.text.trim();
    const tcoMatch = raw.match(/https:\/\/t\.co\/\w+/);
    if (tcoMatch) {
      // Verify it's a real retweet: after removing the t.co URL and retweet prefix,
      // there should be essentially no original content left.
      const withoutUrl = raw.replace(tcoMatch[0], '').trim();
      const isRealRetweet = /^(RT\s*@\w{1,15}:\s*)?$/i.test(withoutUrl);
      if (!isRealRetweet) {
        return tweet; // Regular short tweet with a link — keep original title/text
      }
      // Link-card / X Article: prefer GraphQL auth endpoint over headless browser.
      const linkCard = await resolveLinkCard(tweet);
      if (linkCard) {
        return {
          ...tweet,
          text: linkCard.text,
          title: linkCard.title || tweet.title || '',
          media: tweet.media || { photos: linkCard.photos, videos: linkCard.videos },
        };
      }
      try {
        const resolved = await resolveUrl(tcoMatch[0]);
        // Fallback: try FxTwitter with resolved URL if it points to another tweet.
        const parsed = parseTweetUrl(resolved);
        if (parsed) {
          const original = await fetchFromFxTwitter(parsed);
          const expandedOriginal = await expandQuoteOrRetweet(original, depth + 1);
          return {
            ...tweet,
            text: expandedOriginal.text,
            title: expandedOriginal.title || deriveTitle(expandedOriginal.text, 80) || tweet.title || '',
            media: expandedOriginal.media || tweet.media,
            author: expandedOriginal.author || tweet.author,
          };
        }
      } catch {
        // Leave original tweet as-is; Jina AI fallback may provide a card preview.
      }
    }
  }

  return tweet;
}

/** Fetch recent X bookmarks using auth_token. Returns list of tweet URLs. */
/** 代理被批量下载挤占时网络抖动是常态:GET 请求重试 2 次(共 3 次尝试),退避 1.5s/3s */
async function axiosGetWithRetry(url: string, config: Parameters<typeof axios.get>[1], tag: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.warn(`[${tag}] attempt ${attempt}/3 failed, retrying: ${err instanceof Error ? err.message : err}`);
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr;
}

export async function fetchBookmarks(count = 30): Promise<string[]> {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  if (!authToken || !ct0) return [];

  try {
    const vars = JSON.stringify({ count, includePromotedContent: false });
    const res = await axiosGetWithRetry(
      `https://x.com/i/api/graphql/pLtjrO4ubNh996M_Cubwsg/Bookmarks`,
      {
        params: { variables: vars, features: JSON.stringify({}) },
        headers: {
          'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'en',
          'x-csrf-token': ct0,
          'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
        },
        timeout: 15000,
        httpsAgent: getAgent(),
      },
      'fetchBookmarks'
    );

    const urls: string[] = [];
    const instructions = res.data?.data?.bookmark_timeline_v2?.timeline?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const result = entry.content?.itemContent?.tweet_results?.result;
        if (!result) continue;
        // Some tweets are wrapped: { tweet: { core, legacy } }
        const tw = result.tweet || result;
        const legacy = tw?.legacy;
        const core = tw?.core;
        if (!legacy?.id_str) continue;
        const screenName = core?.user_results?.result?.core?.screen_name
          || core?.user_results?.result?.legacy?.screen_name || '';
        if (screenName) {
          urls.push(`https://x.com/${screenName}/status/${legacy.id_str}`);
        }
      }
    }
    return urls;
  } catch (err) {
    console.error('[fetchBookmarks] Error:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Fetch recent X likes using auth_token + user ID. Returns list of tweet URLs. */
export async function fetchLikes(count = 30): Promise<string[]> {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  const userId = process.env.X_USER_ID;
  if (!authToken || !ct0 || !userId) return [];

  try {
    const vars = JSON.stringify({ userId, count, includePromotedContent: false });
    const res = await axiosGetWithRetry(
      `https://x.com/i/api/graphql/TGEKkJG_meudeaFcqaxM-Q/Likes`,
      {
        params: { variables: vars, features: JSON.stringify({}) },
        headers: {
          'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'x-twitter-active-user': 'yes', 'x-twitter-client-language': 'en',
          'x-csrf-token': ct0, 'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
        },
        timeout: 15000, httpsAgent: getAgent(),
      },
      'fetchLikes'
    );

    const urls: string[] = [];
    const instructions = res.data?.data?.user?.result?.timeline?.timeline?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const result = entry.content?.itemContent?.tweet_results?.result;
        if (!result) continue;
        const tw = result.tweet || result;
        const legacy = tw?.legacy;
        const core = tw?.core;
        if (!legacy?.id_str) continue;
        const screenName = core?.user_results?.result?.core?.screen_name
          || core?.user_results?.result?.legacy?.screen_name || '';
        if (screenName) {
          urls.push(`https://x.com/${screenName}/status/${legacy.id_str}`);
        }
      }
    }
    return urls;
  } catch (err) {
    console.error('[fetchLikes] Error:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Derive a title from tweet text. Merges continuation lines (ending in ，、；：) up to maxLen.
 *  Skips leading media markers like [IMG:0] / [VIDEO:0] so X Article cover images
 *  don't become the article title. */
export function deriveTitle(text: string, maxLen = 80): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return '';

  // Skip leading image/video markers (e.g. X Article cover image)
  let startIdx = 0;
  while (startIdx < lines.length && /^\[(IMG|VIDEO):\d+\]$/.test(lines[startIdx])) {
    startIdx++;
  }
  if (startIdx >= lines.length) return '';

  let title = lines[startIdx];
  const continuationMarks = /[，、；：]$/;
  let i = startIdx + 1;
  while (i < lines.length && continuationMarks.test(title) && title.length < maxLen) {
    const combined = title + lines[i];
    if (combined.length <= maxLen) {
      title = combined;
    } else {
      title = combined.substring(0, maxLen);
      break;
    }
    i++;
  }
  return title.substring(0, maxLen);
}

export interface TweetAuthor {
  name: string;
  screen_name: string;
  avatar_url: string;
  original_avatar_url?: string;
  banner_url?: string;
}

export interface TweetPhoto {
  url: string;
  width: number;
  height: number;
}

export interface TweetVideo {
  url: string;
  thumbnail_url: string;
  width: number;
  height: number;
}

export interface TweetMedia {
  photos?: TweetPhoto[];
  videos?: TweetVideo[];
}

export interface FetchedTweet {
  id: string;
  url: string;
  text: string;
  title: string;
  author: TweetAuthor;
  created_at: string;
  created_timestamp: number;
  likes: number;
  retweets: number;
  replies: number;
  views?: number;
  media?: TweetMedia;
  replying_to?: string;
  quote?: FetchedTweet;
  article?: any;
  is_note_tweet?: boolean;
  sourceType?: 'twitter' | 'wechat' | 'webpage';
  raw_text?: { text: string; display_text_range?: number[]; facets?: any[] };
}

export interface FxTwitterResponse {
  code: number;
  message: string;
  tweet?: FetchedTweet;
}

function upgradeImageUrl(url: string): string {
  return url.replace(/name=\w+/, 'name=orig');
}

function isAvatarUrl(url: string, authorAvatarUrl?: string): boolean {
  // Direct URL match against author's known avatar
  if (authorAvatarUrl && url === authorAvatarUrl) return true;
  // Known avatar hosting patterns
  if (url.includes('unavatar.io') ||
    url.includes('profile_images') ||
    /pbs\.twimg\.com\/profile_images\//.test(url)) return true;
  // Twitter avatar size suffixes in filename
  if (/_(normal|mini|bigger|x96|400x400|200x200)(\.[a-z]+)?(?:\?|$)/i.test(url)) return true;
  // Same base path as author avatar (different size variant)
  if (authorAvatarUrl) {
    try {
      const cand = new URL(url);
      const auth = new URL(authorAvatarUrl);
      if (cand.hostname === auth.hostname &&
          cand.pathname.replace(/_[^_/.]+(\.[a-z]+)?$/, '$1') === auth.pathname.replace(/_[^_/.]+(\.[a-z]+)?$/, '$1')) {
        return true;
      }
    } catch {}
  }
  return false;
}

function parseJinaAiContent(rawText: string, parsed: ParsedTweetUrl): { title: string; text: string; photos: TweetPhoto[] } {
  const photos: TweetPhoto[] = [];

  let content = rawText;

  // Handle linked images: [![desc](thumb) optional text](full)
  // Use thumb (pbs.twimg.com direct URL) instead of full (x.com redirect).
  // For article cards the outer link contains the title/excerpt as plain text,
  // so keep that text alongside the image marker.
  content = content.replace(
    /\[(!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*([^\]]*))\]\((https?:\/\/[^\s)]+)\)/g,
    (_, _inner, desc, thumbUrl, extraText, _fullUrl) => {
      if (isAvatarUrl(thumbUrl)) return '';
      const existing = photos.findIndex(p => p.url === upgradeImageUrl(thumbUrl));
      const idx = existing >= 0 ? existing : photos.push({ url: upgradeImageUrl(thumbUrl), width: 0, height: 0 }) - 1;
      const combined = `${desc} ${extraText}`.replace(/^Image\s*\d+\s*:\s*Article cover image\s*/i, '').replace(/^Image\s*\d+\s*:\s*/i, '').trim();
      if (!combined) return `[IMG:${idx}]`;
      return `${combined}\n\n[IMG:${idx}]`;
    }
  );

  // Handle simple images: ![...](url)
  content = content.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, _desc, url) => {
      if (isAvatarUrl(url)) return '';
      const existing = photos.findIndex(p => p.url === url);
      if (existing >= 0) return `[IMG:${existing}]`;
      const finalUrl = url.includes('pbs.twimg.com') ? upgradeImageUrl(url) : url;
      photos.push({ url: finalUrl, width: 0, height: 0 });
      return `[IMG:${photos.length - 1}]`;
    }
  );

  // Extract title from "Title: xxx" line
  const titleMatch = rawText.match(/^Title:\s*(.+)$/m);
  let title = titleMatch ? titleMatch[1].trim() : '';

  // Extract the quoted content as the real title
  const quoteMatch = title.match(/["']([^"']+)["']/);
  if (quoteMatch) {
    title = quoteMatch[1].trim();
  } else if (title.includes('on X:')) {
    title = title.replace(/^.*?on\s+X:\s*/, '').trim();
  }

  title = title.replace(/\s*\/\s*X\s*$/, '').trim();

  // Extract content after "Markdown Content:"
  const mdContentMatch = content.match(/Markdown Content:\s*([\s\S]*)$/i);
  if (mdContentMatch) {
    content = mdContentMatch[1].trim();
  }

  // Jina AI markdown format: find content after Conversation marker
  const convMatch = content.match(/^#{1,2}\s*Conversation\s*$/m);
  if (convMatch && convMatch.index !== undefined) {
    content = content.substring(convMatch.index + convMatch[0].length).trim();
  }
  // Remove noise lines but keep headings and content
  content = content.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return true; // keep empty lines for paragraph breaks
    // Remove UI noise: short x.com links, profile refs, stats numbers
    if (/^\[!?\[/.test(t) && /x\.com/.test(t)) return false; // image/avatar links
    if (/^\[\d+K?\]\(/.test(t)) return false; // stat links
    if (/^\d{1,3}(,\d{3})*$/.test(t)) return false; // standalone numbers
    if (t === 'See new posts' || t.startsWith('Don') || t.startsWith('People on X')) return false;
    if (/Log\s+in.*Sign\s+up/.test(t)) return false;
    if (/^#{1,6}\s*Post\s*$/i.test(t)) return false;
    if (/^\[\d{1,2}:\d{2}\s+(AM|PM)/i.test(t)) return false; // timestamp line
    if (/^\[.+/.test(t) && /\d+\.?\d*K?\s*Views\]$/.test(t)) return false; // views line
    if (/^\[.+\]\(http/.test(t) && t.length < 80) return false; // short markdown links
    return true;
  }).join('\n').trim();
  // Remove any remaining x.com URL parts
  content = content.replace(/\((https?:\/\/x\.com\/[^)]+)\)/gi, '');
  content = content.replace(/\[\]\([^)]*\)/g, '');
  // Footer cut-off
  const footerIdx = content.search(/^#{1,2}\s*New to X\?/m);
  if (footerIdx >= 0) content = content.substring(0, footerIdx).trim();
  content = content.replace(/^#{1,2}\s*(Relevant people|Trending now|What.s happening).*$/gim, '');
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  // If content is still empty, try other approaches
  if (content.length < 10) {
    const lines = rawText.split('\n').filter(line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (trimmed.startsWith('Title:')) return false;
      if (trimmed.startsWith('URL Source:')) return false;
      if (trimmed.startsWith('Published Time:')) return false;
      if (trimmed.startsWith('Warning:')) return false;
      if (trimmed.startsWith('Markdown Content:')) return false;
      return true;
    });
    content = lines.join('\n').trim();
  }

  if (content.length < 10) {
    content = rawText
      .replace(/^Title:.*$/gm, '')
      .replace(/^URL Source:.*$/gm, '')
      .replace(/^Published Time:.*$/gm, '')
      .replace(/^Warning:.*$/gm, '')
      .replace(/^Markdown Content:.*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if ((!title || title.startsWith('https://t.co/')) && content) {
    title = deriveTitle(content, 80) || title;
  }

  if (!title) {
    title = `${parsed.username} 的推文`;
  }

  return { title, text: content || rawText, photos };
}

/** Apply entity links and inline styles to a block's text.
 *  Processes entityRanges (LINK → markdown) and inlineStyleRanges
 *  together, right-to-left by offset so overlapping ranges nest correctly. */
function applyInlineFormatting(
  text: string,
  entityRanges: Array<{ key: number; length: number; offset: number }> | undefined,
  inlineStyleRanges: Array<{ offset: number; length: number; style: string }> | undefined,
  entityMap: Map<number, any>,
): string {
  const mods: Array<{ offset: number; end: number; prefix: string; suffix: string }> = [];

  // Collect entity-based modifications (LINK, TWEET)
  for (const r of (entityRanges || [])) {
    const ent = entityMap.get(r.key);
    if (!ent) continue;
    if (ent.type === 'LINK' && ent.data?.url) {
      mods.push({ offset: r.offset, end: r.offset + r.length, prefix: '[', suffix: `](${ent.data.url})` });
    } else if (ent.type === 'TWEET') {
      const url = ent.data?.url || (ent.data?.tweetId ? `https://x.com/i/status/${ent.data.tweetId}` : '');
      if (url) {
        mods.push({ offset: r.offset, end: r.offset + r.length, prefix: '[', suffix: `](${url})` });
      }
    }
  }

  // Collect inline-style modifications
  for (const r of (inlineStyleRanges || [])) {
    let prefix = ''; let suffix = '';
    switch (r.style) {
      case 'Bold': prefix = '**'; suffix = '**'; break;
      case 'Italic': prefix = '*'; suffix = '*'; break;
      case 'Underline': prefix = '<u>'; suffix = '</u>'; break;
      case 'Strikethrough': prefix = '~~'; suffix = '~~'; break;
      case 'Code': prefix = '`'; suffix = '`'; break;
    }
    if (prefix) mods.push({ offset: r.offset, end: r.offset + r.length, prefix, suffix });
  }

  // Apply right-to-left so each modification leaves earlier offsets intact
  mods.sort((a, b) => b.offset - a.offset);
  for (const m of mods) {
    text = text.substring(0, m.offset) + m.prefix + text.substring(m.offset, m.end) + m.suffix + text.substring(m.end);
  }

  return text;
}

function parseDraftJsBlocks(blocks: Array<{ text: string; type: string; depth?: number; entityRanges?: Array<{ key: number; length: number; offset: number }>; inlineStyleRanges?: Array<{ offset: number; length: number; style: string }> }>, entityMap: Map<number, any>): string {
  let result = '';
  let inCodeBlock = false;
  let inOList = false;
  let inUList = false;
  let listCounter = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextBlock = blocks[i + 1];
    const type = block.type;

    // Close code block if next is not code-block
    if (inCodeBlock && type !== 'code-block') {
      result += '\n```\n\n';
      inCodeBlock = false;
    }

    // Close ordered list if next is not ordered-list-item
    if (inOList && type !== 'ordered-list-item') {
      inOList = false;
      listCounter = 0;
      if (type !== 'unordered-list-item') result += '\n';
    }

    // Close unordered list if next is not unordered-list-item
    if (inUList && type !== 'unordered-list-item') {
      inUList = false;
      if (type !== 'ordered-list-item') result += '\n';
    }

    switch (type) {
      case 'atomic': {
        const ranges = block.entityRanges || [];
        let atomicContent = '';
        for (const r of ranges) {
          const ent = entityMap.get(r.key);
          if (!ent) continue;
          switch (ent.type) {
            case 'MARKDOWN':
              atomicContent += (ent.data?.markdown || '').trim() + '\n\n';
              break;
            case 'DIVIDER':
              atomicContent += '---\n\n';
              break;
            case 'IMAGE':
              atomicContent += '[IMG]\n\n';
              break;
            case 'VIDEO':
              atomicContent += '[VIDEO]\n\n';
              break;
            case 'MEDIA': {
              // Check mediaCategory to distinguish image vs video
              const items = ent.data?.mediaItems || [];
              const isVideo = items.some((item: any) => item.mediaCategory === 'AmplifyVideo');
              atomicContent += (isVideo ? '[VIDEO]' : '[IMG]') + '\n\n';
              break;
            }
            case 'LINK':
              if (ent.data?.url) {
                const linkTitle = ent.data.title || ent.data.url;
                const linkUrl = ent.data.url;
                atomicContent += '[' + linkTitle + '](' + linkUrl + ')\n\n';
              }
              break;
            case 'TWEET':
              if (ent.data?.url) {
                atomicContent += '[Embedded Tweet](' + ent.data.url + ')\n\n';
              } else if (ent.data?.tweetId) {
                atomicContent += '[Embedded Tweet](https://x.com/i/status/' + ent.data.tweetId + ')\n\n';
              }
              break;
            case 'TWEMOJI':
              if (ent.data?.emoji) {
                atomicContent += ent.data.emoji;
              }
              break;
            default:
              atomicContent += '[IMG]\n\n';
          }
        }
        if (!atomicContent) {
          atomicContent += '[IMG]\n\n';
        }
        result += atomicContent;
        continue;
      }

      case 'header-one':
        result += `# ${applyInlineFormatting(block.text, block.entityRanges, block.inlineStyleRanges, entityMap)}\n\n`;
        continue;

      case 'header-two':
        result += `## ${applyInlineFormatting(block.text, block.entityRanges, block.inlineStyleRanges, entityMap)}\n\n`;
        continue;

      case 'header-three':
        result += `### ${applyInlineFormatting(block.text, block.entityRanges, block.inlineStyleRanges, entityMap)}\n\n`;
        continue;

      case 'code-block': {
        if (!inCodeBlock) {
          inCodeBlock = true;
          result += '```\n';
        }
        result += block.text + '\n';
        continue;
      }

      case 'blockquote':
        result += `> ${applyInlineFormatting(block.text, block.entityRanges, block.inlineStyleRanges, entityMap)}\n\n`;
        continue;

      case 'ordered-list-item': {
        inOList = true;
        listCounter++;
        const indent = '   '.repeat(block.depth || 0);
        result += `${indent}${listCounter}. ${applyInlineFormatting(block.text, block.entityRanges, block.inlineStyleRanges, entityMap)}\n`;
        if (!nextBlock || nextBlock.type !== 'ordered-list-item') {
          inOList = false;
          listCounter = 0;
          result += '\n';
        }
        continue;
      }

      case 'unordered-list-item': {
        inUList = true;
        const indent = '   '.repeat(block.depth || 0);
        result += `${indent}- ${applyInlineFormatting(block.text, block.entityRanges, block.inlineStyleRanges, entityMap)}\n`;
        if (!nextBlock || nextBlock.type !== 'unordered-list-item') {
          inUList = false;
          result += '\n';
        }
        continue;
      }

      case 'unstyled':
      default: {
        const text = applyInlineFormatting(block.text, block.entityRanges, block.inlineStyleRanges, entityMap);
        if (text.trim()) {
          result += text + '\n\n';
        } else {
          result += '\n';
        }
      }
    }
  }

  // Close any remaining code block
  if (inCodeBlock) result += '```\n';

  return result.trim();
}

/** Strip X Article metadata / UI boilerplate from the end of parsed article text.
 *  X Articles embed platform UI elements (view counts, timestamps, reply settings,
 *  "Want to publish your own Article?" calls-to-action) as unstyled Draft.js blocks,
 *  which leak into the rendered content. This function removes them from the trail. */
function cleanXArticleBoilerplate(text: string): string {
  const boilerplatePatterns = [
    /^Want to publish your own Article\?$/,
    /^Only some accounts can reply\.$/,
    /^·\s*[\d,]+\.?\d*[KMB]?\s*Views$/,
    /^·\s*[\d,]+\.?\d*[KMB]?\s*(?:Views|Likes|Reposts|Comments)$/,
    /^\d{1,2}:\d{2}\s*[AP]M\s*·\s*[A-Z][a-z]+\s+\d{1,2},?\s*\d{4}$/,
    /^Reply$/,
    /^Sort by$/i,
    /^Most relevant/i,
    /^Latest/i,
  ];
  const lines = text.split('\n');
  let endIdx = lines.length;
  while (endIdx > 0) {
    const trimmed = lines[endIdx - 1].trim();
    if (!trimmed || boilerplatePatterns.some(p => p.test(trimmed))) {
      endIdx--;
    } else {
      break;
    }
  }
  if (endIdx < lines.length) {
    return lines.slice(0, endIdx).join('\n').trim();
  }
  return text;
}

function parseArticleContent(article: any): { title: string; text: string; photos: TweetPhoto[]; videos: TweetVideo[] } {
  const title = article.title || '';
  let text = '';
  const photos: TweetPhoto[] = [];
  const videos: TweetVideo[] = [];

  // Build entityMap from the entityMap list (key → value)
  const entityMap = new Map<number, any>();
  const rawEntityMap = article.content?.entityMap || [];
  for (const entry of rawEntityMap) {
    const key = parseInt(entry.key, 10);
    if (!isNaN(key)) entityMap.set(key, entry.value);
  }

  if (article.content?.blocks) {
    text = parseDraftJsBlocks(article.content.blocks, entityMap);
    text = cleanXArticleBoilerplate(text);
  }

  // Map media_entities to photos/videos
  if (article.media_entities) {
    for (const ent of article.media_entities) {
      const mi = ent.media_info;
      if (!mi) continue;
      if (mi.__typename === 'ApiImage' && mi.original_img_url) {
        photos.push({ url: mi.original_img_url, width: mi.original_img_width || 0, height: mi.original_img_height || 0 });
      } else if (mi.__typename === 'ApiVideo') {
        // variants are directly on media_info (not nested under video_info)
        const variants = mi.variants || [];
        const mp4Variants = variants.filter((v: any) => v.content_type === 'video/mp4');
        const bestVariant = mp4Variants.length > 0
          ? mp4Variants.reduce((best: any, v: any) => (v.bitrate || 0) > (best.bitrate || 0) ? v : best, mp4Variants[0])
          : variants[0];
        videos.push({
          url: bestVariant?.url || '',
          thumbnail_url: mi.preview_image || mi.original_img_url || '',
          width: mi.original_img_width || 0,
          height: mi.original_img_height || 0,
        });
      }
    }
  }

  // Replace [IMG] and [VIDEO] placeholders with indexed markers
  let imgIdx = 0;
  let vidIdx = 0;
  text = text.replace(/\[IMG\]/g, () => `[IMG:${imgIdx++}]`);
  text = text.replace(/\[VIDEO\]/g, () => `[VIDEO:${vidIdx++}]`);

  // If there's a cover_media, prepend it as first image
  if (article.cover_media?.media_info?.original_img_url) {
    photos.unshift({
      url: article.cover_media.media_info.original_img_url,
      width: article.cover_media.media_info.original_img_width || 0,
      height: article.cover_media.media_info.original_img_height || 0,
    });
    // Adjust IMG indices
    text = text.replace(/\[IMG:(\d+)\]/g, (_, n) => `[IMG:${parseInt(n) + 1}]`);
    text = `[IMG:0]\n\n${text}`;
  }

  return { title, text, photos, videos };
}

async function fetchFromFxTwitter(parsed: ParsedTweetUrl): Promise<FetchedTweet> {
  const apiUrl = getFxTwitterApiUrl(parsed.username, parsed.tweetId);

  const response = await axios.get<FxTwitterResponse>(apiUrl, {
    headers: { 'User-Agent': 'TweetArchive/1.0' },
    timeout: 15000,
    httpsAgent: getAgent(),
  });

  if (response.data.code !== 200 || !response.data.tweet) {
    throw new Error(`FxTwitter API error: ${response.data.message}`);
  }

  const tweet = response.data.tweet;

  // Handle Twitter Article — content is in article field.
  // X Article 发布推文的 text 常只是预览（preview_text，几十到一百多字符），
  // 完整正文在 article 里。只要 article 解析出的正文更长（信息更完整），
  // 就采用 article 正文；否则保留原 text（普通推文或 GraphQL 空 content_state）。
  let text = tweet.text;
  let title = '';
  let articlePhotos: TweetPhoto[] = [];
  let articleVideos: TweetVideo[] = [];
  if (tweet.article) {
    const articleData = parseArticleContent(tweet.article);
    const articleText = articleData.text || '';
    if (articleText && articleText.trim().length > (text || '').trim().length) {
      text = articleText;
      title = articleData.title;
      articlePhotos = articleData.photos;
      articleVideos = articleData.videos;
    }
  }

  // Link-card tweet OR X Article with incomplete FxTwitter content:
  // use GraphQL auth endpoint to fetch full body.
  // X Articles don't carry a t.co URL in raw_text, so we can't rely on
  // that signal alone — also trigger when tweet.article existed but
  // the parsed content is still short.
  const textIsShort = !text || text.trim().length <= 30;
  const hasTcoUrl = tweet.raw_text?.text?.includes('t.co');
  const articleHadNoContent = textIsShort && !!tweet.article;  // article field present but content empty
  if (textIsShort && (hasTcoUrl || articleHadNoContent)) {
    const gqlArticle = await fetchArticleViaGraphQL(tweet.id);
    const gqlText = gqlArticle?.text?.trim() || '';
    const gqlTextIsLong = gqlText.length > 100;

    if (gqlTextIsLong) {
      // GraphQL returned full content (blocks with meaningful body length)
      text = gqlText;
      title = gqlArticle!.title || title;
      articlePhotos = gqlArticle!.photos || [];
      articleVideos = gqlArticle!.videos || [];
    } else if (gqlText) {
      // GraphQL returned only preview_text — try Playwright for full body.
      // Keep GraphQL result as fallback: prefer the longer source.
      const pwResult = await fetchArticleViaPlaywright(tweet.url);
      const pwText = pwResult?.text?.trim() || '';
      if (pwText && pwText.length > gqlText.length) {
        text = pwText;
        title = pwResult?.title || gqlArticle?.title || title;
        articlePhotos = pwResult?.photos || [];
        articleVideos = pwResult?.videos || [];
      } else if (gqlText) {
        text = gqlText;
        title = gqlArticle!.title || title;
        articlePhotos = gqlArticle!.photos || [];
        articleVideos = gqlArticle!.videos || [];
      }
    }
  }

  if (!title && tweet.title) {
    title = tweet.title;
  }
  if (!title) {
    title = deriveTitle(text, 80) || `${tweet.author.name} 的推文`;
  }

  // Diagnostic: warn when the final text is still suspiciously short after all fallbacks.
  // This helps identify cases where the fetch pipeline didn't find full article content.
  if (text && text.trim().length > 0 && text.trim().length < 100) {
    console.warn(
      `[fx-tw] tweet ${tweet.id} final text only ${text.trim().length} chars — ` +
      `article=${!!tweet.article} raw_tco=${tweet.raw_text?.text?.includes('t.co')} ` +
      `title="${title?.substring(0, 40)}" author=${tweet.author?.screen_name}`
    );
  }

  // Merge article photos/videos with tweet media
  const mergedTweet = { ...tweet, text, title };
  // Store original pbs.twimg.com URL for downloading; use unavatar.io for display fallback
  mergedTweet.author = {
    ...mergedTweet.author,
    original_avatar_url: mergedTweet.author.avatar_url, // keep original for download
    avatar_url: `https://unavatar.io/x/${mergedTweet.author.screen_name}`,
  };
  if (articlePhotos.length > 0) {
    mergedTweet.media = {
      ...(tweet.media || {}),
      photos: [...articlePhotos, ...(tweet.media?.photos || [])],
    };
  }
  if (articleVideos.length > 0) {
    mergedTweet.media = {
      ...(mergedTweet.media || {}),
      videos: [...articleVideos, ...(tweet.media?.videos || [])],
    };
  }

  return expandQuoteOrRetweet(mergedTweet);
}

async function fetchFromJinaAi(parsed: ParsedTweetUrl): Promise<FetchedTweet> {
  const jinaUrl = `https://r.jina.ai/http://x.com/${parsed.username}/status/${parsed.tweetId}`;

  const response = await axios.get<string>(jinaUrl, {
    headers: { 'User-Agent': 'TweetArchive/1.0', 'X-Return-Format': 'markdown' },
    timeout: 20000,
    httpsAgent: getAgent(),
  });

  const rawText = response.data;
  const jinaResult = parseJinaAiContent(rawText, { username: parsed.username, tweetId: parsed.tweetId, originalUrl: parsed.originalUrl });

  const authorMatch = rawText.match(/^Title:\s*(.+?)\s+on\s+X:/m);
  const authorName = authorMatch ? authorMatch[1].trim() : parsed.username;
  const timeMatch = rawText.match(/^Published Time:\s*(.+)$/m);
  const publishTime = timeMatch ? timeMatch[1].trim() : '';

  return {
    id: parsed.tweetId,
    url: parsed.originalUrl,
    title: jinaResult.title,
    text: jinaResult.text,
    author: {
      name: authorName,
      screen_name: parsed.username,
      avatar_url: `https://unavatar.io/x/${parsed.username}`,
    },
    created_at: publishTime || new Date().toUTCString(),
    created_timestamp: publishTime ? Math.floor(new Date(publishTime).getTime() / 1000) : Math.floor(Date.now() / 1000),
    likes: 0,
    retweets: 0,
    replies: 0,
    media: jinaResult.photos.length > 0 ? { photos: jinaResult.photos } : undefined,
  };
}

async function fetchFromOembed(parsed: ParsedTweetUrl): Promise<FetchedTweet> {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(parsed.originalUrl)}&omit_script=true`;

  const response = await axios.get<{ html: string; author_name: string; url?: string }>(oembedUrl, {
    headers: { 'User-Agent': 'TweetArchive/1.0' },
    timeout: 15000,
    httpsAgent: getAgent(),
  });

  const html = response.data.html || '';
  const textMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : html.replace(/<[^>]+>/g, '').trim();
  const title = deriveTitle(text, 80) || `${response.data.author_name || parsed.username} 的推文`;

  return {
    id: parsed.tweetId,
    url: parsed.originalUrl,
    title,
    text,
    author: {
      name: response.data.author_name || parsed.username,
      screen_name: parsed.username,
      avatar_url: `https://unavatar.io/x/${parsed.username}`,
    },
    created_at: new Date().toUTCString(),
    created_timestamp: Math.floor(Date.now() / 1000),
    likes: 0,
    retweets: 0,
    replies: 0,
  };
}

interface AuthorReply {
  id: string;
  text: string;
  createdAt: string;
  photos: TweetPhoto[];
  videos: TweetVideo[];
}

const COMMENT_PROMPT_DIR = path.join(process.cwd(), 'prompts', 'comments');
const commentPromptCache = new Map<string, string>();
function loadCommentPrompt(name: string): string {
  if (!commentPromptCache.has(name)) {
    commentPromptCache.set(name, fs.readFileSync(path.join(COMMENT_PROMPT_DIR, name), 'utf-8'));
  }
  return commentPromptCache.get(name)!;
}

/** AI 判断推文正文是否「明显未完结」——作者把内容放评论区,正文只是引子/预告。 */
async function judgeBodyIncomplete(body: string): Promise<boolean> {
  const prompt = loadCommentPrompt('detect-incomplete.md');
  const res = await chatWithJson<{ incomplete: boolean; reason?: string }>(
    [{ role: 'system', content: prompt.replace('<BODY>', body) }],
    { temperature: 0.1, maxTokens: 300 }
  );
  return !!res?.incomplete;
}

/** 提取回复推文里的媒体(FxTwitter full_text 的 extended_entities) */
function extractReplyMedia(legacy: any): { photos: TweetPhoto[]; videos: TweetVideo[] } {
  const photos: TweetPhoto[] = [];
  const videos: TweetVideo[] = [];
  const mediaArr = legacy?.extended_entities?.media || legacy?.entities?.media || [];
  for (const m of mediaArr) {
    if (m?.type === 'photo' && m.media_url_https) {
      photos.push({
        url: upgradeImageUrl(m.media_url_https),
        width: m.original_info?.width || 0,
        height: m.original_info?.height || 0,
      });
    } else if (m?.type === 'video' || m?.type === 'animated_gif') {
      const variants = m?.video_info?.variants || [];
      const mp4 = variants.filter((v: any) => v?.content_type === 'video/mp4' && v.url);
      const best = mp4.length
        ? mp4.reduce((a: any, b: any) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a, mp4[0])
        : variants.find((v: any) => v.url);
      if (best?.url) {
        videos.push({
          url: best.url,
          thumbnail_url: m.media_url_https || '',
          width: m.original_info?.width || 0,
          height: m.original_info?.height || 0,
        });
      }
    }
  }
  return { photos, videos };
}

/** 递归收集会话模块 items 里的作者自回帖(过滤:作者本人、非焦点推文、去重、长度≥15 去闲聊)。 */
function collectAuthorRepliesFromItems(
  items: any[], focalTweetId: string, authorScreenName: string, seen: Set<string>
): AuthorReply[] {
  const out: AuthorReply[] = [];
  const walk = (arr: any[]) => {
    for (const it of arr) {
      const ic = it?.item?.itemContent || it?.itemContent;
      const result = ic?.tweet_results?.result;
      if (result) {
        const t = result.tweet || result;
        const legacy = t?.legacy;
        if (legacy) {
          const id = t.rest_id || legacy.id_str;
          const screenName = t?.core?.user_results?.result?.core?.screen_name || '';
          if (
            id && id !== focalTweetId &&
            screenName && screenName.toLowerCase() === authorScreenName.toLowerCase() &&
            !seen.has(id)
          ) {
            const text = (legacy.full_text || legacy.text || '').trim();
            if (text.length >= 15) {  // 过滤"收到"/纯 emoji 等闲聊
              seen.add(id);
              const { photos, videos } = extractReplyMedia(legacy);
              out.push({ id, text, createdAt: legacy.created_at || '', photos, videos });
            }
          }
        }
      }
      // 嵌套续聊(评论的评论)
      if (it?.item?.items) walk(it.item.items);
      if (it?.item?.itemContent?.items) walk(it.item.itemContent.items);
      if (it?.items) walk(it.items);
    }
  };
  walk(items);
  return out;
}

/** 走已认证 GraphQL TweetDetail 端点抓取作者在评论区的自回帖。bounded 分页(≤3 页,无 bottom cursor 即停)。 */
async function fetchAuthorSelfReplies(tweetId: string, authorScreenName: string): Promise<AuthorReply[]> {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  if (!authToken) return [];
  const headers: Record<string, string> = {
    'User-Agent': 'TweetArchive/1.0',
    'authorization': `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'cookie': `auth_token=${authToken}; ct0=${ct0 || ''};`,
    'x-csrf-token': ct0 || '',
  };

  const replies: AuthorReply[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const MAX_PAGES = 3;

  for (let page = 0; page < MAX_PAGES; page++) {
    const variables: Record<string, unknown> = {
      focalTweetId: tweetId,
      with_rux_injections: false,
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withArticleRichContent: true,
      withBirdwatchNotes: false,
      withVoice: true,
      withDownvotePerspective: false,
      withReactionsMetadata: false,
      withReactionsPerspective: false,
    };
    if (cursor) variables.cursor = cursor;

    let data: any;
    try {
      const res = await axiosGetWithRetry(
        `https://x.com/i/api/graphql/iFEr5AcP121Og4wx9Yqo3w/TweetDetail`,
        {
          params: {
            variables: JSON.stringify(variables),
            features: JSON.stringify(DEFAULT_FEATURES),
          },
          headers,
          timeout: 15000,
          httpsAgent: getAgent(),
        },
        'fetchAuthorReplies'
      );
      data = res.data?.data?.threaded_conversation_with_injections_v2;
    } catch (err) {
      console.warn(`[comments] TweetDetail page ${page} failed: ${err instanceof Error ? err.message : err}`);
      break;
    }
    if (!data) break;

    let nextCursor: string | undefined;
    const instructions = data.instructions || [];
    for (const inst of instructions) {
      const entries = inst.entries || inst.moduleItems || [];
      for (const entry of entries) {
        const content = entry.content || {};
        if (content.entryType === 'TimelineTimelineModule' && Array.isArray(content.items)) {
          replies.push(...collectAuthorRepliesFromItems(content.items, tweetId, authorScreenName, seen));
        } else if (entry.entryId?.includes('cursor-bottom')) {
          const c = content.operation?.cursor;
          if (c?.value) nextCursor = c.value;
        }
      }
    }
    if (!nextCursor || nextCursor === cursor) break;  // 无更多页
    cursor = nextCursor;
  }

  // 阅读顺序:时间升序
  replies.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return replies;
}

/** LLM 过滤:只保留「文章正文延续」的评论,丢弃闲聊/广告(如推广贴)。判断失败时保守全保留。 */
async function filterArticleReplies(replies: AuthorReply[]): Promise<AuthorReply[]> {
  if (replies.length <= 1) return replies;
  try {
    const prompt = loadCommentPrompt('filter-replies.md');
    const labeled = replies.map((r, i) => `[${i + 1}] ${r.text}`).join('\n\n');
    const res = await chatWithJson<{ keep?: number[]; drop?: number[] }>(
      [{ role: 'system', content: prompt.replace('<REPLIES>', labeled) }],
      { temperature: 0.1, maxTokens: 500 }
    );
    // LLM 可能返回数字(1)或标签字符串("[1]")——统一解析为 0-based 索引
    const toIndex = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d-]/g, ''), 10);
      return Number.isFinite(n) ? n - 1 : null;
    };
    const keepSet = new Set(
      (res?.keep || []).map(toIndex).filter((n): n is number => n !== null && n >= 0)
    );
    if (keepSet.size === 0) return replies;  // 判定异常,保守保留全部
    return replies.filter((_, i) => keepSet.has(i));
  } catch (err) {
    console.warn(`[comments] 评论过滤失败,保守保留全部: ${err instanceof Error ? err.message : err}`);
    return replies;
  }
}

/** 把作者自回帖合并进正文:blockquote 区块 + 评论媒体重索引。镜像 mergeEmbeddedArticle 的媒体处理。 */
function mergeAuthorReplies(tweet: FetchedTweet, replies: AuthorReply[]): FetchedTweet {
  const mergedPhotos: TweetPhoto[] = [...(tweet.media?.photos || [])];
  const mergedVideos: TweetVideo[] = [...(tweet.media?.videos || [])];
  const parts: string[] = [];
  for (const r of replies) {
    let rt = r.text;
    // 去掉结尾的 t.co 媒体链接(避免图片/视频 URL 原文重复)
    rt = rt.replace(/https?:\/\/t\.co\/\w+$/g, '').trim();
    if (!rt) continue;
    for (const p of r.photos) {
      const newIdx = mergedPhotos.length;
      mergedPhotos.push(p);
      rt += `\n[IMG:${newIdx}]`;
    }
    for (const v of r.videos) {
      const newIdx = mergedVideos.length;
      mergedVideos.push(v);
      rt += `\n[VIDEO:${newIdx}]`;
    }
    parts.push(rt.split('\n').map(l => `> ${l}`).join('\n'));
  }
  if (parts.length === 0) return tweet;
  return {
    ...tweet,
    text: `${tweet.text}\n\n---\n\n**作者在评论区的补充**\n\n${parts.join('\n\n')}`,
    media: mergedPhotos.length || mergedVideos.length
      ? { photos: mergedPhotos, videos: mergedVideos }
      : tweet.media,
  };
}

/** 作者评论区内容合并入口:正文明显未完结时抓作者自回帖并入正文。任一步失败降级返回原推文,绝不阻塞归档。 */
export async function maybeMergeAuthorComments(tweet: FetchedTweet): Promise<FetchedTweet> {
  if (!process.env.X_AUTH_TOKEN || !isLlmEnabled()) return tweet;
  const body = (tweet.text || '').trim();
  if (!body) return tweet;
  if (!tweet.author?.screen_name) return tweet;
  try {
    const incomplete = await judgeBodyIncomplete(body);
    if (!incomplete) {
      console.log(`[comments] 完整性判断:正文已完结,跳过评论合并 tweet ${tweet.id}`);
      return tweet;
    }
    console.log(`[comments] 完整性判断:正文未完结,抓取作者评论 tweet ${tweet.id}`);
  } catch (err) {
    console.warn(`[comments] 完整性判断失败,跳过: ${err instanceof Error ? err.message : err}`);
    return tweet;
  }
  try {
    let replies = await fetchAuthorSelfReplies(tweet.id, tweet.author.screen_name);
    console.log(`[comments] 抓取到 ${replies.length} 条作者评论 tweet ${tweet.id}`);
    if (replies.length === 0) return tweet;
    const before = replies.length;
    replies = await filterArticleReplies(replies);
    console.log(`[comments] 过滤 ${before} → ${replies.length} 条 tweet ${tweet.id}`);
    if (replies.length === 0) return tweet;
    console.log(`[comments] 合并 ${replies.length} 条作者评论(过滤前 ${before}) → tweet ${tweet.id}`);
    return mergeAuthorReplies(tweet, replies);
  } catch (err) {
    console.warn(`[comments] 抓取作者评论失败,保留原文: ${err instanceof Error ? err.message : err}`);
    return tweet;
  }
}

export async function fetchTweet(parsed: ParsedTweetUrl): Promise<FetchedTweet> {
  const errors: string[] = [];
  let fxStats: Partial<FetchedTweet> | null = null;

  try {
    const tweet = await fetchFromFxTwitter(parsed);
    if (tweet.text && tweet.text.trim().length > 10) {
      return await maybeMergeAuthorComments(tweet);
    }
    fxStats = {
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      views: tweet.views,
      media: tweet.media,
      author: tweet.author,
    };
    errors.push(`FxTwitter: returned empty text, falling back`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`FxTwitter: ${msg}`);
  }

  try {
    const tweet = await fetchFromJinaAi(parsed);
    if (fxStats) {
      tweet.likes = fxStats.likes || 0;
      tweet.retweets = fxStats.retweets || 0;
      tweet.replies = fxStats.replies || 0;
      tweet.views = fxStats.views;
      if (fxStats.author) {
        // Use FxTwitter author info but keep unavatar.io for avatar (pbs.twimg.com blocked in CN)
        tweet.author = { ...fxStats.author, avatar_url: tweet.author.avatar_url };
      }
      // Prefer FxTwitter media (direct pbs.twimg.com URLs) over Jina AI (x.com redirects)
      if (fxStats.media?.photos && fxStats.media.photos.length > 0) {
        tweet.media = fxStats.media;
      }
    }
    return tweet;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Jina AI: ${msg}`);
  }

  try {
    const tweet = await fetchFromOembed(parsed);
    if (fxStats) {
      tweet.likes = fxStats.likes || 0;
      tweet.retweets = fxStats.retweets || 0;
      tweet.replies = fxStats.replies || 0;
      tweet.views = fxStats.views;
    }
    return tweet;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`oEmbed: ${msg}`);
  }

  throw new Error(`All fetch methods failed:\n${errors.join('\n')}`);
}

function extractWechatId(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/s/')) {
      return u.pathname.replace('/s/', '');
    }
    const biz = u.searchParams.get('__biz');
    const mid = u.searchParams.get('mid');
    if (biz && mid) return `${biz}_${mid}`;
    return Buffer.from(url).toString('base64url').substring(0, 20);
  } catch {
    return Buffer.from(url).toString('base64url').substring(0, 20);
  }
}

function extractUrlParam(url: string, param: string): string {
  try {
    return new URL(url).searchParams.get(param) || '';
  } catch {
    return '';
  }
}

/**
 * WeChat official-account HTML encodes code blocks as:
 *   <section class="code-snippet__fix">
 *     <ul class="code-snippet__line-index"><li></li>…</ul>  <!-- empty lis -->
 *     <pre data-lang="…"><code>line1</code><code>line2</code>…</pre>
 *   </section>
 * Without WeChat's CSS:
 *   1) empty <li>s render as browser disc bullets → vertical "• • •" above code
 *   2) sibling <code> stay display:inline → all lines collapse onto one row
 * Convert to a single standard fenced-style <pre><code> with real newlines.
 */
export function normalizeWechatCodeSnippets(html: string): string {
  if (!html || !/code-snippet__fix/i.test(html)) return html;

  const decodeEntities = (s: string): string =>
    s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, '&');

  const escapeText = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lineToText = (inner: string): string => {
    const plain = inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?span\b[^>]*>/gi, '')
      .replace(/<\/?[^>]+>/g, '');
    return decodeEntities(plain).replace(/\u00a0/g, ' ');
  };

  // Prefer full section (drops line-index ul). Fallback: bare pre with multi-code lines.
  let out = html.replace(
    /<section\b[^>]*\bcode-snippet__fix\b[^>]*>([\s\S]*?)<\/section>/gi,
    (_full, sectionInner: string) => {
      const preMatch = sectionInner.match(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/i);
      if (!preMatch) return sectionInner; // drop broken wrapper, keep body
      return flattenWechatPre(preMatch[1], preMatch[2], lineToText, escapeText);
    }
  );

  // Residual bare pre.code-snippet__* still multi-code (no section wrapper)
  out = out.replace(
    /<pre\b([^>]*\bcode-snippet__[^>]*)>([\s\S]*?)<\/pre>/gi,
    (_full, attrs: string, preInner: string) => {
      if (!/<code\b/i.test(preInner)) return _full;
      // already single code with newlines? keep if only one code child
      const codes = preInner.match(/<code\b/gi);
      if (!codes || codes.length <= 1) return _full;
      return flattenWechatPre(attrs, preInner, lineToText, escapeText);
    }
  );

  // Orphan line-index lists (should be gone with section replace; belt-and-suspenders)
  out = out.replace(
    /<ul\b[^>]*\bcode-snippet__line-index\b[^>]*>[\s\S]*?<\/ul>/gi,
    ''
  );

  return out;
}

function flattenWechatPre(
  attrs: string,
  preInner: string,
  lineToText: (inner: string) => string,
  escapeText: (s: string) => string
): string {
  const lines: string[] = [];
  const re = /<code\b[^>]*>([\s\S]*?)<\/code>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(preInner)) !== null) {
    lines.push(lineToText(m[1]));
  }
  if (lines.length === 0) {
    // No code children — strip tags, keep text
    const text = lineToText(preInner);
    if (!text.trim()) return '';
    return `<pre><code>${escapeText(text)}</code></pre>`;
  }
  const lang =
    (attrs.match(/\bdata-lang=["']([^"']+)["']/i) || [])[1] ||
    (attrs.match(/\blanguage-([a-z0-9_+-]+)/i) || [])[1] ||
    '';
  const classAttr = lang ? ` class="language-${lang.replace(/[^a-zA-Z0-9_+-]/g, '')}"` : '';
  const dataAttr = lang ? ` data-lang="${lang.replace(/"/g, '')}"` : '';
  const body = escapeText(lines.join('\n'));
  return `<pre${classAttr}${dataAttr}><code>${body}</code></pre>`;
}

export async function fetchWechatArticle(url: string): Promise<FetchedTweet> {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: 15000,
    httpsAgent: getAgent(),
    maxRedirects: 5,
  });

  const html = response.data as string;

  // Title: var msg_title = htmlDecode('xxx') — string inside is still entity-encoded;
  // WeChat runs htmlDecode at runtime; we must normalizeScrapedText ourselves.
  let title = '';
  const titleMatch = html.match(/var msg_title\s*=\s*htmlDecode\(['"](.+?)['"]\)/);
  if (titleMatch) {
    title = titleMatch[1];
  } else {
    const titleMatch2 = html.match(/var msg_title\s*=\s*['"](.+?)['"]/);
    if (titleMatch2) {
      title = titleMatch2[1];
    }
  }
  if (!title) {
    const h1Match = html.match(/<h1[^>]*class="rich_media_title"[^>]*>([\s\S]*?)<\/h1>/);
    if (h1Match) {
      title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }
  }
  // og:title fallback
  if (!title) {
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i);
    if (ogTitle) title = ogTitle[1];
  }
  title = normalizeScrapedText(title);
  // Guard: title truncation is done after content processing (see below).

  // Author — same htmlDecode / entity issue as title (e.g. 营销&amp;交易技术)
  let author = '';
  const authorMeta = html.match(/<meta[^>]*property="og:article:author"[^>]*content="([^"]*)"/i);
  if (authorMeta) {
    author = authorMeta[1];
  } else {
    const nicknameMatch = html.match(/var nickname\s*=\s*htmlDecode\(['"](.+?)['"]\)/);
    if (nicknameMatch) {
      author = nicknameMatch[1];
    } else {
      const nicknameMatch2 = html.match(/var nickname\s*=\s*['"](.+?)['"]/);
      if (nicknameMatch2) {
        author = nicknameMatch2[1];
      }
    }
  }
  // profile_nickname / nick_name variants
  if (!author) {
    const nick2 = html.match(/var\s+(?:profile_nickname|nick_name)\s*=\s*(?:htmlDecode\()?['"](.+?)['"]\)?/);
    if (nick2) author = nick2[1];
  }
  author = normalizeAuthorField(author);

  // Author avatar: try round_head_img (from cgiDataNew) first, then head_img_url
  let avatarUrl = '';
  const roundImgMatch = html.match(/(?:round_head_img|hd_head_img|head_img_url)\s*[=:]\s*['"]([^'"]+)['"]/);
  if (roundImgMatch) {
    avatarUrl = normalizeScrapedText(roundImgMatch[1]);
    if (avatarUrl.startsWith('//')) avatarUrl = 'https:' + avatarUrl;
  }

  // Publish time (Unix timestamp)
  let createdTimestamp = Math.floor(Date.now() / 1000);
  const ctMatch = html.match(/var (?:ct|svr_time)\s*=\s*['"]?(\d+)['"]?\s*;/);
  if (ctMatch) {
    createdTimestamp = parseInt(ctMatch[1], 10);
  }

  // Stats: read count, likes (在看), old likes (点赞), share count
  // Try variable patterns first (older WeChat articles), then API (newer ones)
  function extractNum(...patterns: RegExp[]): number {
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (!isNaN(n) && n > 0) return n;
      }
    }
    return 0;
  }
  // Multiple pattern variations for each stat
  const numVar = (name: string) => [
    new RegExp(`var\\s+${name}\\s*=\\s*['"\`](\\d[\\d,]*)['"\`]`),
    new RegExp(`var\\s+${name}\\s*=\\s*(\\d+)`),
    new RegExp(`"${name}"\\s*:\\s*(\\d+)`),
    new RegExp(`${name}\\s*=\\s*['"\`](\\d[\\d,]*)['"\`]`),
    new RegExp(`${name}\\s*=\\s*(\\d+)`),
  ];
  const readNum = extractNum(...numVar('read_num'));
  const likeNum = extractNum(...numVar('like_num'));
  const oldLikeNum = extractNum(...numVar('old_like_num'));
  const shareNum = extractNum(...numVar('share_num'));
  const commentNum = extractNum(
    ...numVar('comment_num'),
    ...numVar('comment_count'),
    ...numVar('reply_num'),
  );

  // Stats: modern WeChat articles load read/like/share counts via authenticated
  // APIs (e.g. mp/appmsg_comment, mp/frontendcommstore) that require logged-in
  // session cookies. Neither static HTML extraction nor headless browser requests
  // can retrieve them without a valid WeChat account session.
  // Known limitation: stats will be 0 for articles saved from short URLs.
  const finalReadNum = readNum;
  const finalLikeNum = likeNum;
  const finalOldLikeNum = oldLikeNum;
  console.log(`[wechat] Stats: read=${finalReadNum}, like=${finalLikeNum}, share=${shareNum}, comment=${commentNum} (auth required — not available)`);

  // Content: id="js_content"
  let contentHtml = '';
  const contentMatch = html.match(/<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div class="rich_media_tool"|<div id="js_tags)/);
  if (contentMatch) {
    contentHtml = contentMatch[1].trim();
  }
  // Fallback: try #rich_media_content (newer WeChat article templates)
  if (!contentHtml) {
    const fallbackMatch = html.match(/<div[^>]*id="rich_media_content"[^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div class="rich_media_tool"|<div id="js_tags)/);
    if (fallbackMatch) {
      contentHtml = fallbackMatch[1].trim();
      console.warn('[wechat] js_content empty — used rich_media_content fallback');
    }
  }

  // WeChat code blocks: multi-<code> lines + line-index <ul><li> bullets.
  // Without WeChat CSS those empty <li>s render as disc dots and lines collapse.
  contentHtml = normalizeWechatCodeSnippets(contentHtml);

  // Strip inline font-size from WeChat content (overrides CSS).
  // font-size values are plain numbers/units — safe to strip with simple regex.
  // font-family is deliberately NOT stripped: font names often contain quotes
  // (e.g. &quot;PingFang SC&quot;) that break naive regex replacement.
  contentHtml = contentHtml.replace(
    /\s*font-size\s*:\s*[^;'"]+[;'"]?/gi,
    ''
  );
  // Strip letter-spacing inline (safe — values are plain numbers/units)
  contentHtml = contentHtml.replace(
    /\s*letter-spacing\s*:\s*[^;'"]+[;'"]?/gi,
    ''
  );
  // Strip inline background-color / background / color (overrides both light/dark theme)
  contentHtml = contentHtml.replace(
    /\s*(?:background(?:-color)?|color)\s*:\s*[^;'"]+[;'"]?/gi,
    ''
  );
  // Strip fixed widths from table/td/th elements (WeChat uses px widths)
  contentHtml = contentHtml.replace(
    /(<(?:table|td|th)\b[^>]*?\s)width\s*:\s*\d+px[;'"]?\s*/gi,
    '$1'
  );
  // Strip data-colwidth attributes from tds
  contentHtml = contentHtml.replace(
    /\s+data-colwidth="[^"]*"/gi,
    ''
  );
  // Convert WeChat heading tags to <p> (authors often misuse h1-h4 for body text styling)
  contentHtml = contentHtml.replace(/<\/?h[1-4][^>]*>/gi, (tag: string) => {
    if (tag.startsWith('</')) return '</p>';
    return '<p>';
  });
  // Clean up double semicolons from stripped properties
  contentHtml = contentHtml.replace(/;;/g, ';');
  // Clean up empty style attributes
  contentHtml = contentHtml.replace(/\s+style\s*=\s*""/gi, '');
  contentHtml = contentHtml.replace(/\s+style\s*=\s*''/gi, '');

  // Extract images from data-src, replace with [IMG:N] markers
  const photos: TweetPhoto[] = [];
  let text = contentHtml;
  text = text.replace(/<img[^>]*data-src="([^"]+)"[^>]*>/g, (_match, dataSrc) => {
    photos.push({ url: dataSrc, width: 0, height: 0 });
    return `[IMG:${photos.length - 1}]`;
  });
  // Also handle lazy-loaded src (fallback)
  text = text.replace(/<img[^>]*src="([^"]+)"[^>]*>/g, (_match, src) => {
    if (src.startsWith('data:') || src.startsWith('//')) return _match;
    const existing = photos.findIndex(p => p.url === src);
    if (existing >= 0) return `[IMG:${existing}]`;
    photos.push({ url: src, width: 0, height: 0 });
    return `[IMG:${photos.length - 1}]`;
  });

  const id = extractWechatId(url);

  const authorFinal = author || '微信公众号';

  // Guard: when the WeChat template puts the full article body into msg_title
  // AND js_content / rich_media_content are empty, title is unreasonably long
  // while text is empty. Auto-correct: use title as text, derive short title.
  const MAX_TITLE_LEN = 200;
  let finalTitle = title || '微信公众号文章';
  let finalText = text;
  if (finalTitle.length > MAX_TITLE_LEN && (!finalText || finalText.trim().length < 50)) {
    console.warn(
      `[wechat] Title is ${finalTitle.length} chars but content is ${finalText ? finalText.length : 0} chars — swapping title↔text`
    );
    // Convert plain-text title into basic HTML paragraphs so the renderer
    // (which passes wechat text through as raw HTML) shows readable output.
    const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const paragraphs = finalTitle
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => `<p>${htmlEscape(l)}</p>`)
      .join('\n');
    finalText = paragraphs;
    finalTitle = deriveTitle(finalTitle, 80) || finalTitle.substring(0, 80);
  } else if (finalTitle.length > MAX_TITLE_LEN) {
    console.warn(`[wechat] Title is ${finalTitle.length} chars — truncating to ${MAX_TITLE_LEN}`);
    finalTitle = finalTitle.substring(0, MAX_TITLE_LEN);
  }

  return {
    id,
    url,
    text: finalText,
    title: finalTitle,
    author: {
      name: authorFinal,
      screen_name: authorFinal === '微信公众号' ? 'wechat' : authorFinal,
      avatar_url: avatarUrl,
    },
    created_at: new Date(createdTimestamp * 1000).toUTCString(),
    created_timestamp: createdTimestamp,
    likes: finalLikeNum,
    retweets: shareNum,
    replies: commentNum,
    views: finalReadNum,
    media: photos.length > 0 ? { photos } : undefined,
    sourceType: 'wechat',
  };
}

function isFeishuUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'feishu.cn' ||
      host.endsWith('.feishu.cn') ||
      host === 'larksuite.com' ||
      host.endsWith('.larksuite.com') ||
      host === 'feishu.com' ||
      host.endsWith('.feishu.com')
    );
  } catch {
    return false;
  }
}

/** Extract a real WeChat article URL from free text / markdown. */
function extractWechatUrlFromText(text: string): string | null {
  // 1) Prefer markdown link *targets* — Feishu/Jina often show truncated
  //    preview text like `https://mp.weixin.qq.com/s/40htifjn...` while the
  //    real href still has the full id.
  const mdTarget = text.match(/\]\((https?:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{10,})\)/);
  if (mdTarget) return mdTarget[1];

  const mdQuery = text.match(/\]\((https?:\/\/mp\.weixin\.qq\.com\/s\?[^)\s]+)\)/);
  if (mdQuery) return mdQuery[1].replace(/[.,;:!?。，；：！？]+$/, '');

  // 2) Bare URLs — pick the longest match so truncated previews lose to full ids.
  //    Real short-link ids are typically ~22 chars; require >=10 to skip stubs.
  const bare = text.match(/https?:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{10,}/g);
  if (bare && bare.length) {
    return bare.sort((a, b) => b.length - a.length)[0];
  }

  const withQuery = text.match(/https?:\/\/mp\.weixin\.qq\.com\/s\?[^\s)\]>"']+/);
  if (withQuery) {
    return withQuery[0].replace(/[.,;:!?。，；：！？]+$/, '');
  }
  return null;
}

/** Local wrapper: shared pushPhoto returns markers into TweetPhoto[]. */
function pushPhoto(photos: TweetPhoto[], imgUrl: string): string {
  return pushPhotoShared(photos as PhotoSink[], imgUrl);
}

async function fetchJina(url: string, format: 'markdown' | 'html'): Promise<string> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TweetArchive/1.1',
    'X-Return-Format': format,
    // Keep images. Do NOT send X-With-Generated-Alt (needs Jina API key).
    'X-Retain-Images': 'all',
    'X-Timeout': '45',
  };
  if (format === 'html') {
    // Prefer full HTML so we can recover img data-src Feishu SSR embeds
    headers['Accept'] = 'text/html,application/xhtml+xml';
  }
  const response = await axios.get<string>(jinaUrl, {
    headers,
    timeout: 60000,
    httpsAgent: getAgent(),
    // Jina may return large bodies
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024,
  });
  return typeof response.data === 'string' ? response.data : String(response.data ?? '');
}

/** Best-effort direct HTML fetch (public docs only; login walls yield thin shell). */
async function fetchDirectHtml(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    timeout: 25000,
    httpsAgent: getAgent(),
    maxRedirects: 5,
    maxContentLength: 15 * 1024 * 1024,
  });
  return typeof response.data === 'string' ? response.data : '';
}

function parseJinaMarkdownPayload(rawText: string, feishu: boolean): {
  title: string;
  text: string;
  photos: TweetPhoto[];
  publishTime: string;
} {
  let title = '';
  const titleMatch = rawText.match(/^Title:\s*(.+)$/m);
  if (titleMatch && titleMatch[1].trim()) title = titleMatch[1].trim();
  if (!title) {
    const h1Match = rawText.match(/^#\s+(.+)$/m);
    if (h1Match) title = h1Match[1].trim();
  }
  title = title
    .replace(/\s*[-|–—]\s*(Feishu Docs|飞书文档|飞书|Lark Docs)\s*$/i, '')
    .trim();

  const timeMatch = rawText.match(/^Published Time:\s*(.+)$/m);
  const publishTime = timeMatch ? timeMatch[1].trim() : '';

  let text = rawText;
  text = text.replace(/^Title:\s*.+$/m, '');
  text = text.replace(/^URL Source:\s*.+$/m, '');
  text = text.replace(/^Published Time:\s*.+$/m, '');
  text = text.replace(/^Markdown Content:\s*$/im, '');
  text = text.replace(/^Warning:\s*.+$/gm, '');
  text = cleanWebpageMarkdown(text, { isFeishu: feishu });

  const extracted = extractMarkdownImages(text);
  text = extracted.text.replace(/\n{3,}/g, '\n\n').trim();
  return {
    title,
    text,
    photos: extracted.photos as TweetPhoto[],
    publishTime,
  };
}

function extractTitleFromHtml(rawHtml: string): string {
  let title = '';
  const og =
    rawHtml.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    rawHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og) title = og[1].trim();
  if (!title) {
    const t = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = t[1].replace(/\s+/g, ' ').trim();
  }
  return title
    .replace(/\s*[-|–—]\s*(Feishu Docs|飞书文档|飞书|Lark Docs)\s*$/i, '')
    .trim();
}

/** Prefer main content regions; fall back to body. */
function extractBodyHtml(rawHtml: string): string {
  const regionRes = [
    /<div[^>]*(?:class|id)=["'][^"']*(?:wiki-content|doc-content|docx-content|article-content|suite-content|page-block|render-unit-wrapper)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
  ];
  for (const re of regionRes) {
    const parts: string[] = [];
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(rawHtml)) !== null) {
      if (m[1] && m[1].length > 80) parts.push(m[1]);
    }
    if (parts.length) return parts.join('\n');
  }
  const body = rawHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : rawHtml;
}

/** HTML → MD via turndown (primary local converter). */
function parseHtmlPayload(rawHtml: string, feishu: boolean): {
  title: string;
  text: string;
  photos: TweetPhoto[];
} {
  const title = extractTitleFromHtml(rawHtml);
  const photos: TweetPhoto[] = [];
  const bodyHtml = extractBodyHtml(rawHtml);

  let text = htmlToMarkdown(bodyHtml, photos as PhotoSink[]);
  // Harvest remaining img urls from full HTML that region missed
  const imgRe = /(?:data-origin-src|data-src|src)=["'](https?:\/\/[^"']+)["']/gi;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(rawHtml)) !== null) {
    pushPhoto(photos, im[1]);
  }
  text = cleanWebpageMarkdown(text, { isFeishu: feishu });
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { title, text, photos };
}

/**
 * HTML → MD via Microsoft MarkItDown (optional A/B side-path).
 * Falls back empty if Python/markitdown missing.
 */
async function parseHtmlWithMarkitdown(
  rawHtml: string,
  feishu: boolean,
  sourceLabel: string
): Promise<{
  title: string;
  text: string;
  photos: TweetPhoto[];
  source: string;
} | null> {
  const bodyHtml = extractBodyHtml(rawHtml);
  const title = extractTitleFromHtml(rawHtml);
  const result = await convertHtmlWithMarkitdown(bodyHtml || rawHtml);
  if (!result.ok) {
    console.warn(`[webpage] markitdown (${sourceLabel}) skipped: ${result.error}`);
    return null;
  }
  let text = cleanWebpageMarkdown(result.markdown, { isFeishu: feishu });
  const extracted = extractMarkdownImages(text);
  text = extracted.text.replace(/\n{3,}/g, '\n\n').trim();
  console.log(
    `[webpage] markitdown (${sourceLabel}) ok ${result.ms}ms → ${text.length}c/${extracted.photos.length}img`
  );
  return {
    title,
    text,
    photos: extracted.photos as TweetPhoto[],
    source: `markitdown-${sourceLabel}`,
  };
}

function mergePhotos(a: TweetPhoto[], b: TweetPhoto[]): TweetPhoto[] {
  const out: TweetPhoto[] = [...a];
  for (const p of b) {
    if (!out.some(x => x.url === p.url)) out.push(p);
  }
  return out;
}

/**
 * Rewrite body so every photo appears as [IMG:N] in order of `photos`.
 * Photos already referenced keep their place; extras appended at end.
 */
function ensurePhotoMarkers(text: string, photos: TweetPhoto[]): string {
  if (!photos.length) return text;
  const referenced = new Set<number>();
  text.replace(/\[IMG:(\d+)\]/g, (_m, idx) => {
    referenced.add(parseInt(idx, 10));
    return _m;
  });
  const missing: string[] = [];
  for (let i = 0; i < photos.length; i++) {
    if (!referenced.has(i)) missing.push(`[IMG:${i}]`);
  }
  if (!missing.length) return text;
  return `${text}\n\n${missing.join('\n')}\n`.trim();
}

/** Fetch any web page via Jina AI (+ direct HTML fallback for Feishu) → Markdown. */
export async function fetchWebPage(url: string): Promise<FetchedTweet> {
  const feishu = isFeishuUrl(url);
  console.log(`[webpage] Fetching ${feishu ? 'Feishu' : 'web'} page: ${url}`);

  // 1) Jina markdown (primary)
  let rawMd = '';
  try {
    rawMd = await fetchJina(url, 'markdown');
  } catch (err) {
    console.warn(
      `[webpage] Jina markdown failed: ${err instanceof Error ? err.message : err}`
    );
  }

  // 2) Prefer original WeChat article when Feishu (or other mirrors) only host a copy
  const wechatOriginal = rawMd ? extractWechatUrlFromText(rawMd) : null;
  if (wechatOriginal) {
    try {
      console.log(`[webpage] Found WeChat original, refetching: ${wechatOriginal}`);
      let titleHint = '';
      const tm = rawMd.match(/^Title:\s*(.+)$/m);
      if (tm) titleHint = tm[1].trim();
      const wechat = await fetchWechatArticle(wechatOriginal);
      return {
        ...wechat,
        id: generateWebPageId(url),
        url,
        title: titleHint || wechat.title,
        sourceType: 'wechat',
      };
    } catch (err) {
      console.warn(
        `[webpage] WeChat original fetch failed, falling back: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  // 3) Parallel enrich: Jina HTML + direct HTML (Feishu especially needs both)
  const [jinaHtmlResult, directHtmlResult] = await Promise.allSettled([
    fetchJina(url, 'html'),
    feishu ? fetchDirectHtml(url) : Promise.resolve(''),
  ]);
  const jinaHtml =
    jinaHtmlResult.status === 'fulfilled' ? jinaHtmlResult.value : '';
  const directHtml =
    directHtmlResult.status === 'fulfilled' ? directHtmlResult.value : '';
  if (jinaHtmlResult.status === 'rejected') {
    console.warn(
      `[webpage] Jina html failed: ${
        jinaHtmlResult.reason instanceof Error
          ? jinaHtmlResult.reason.message
          : jinaHtmlResult.reason
      }`
    );
  }
  if (directHtmlResult.status === 'rejected') {
    console.warn(
      `[webpage] Direct html failed: ${
        directHtmlResult.reason instanceof Error
          ? directHtmlResult.reason.message
          : directHtmlResult.reason
      }`
    );
  }

  type Cand = {
    title: string;
    text: string;
    photos: TweetPhoto[];
    publishTime: string;
    source: string;
    score?: number;
  };
  const candidates: Cand[] = [];

  if (rawMd) {
    const md = parseJinaMarkdownPayload(rawMd, feishu);
    candidates.push({ ...md, source: 'jina-md' });
  }

  // A) turndown HTML paths
  let strippedJinaHtml = '';
  if (jinaHtml && jinaHtml.length > 200) {
    strippedJinaHtml = jinaHtml
      .replace(/^Title:\s*.+$/m, '')
      .replace(/^URL Source:\s*.+$/m, '')
      .replace(/^Published Time:\s*.+$/m, '');
    const htmlParsed = parseHtmlPayload(strippedJinaHtml, feishu);
    candidates.push({
      ...htmlParsed,
      publishTime: '',
      source: 'turndown-jina-html',
    });
  }
  if (directHtml && directHtml.length > 500) {
    const htmlParsed = parseHtmlPayload(directHtml, feishu);
    candidates.push({
      ...htmlParsed,
      publishTime: '',
      source: 'turndown-direct-html',
    });
  }

  // B) markitdown side-path on same HTML (optional; skipped if not installed)
  const markitdownJobs: Promise<Cand | null>[] = [];
  if (strippedJinaHtml.length > 200) {
    markitdownJobs.push(
      parseHtmlWithMarkitdown(strippedJinaHtml, feishu, 'jina-html').then(r =>
        r ? { ...r, publishTime: '' } : null
      )
    );
  }
  if (directHtml && directHtml.length > 500) {
    markitdownJobs.push(
      parseHtmlWithMarkitdown(directHtml, feishu, 'direct-html').then(r =>
        r ? { ...r, publishTime: '' } : null
      )
    );
  }
  if (markitdownJobs.length) {
    const mdResults = await Promise.all(markitdownJobs);
    for (const r of mdResults) {
      if (r) candidates.push(r);
    }
  }

  if (!candidates.length) {
    throw new Error('Failed to fetch webpage content from all sources');
  }

  // Score all candidates (structure + length − Feishu chrome noise)
  for (const c of candidates) {
    c.score = contentScore(c.text, c.photos.length);
  }
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = candidates[0];
  let photos = best.photos;
  for (const c of candidates.slice(1)) {
    photos = mergePhotos(photos, c.photos);
  }
  let text = ensurePhotoMarkers(best.text, photos);
  let title = best.title;
  for (const c of candidates) {
    if (!title && c.title) title = c.title;
  }
  const publishTime = candidates.find(c => c.publishTime)?.publishTime || '';

  // A/B log: every converter score so we can compare turndown vs markitdown
  console.log(
    `[webpage] sources=${candidates
      .map(
        c =>
          `${c.source}:${c.text.length}c/${c.photos.length}img/s${c.score ?? 0}`
      )
      .join(', ')} chosen=${best.source} final=${text.length}c/${photos.length}img`
  );

  // Extract domain
  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch { /* use empty */ }

  if (!title) title = domain || '网页';

  let authorName = domain || 'Unknown';
  let authorHandle = domain || 'unknown';
  if (feishu) {
    const space = domain.replace(/\.feishu\.cn$/i, '').replace(/\.larksuite\.com$/i, '');
    if (space && space !== domain) {
      authorName = space;
      authorHandle = space;
    }
  }

  const byline = text.match(/(?:^|\n)原创\s+([^\n]{2,40})/);
  if (byline) {
    const name = byline[1].split(/\s{2,}|\d{4}年/)[0].trim().split(/\s+/)[0];
    if (name && name.length >= 2 && name.length <= 20) {
      authorName = name;
    }
  }

  const id = generateWebPageId(url);

  return {
    id,
    url,
    title: normalizeScrapedText(title),
    text,
    author: {
      name: normalizeAuthorField(authorName) || domain || 'Unknown',
      screen_name: normalizeAuthorField(authorHandle) || domain || 'unknown',
      avatar_url: '',
    },
    created_at: publishTime || new Date().toUTCString(),
    created_timestamp: publishTime
      ? Math.floor(new Date(publishTime).getTime() / 1000)
      : Math.floor(Date.now() / 1000),
    likes: 0,
    retweets: 0,
    replies: 0,
    media: photos.length > 0 ? { photos } : undefined,
    sourceType: 'webpage',
  };
}
