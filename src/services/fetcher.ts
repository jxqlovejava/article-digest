import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getFxTwitterApiUrl, parseTweetUrl, generateWebPageId } from '../utils/url';
import type { ParsedTweetUrl } from '../utils/url';

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

/** Stub: full X Article content via browser is not available on this server
 *  (Chromium requires >4GB RAM). Use xarticle-mcp from Claude Code instead. */
async function fetchArticleViaBrowser(_articleId: string): Promise<ArticleContent | null> {
  return null;
}

/** Fetch full X Article content via X internal GraphQL API.
 *  Falls back gracefully if auth_token is not configured. */
async function fetchArticleViaGraphQL(tweetId: string): Promise<{ title: string; text: string; photos: TweetPhoto[]; videos: TweetVideo[]; authorName: string; authorScreenName: string; authorAvatar: string; likes: number; retweets: number; replies: number } | null> {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  try {
    // Step 1: get guest token (no auth needed, provides Bearer token)
    const guestRes = await axios.post('https://api.x.com/1.1/guest/activate.json',
      null, { headers: { 'User-Agent': 'TweetArchive/1.0' }, timeout: 10000, httpsAgent: getAgent() });
    const guestToken = guestRes.data?.guest_token;
    if (!guestToken) return null;

    // Step 2: call TweetDetail with article content flags
    const headers: Record<string, string> = {
      'User-Agent': 'TweetArchive/1.0',
      'authorization': `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    };
    if (authToken) {
      headers['cookie'] = `auth_token=${authToken}; ct0=${ct0};`;
      headers['x-csrf-token'] = ct0 || guestToken;
    }

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

    // Walk instructions to find the tweet entry
    let articleResult: any = null;
    let tweetLegacy: any = null;
    let tweetCore: any = null;
    let tweetStats: any = null;
    for (const inst of instructions) {
      const entries = inst.entries || inst.moduleItems || [];
      for (const entry of entries) {
        const tweet = entry.content?.itemContent?.tweet_results?.result || entry.entry?.content?.itemContent?.tweet_results?.result;
        const legacy = tweet?.legacy;
        if (!legacy) continue;
        tweetLegacy = legacy;
        tweetCore = tweet?.core;
        tweetStats = tweet?.views || legacy;
        const article = tweet?.article?.article_results?.result;
        if (article?.content_state?.blocks) {
          articleResult = article;
        }
      }
    }

    if (!articleResult) return null;

    // Parse using existing Draft.js parser
    const parsed = parseArticleContent({
      title: articleResult.title,
      content: { entityMap: articleResult.content_state?.entityMap || [] },
      cover_media: articleResult.cover_media,
      media_entities: articleResult.media_entities || [],
    });
    parsed.text = parseDraftJsBlocks(
      articleResult.content_state?.blocks || [],
      new Map((articleResult.content_state?.entityMap || []).map((e: any) => [e.key, e.value]))
    );

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

  // Quote tweet: commentary is short/empty but quote contains the real content.
  if (tweet.quote?.text && (!tweet.text || tweet.text.trim().length <= 30)) {
    const q = tweet.quote;
    const quoteBlock = `> ${q.author?.name || ''} @${q.author?.screen_name || ''}\n> ${q.text}`;
    return {
      ...tweet,
      text: tweet.text?.trim() ? `${tweet.text.trim()}\n\n${quoteBlock}` : quoteBlock,
      title: deriveTitle(q.text, 80) || tweet.title || '',
      media: tweet.media || q.media,
    };
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
      try {
        const resolved = await resolveUrl(tcoMatch[0]);
        // X Article: use headless browser to fetch full content
        if (/\/i\/article\//.test(resolved)) {
          const articleIdMatch = resolved.match(/\/(\d+)(?:\?|$)/);
          const articleId = articleIdMatch ? articleIdMatch[1] : '';
          if (articleId) {
            const browserResult = await fetchArticleViaBrowser(articleId);
            if (browserResult && browserResult.text.length > 30) {
              return {
                ...tweet,
                text: browserResult.text,
                title: browserResult.title || tweet.title || '',
                media: tweet.media || { photos: browserResult.photos },
              };
            }
          }
        }
        // Fallback: try FxTwitter with resolved URL
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
export async function fetchBookmarks(count = 30): Promise<string[]> {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  if (!authToken || !ct0) return [];

  try {
    const vars = JSON.stringify({ count, includePromotedContent: false });
    const res = await axios.get(
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
      }
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
    const res = await axios.get(
      `https://x.com/i/api/graphql/TGEKkJG_meudeaFcqaxM-Q/Likes`,
      {
        params: { variables: vars, features: JSON.stringify({}) },
        headers: {
          'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'x-twitter-active-user': 'yes', 'x-twitter-client-language': 'en',
          'x-csrf-token': ct0, 'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
        },
        timeout: 15000, httpsAgent: getAgent(),
      }
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

/** Derive a title from tweet text. Merges continuation lines (ending in ，、；：) up to maxLen. */
export function deriveTitle(text: string, maxLen = 80): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return '';

  let title = lines[0];
  const continuationMarks = /[，、；：]$/;
  let i = 1;
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
        result += `# ${block.text}\n\n`;
        continue;

      case 'header-two':
        result += `## ${block.text}\n\n`;
        continue;

      case 'header-three':
        result += `### ${block.text}\n\n`;
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
        result += `> ${block.text}\n\n`;
        continue;

      case 'ordered-list-item': {
        inOList = true;
        listCounter++;
        const indent = '   '.repeat(block.depth || 0);
        result += `${indent}${listCounter}. ${block.text}\n`;
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
        result += `${indent}- ${block.text}\n`;
        if (!nextBlock || nextBlock.type !== 'unordered-list-item') {
          inUList = false;
          result += '\n';
        }
        continue;
      }

      case 'unstyled':
      default: {
        let text = block.text;
        const ranges = block.inlineStyleRanges || [];
        for (let j = ranges.length - 1; j >= 0; j--) {
          const r = ranges[j];
          const styled = text.substring(r.offset, r.offset + r.length);
          let wrapped = styled;
          switch (r.style) {
            case 'Bold': wrapped = `**${styled}**`; break;
            case 'Italic': wrapped = `*${styled}*`; break;
            case 'Underline': wrapped = `<u>${styled}</u>`; break;
            case 'Strikethrough': wrapped = `~~${styled}~~`; break;
            case 'Code': wrapped = '`' + styled + '`'; break;
          }
          text = text.substring(0, r.offset) + wrapped + text.substring(r.offset + r.length);
        }
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

  // Handle Twitter Article (is_note_tweet) — content is in article field
  let text = tweet.text;
  let title = '';
  let articlePhotos: TweetPhoto[] = [];
  let articleVideos: TweetVideo[] = [];
  if ((!text || text.trim().length <= 30) && tweet.article) {
    const articleData = parseArticleContent(tweet.article);
    text = articleData.text || tweet.text;
    title = articleData.title;
    articlePhotos = articleData.photos;
    articleVideos = articleData.videos;
  }

  if (!title && tweet.title) {
    title = tweet.title;
  }
  if (!title) {
    title = deriveTitle(text, 80) || `${tweet.author.name} 的推文`;
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

export async function fetchTweet(parsed: ParsedTweetUrl): Promise<FetchedTweet> {
  const errors: string[] = [];
  let fxStats: Partial<FetchedTweet> | null = null;

  try {
    const tweet = await fetchFromFxTwitter(parsed);
    if (tweet.text && tweet.text.trim().length > 10) {
      return tweet;
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

  // Title: var msg_title = 'xxx'.html(false)
  let title = '';
  const titleMatch = html.match(/var msg_title\s*=\s*htmlDecode\(['"](.+?)['"]\)/);
  if (titleMatch) {
    title = titleMatch[1].replace(/\.html\(false\)$/, '');
  } else {
    const titleMatch2 = html.match(/var msg_title\s*=\s*['"](.+?)['"]/);
    if (titleMatch2) {
      title = titleMatch2[1].replace(/\.html\(false\)$/, '');
    }
  }
  if (!title) {
    const h1Match = html.match(/<h1[^>]*class="rich_media_title"[^>]*>([\s\S]*?)<\/h1>/);
    if (h1Match) {
      title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }
  }
  // Decode unicode escapes
  title = title.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Author
  let author = '';
  const authorMeta = html.match(/<meta[^>]*property="og:article:author"[^>]*content="(.*?)"/);
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

  // Author avatar: try round_head_img (from cgiDataNew) first, then head_img_url
  let avatarUrl = '';
  const roundImgMatch = html.match(/(?:round_head_img|hd_head_img|head_img_url)\s*[=:]\s*['"]([^'"]+)['"]/);
  if (roundImgMatch) {
    avatarUrl = roundImgMatch[1];
    if (avatarUrl.startsWith('//')) avatarUrl = 'https:' + avatarUrl;
    avatarUrl = avatarUrl.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
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

  return {
    id,
    url,
    text,
    title: title || '微信公众号文章',
    author: {
      name: author || '微信公众号',
      screen_name: author || 'wechat',
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

/**
 * Feishu/Jina markdown is noisy: shell chrome, TOC, login prompts, zero-width
 * spaces, and truncated deferred blocks. Clean before rendering.
 */
function cleanWebpageMarkdown(text: string, opts: { isFeishu?: boolean } = {}): string {
  let t = text;

  // Normalize zero-width / special spaces Feishu injects into every line
  t = t.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  t = t.replace(/\u00a0/g, ' ');

  // Drop Jina metadata headers if still present mid-body
  t = t.replace(/^Title:\s*.+$/gm, '');
  t = t.replace(/^URL Source:\s*.+$/gm, '');
  t = t.replace(/^Published Time:\s*.+$/gm, '');
  t = t.replace(/^Markdown Content:\s*$/gim, '');
  t = t.replace(/^Warning:\s*.+$/gm, '');

  if (opts.isFeishu) {
    const feishuNoise = [
      /^#\s*Feishu Docs\s*$/gim,
      /^Error accessing wiki space\s*$/gim,
      /^Public access\s*$/gim,
      /^Table of contents.*$/gim,
      /^header-v2\s*$/gim,
      /^Last updated:.*$/gim,
      /^Log In or Sign Up\s*$/gim,
      /^Help Center\s*$/gim,
      /^Keyboard Shortcuts\s*$/gim,
      /^Share\s*$/gim,
      /^Type\s*['']?\/['']?\s*for commands\s*$/gim,
      /^Modified\s+(Yesterday|Today|\d.+$)/gim,
      /^✅\s*Copied\s*$/gim,
      /^Copy link\s*$/gim,
      /^Open in( app| desktop)?\s*$/gim,
    ];
    for (const re of feishuNoise) t = t.replace(re, '');

    // Drop pure navigation TOC list that only links back into the same wiki page
    t = t.replace(
      /(?:^|\n)(?:\s*[-*]\s+\[[^\]]+\]\(https?:\/\/[^)]*(?:feishu\.cn|larksuite\.com)[^)]*\)\s*\n){2,}/g,
      '\n'
    );
  }

  // Promote Chinese section titles (一、xxx) to markdown headings when bare
  t = t.replace(
    /^(?!#\s)([一二三四五六七八九十百千]+、[^\n]{2,40})\s*$/gm,
    '## $1'
  );

  // Collapse empty / whitespace-only lines introduced by ZWSP cleanup
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/** True for Feishu/Lark UI chrome assets we never want to archive. */
function isChromeImageUrl(imgUrl: string): boolean {
  return /feishu-static|marketplaceicon|dashboard_dm|shortcut_|appicon|favicon|logo[_-]?light|logo[_-]?dark|empty[_-]?state|placeholder|avatar[_-]?default|loading[_-]?icon|\/static\/svg\//i.test(
    imgUrl
  );
}

function pushPhoto(photos: TweetPhoto[], imgUrl: string): string {
  const cleaned = imgUrl.trim().replace(/^<|>$/g, '');
  if (!cleaned || cleaned.startsWith('data:') || isChromeImageUrl(cleaned)) return '';
  const existing = photos.findIndex(p => p.url === cleaned);
  if (existing >= 0) return `[IMG:${existing}]`;
  photos.push({ url: cleaned, width: 0, height: 0 });
  return `[IMG:${photos.length - 1}]`;
}

function extractMarkdownImages(text: string): { text: string; photos: TweetPhoto[] } {
  const photos: TweetPhoto[] = [];
  // Markdown images: ![alt](url) and also <url> form
  let next = text.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, _desc, imgUrl: string) => pushPhoto(photos, imgUrl) || ''
  );
  // HTML <img> that sometimes leaks into jina markdown
  next = next.replace(
    /<img\b[^>]*?\b(?:src|data-src|data-origin-src)=["']([^"']+)["'][^>]*>/gi,
    (_m, imgUrl: string) => pushPhoto(photos, imgUrl) || ''
  );
  // Bare image URLs on their own line (incl. feishu CDN without extension)
  next = next.replace(
    /^(https?:\/\/[^\s]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s]*)?)\s*$/gim,
    (_m, imgUrl: string) => pushPhoto(photos, imgUrl) || ''
  );
  // Feishu/Lark image CDN lines without file extension
  next = next.replace(
    /^(https?:\/\/(?:[a-z0-9-]+\.)*(?:feishucdn\.com|larksuitecdn\.com|bytedance\.net|feishu\.cn|larksuite\.com)\/[^\s]+)\s*$/gim,
    (_m, imgUrl: string) => {
      if (/\.(?:css|js|woff2?|ttf|map)(?:\?|$)/i.test(imgUrl)) return '';
      return pushPhoto(photos, imgUrl) || '';
    }
  );
  return { text: next, photos };
}

/** Score a candidate body: longer text + more images wins. */
function contentScore(text: string, photoCount: number): number {
  const plain = text.replace(/\[IMG:\d+\]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length + photoCount * 400;
}

/** Convert HTML fragment → markdown-ish text, preserving images as [IMG:N]. */
function htmlFragmentToMarkdown(html: string, photos: TweetPhoto[]): string {
  let h = html;
  // Drop scripts/styles/nav chrome
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  h = h.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');

  // Images: data-src / data-origin-src / src
  h = h.replace(/<img\b[^>]*>/gi, (tag) => {
    const m =
      tag.match(/\bdata-origin-src=["']([^"']+)["']/i) ||
      tag.match(/\bdata-src=["']([^"']+)["']/i) ||
      tag.match(/\bsrc=["']([^"']+)["']/i);
    if (!m) return '';
    let u = m[1];
    if (u.startsWith('//')) u = 'https:' + u;
    return pushPhoto(photos, u) || '';
  });

  // Headings
  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
    const t = inner.replace(/<[^>]+>/g, '').trim();
    if (!t) return '\n';
    return `\n${'#'.repeat(Math.min(6, parseInt(level, 10)))} ${t}\n\n`;
  });
  // Lists
  h = h.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => {
    const t = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? `- ${t}\n` : '';
  });
  // Paragraphs / breaks
  h = h.replace(/<\/p>/gi, '\n\n');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/div>/gi, '\n');
  h = h.replace(/<\/tr>/gi, '\n');
  h = h.replace(/<\/(h[1-6]|li|ul|ol|table|section|article)>/gi, '\n');
  // Links keep text
  h = h.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_m, inner) => inner.replace(/<[^>]+>/g, ''));
  // Strip remaining tags
  h = h.replace(/<[^>]+>/g, '');
  // Decode common entities
  h = h
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  return h.replace(/\n{3,}/g, '\n\n').trim();
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
  return { title, text, photos: extracted.photos, publishTime };
}

function parseHtmlPayload(rawHtml: string, feishu: boolean): {
  title: string;
  text: string;
  photos: TweetPhoto[];
} {
  let title = '';
  const og = rawHtml.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || rawHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og) title = og[1].trim();
  if (!title) {
    const t = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = t[1].replace(/\s+/g, ' ').trim();
  }
  title = title
    .replace(/\s*[-|–—]\s*(Feishu Docs|飞书文档|飞书|Lark Docs)\s*$/i, '')
    .trim();

  const photos: TweetPhoto[] = [];
  // Prefer main content regions when present
  const regionRes = [
    /<div[^>]*(?:class|id)=["'][^"']*(?:wiki-content|doc-content|docx-content|article-content|suite-content|page-block|render-unit-wrapper)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
  ];
  let bodyHtml = '';
  for (const re of regionRes) {
    const parts: string[] = [];
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(rawHtml)) !== null) {
      if (m[1] && m[1].length > 80) parts.push(m[1]);
    }
    if (parts.length) {
      bodyHtml = parts.join('\n');
      break;
    }
  }
  if (!bodyHtml || bodyHtml.length < 200) {
    // Fallback: whole body
    const body = rawHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    bodyHtml = body ? body[1] : rawHtml;
  }

  let text = htmlFragmentToMarkdown(bodyHtml, photos);
  // Also harvest any remaining img urls from full HTML that region missed
  const imgRe = /(?:data-origin-src|data-src|src)=["'](https?:\/\/[^"']+)["']/gi;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(rawHtml)) !== null) {
    pushPhoto(photos, im[1]);
  }
  // Re-insert unreferenced photos at end so they still render
  // (htmlFragment already inserted markers for in-region images)
  text = cleanWebpageMarkdown(text, { isFeishu: feishu });
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { title, text, photos };
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

  type Cand = { title: string; text: string; photos: TweetPhoto[]; publishTime: string; source: string };
  const candidates: Cand[] = [];

  if (rawMd) {
    const md = parseJinaMarkdownPayload(rawMd, feishu);
    candidates.push({ ...md, source: 'jina-md' });
  }
  if (jinaHtml && jinaHtml.length > 200) {
    // Jina HTML wrapper may still include Title: header lines
    const stripped = jinaHtml
      .replace(/^Title:\s*.+$/m, '')
      .replace(/^URL Source:\s*.+$/m, '')
      .replace(/^Published Time:\s*.+$/m, '');
    const htmlParsed = parseHtmlPayload(stripped, feishu);
    candidates.push({ ...htmlParsed, publishTime: '', source: 'jina-html' });
  }
  if (directHtml && directHtml.length > 500) {
    const htmlParsed = parseHtmlPayload(directHtml, feishu);
    candidates.push({ ...htmlParsed, publishTime: '', source: 'direct-html' });
  }

  if (!candidates.length) {
    throw new Error('Failed to fetch webpage content from all sources');
  }

  // Pick richest body, but merge photos from all candidates
  candidates.sort(
    (a, b) => contentScore(b.text, b.photos.length) - contentScore(a.text, a.photos.length)
  );
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

  console.log(
    `[webpage] sources=${candidates.map(c => `${c.source}:${c.text.length}c/${c.photos.length}img`).join(', ')} ` +
      `chosen=${best.source} final=${text.length}c/${photos.length}img`
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
    title,
    text,
    author: {
      name: authorName,
      screen_name: authorHandle,
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
