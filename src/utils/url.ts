const TWEET_URL_PATTERNS = [
  /twitter\.com\/([^/]+)\/status\/(\d+)/,
  /x\.com\/([^/]+)\/status\/(\d+)/,
  /mobile\.twitter\.com\/([^/]+)\/status\/(\d+)/,
];

export interface ParsedTweetUrl {
  username: string;
  tweetId: string;
  originalUrl: string;
}

export function parseTweetUrl(url: string): ParsedTweetUrl | null {
  const trimmed = url.trim();
  for (const pattern of TWEET_URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        username: match[1],
        tweetId: match[2],
        originalUrl: trimmed,
      };
    }
  }
  return null;
}

export function getFxTwitterApiUrl(username: string, tweetId: string): string {
  return `https://api.fxtwitter.com/${username}/status/${tweetId}`;
}

export function generateWebPageId(url: string): string {
  return Buffer.from(url).toString('base64url').substring(0, 24);
}
