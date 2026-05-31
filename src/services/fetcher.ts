import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getFxTwitterApiUrl } from '../utils/url';
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

export interface TweetAuthor {
  name: string;
  screen_name: string;
  avatar_url: string;
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

  // Handle nested images: [![desc](thumb)](full)
  // Use thumb (pbs.twimg.com direct URL) instead of full (x.com redirect)
  content = content.replace(
    /\[!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, _desc, thumbUrl, _fullUrl) => {
      if (isAvatarUrl(thumbUrl)) return '';
      photos.push({ url: upgradeImageUrl(thumbUrl), width: 0, height: 0 });
      return `[IMG:${photos.length - 1}]`;
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

  if (!title && content) {
    const firstLine = content.split('\n')[0].trim();
    if (firstLine.length > 0 && firstLine.length < 200) {
      title = firstLine;
    }
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

  if (!title) {
    title = text.split('\n')[0].substring(0, 80) || `${tweet.author.name} 的推文`;
  }

  // Merge article photos/videos with tweet media
  const mergedTweet = { ...tweet, text, title };
  // Always use unavatar.io for avatar (pbs.twimg.com blocked in CN)
  mergedTweet.author = { ...mergedTweet.author, avatar_url: `https://unavatar.io/x/${mergedTweet.author.screen_name}` };
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

  return mergedTweet;
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
  const title = text.split('\n')[0].substring(0, 80) || `${response.data.author_name || parsed.username} 的推文`;

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
