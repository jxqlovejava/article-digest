/**
 * HTML → Markdown via turndown (+ GFM tables/strikethrough).
 * Replaces the old regex-only path for webpage/Feishu archive quality.
 */
import TurndownService from 'turndown';
// turndown-plugin-gfm has no types; CJS export { gfm, tables, ... }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const turndownPluginGfm = require('turndown-plugin-gfm') as {
  gfm: (service: TurndownService) => void;
};

export interface PhotoSink {
  url: string;
  width: number;
  height: number;
}

/** UI chrome / non-content image URLs we never archive. */
export function isChromeImageUrl(imgUrl: string): boolean {
  return /feishu-static|marketplaceicon|dashboard_dm|shortcut_|appicon|favicon|logo[_-]?light|logo[_-]?dark|empty[_-]?state|placeholder|avatar[_-]?default|loading[_-]?icon|\/static\/svg\//i.test(
    imgUrl
  );
}

/** Drop unusable image targets (blob, data without value, chrome assets). */
export function isUsableImageUrl(imgUrl: string): boolean {
  const u = (imgUrl || '').trim();
  if (!u) return false;
  if (u.startsWith('data:')) return false;
  if (u.startsWith('blob:')) return false;
  if (u === 'about:blank') return false;
  if (isChromeImageUrl(u)) return false;
  return true;
}

export function pushPhoto(photos: PhotoSink[], imgUrl: string): string {
  let cleaned = imgUrl.trim().replace(/^<|>$/g, '');
  if (cleaned.startsWith('//')) cleaned = 'https:' + cleaned;
  if (!isUsableImageUrl(cleaned)) return '';
  const existing = photos.findIndex(p => p.url === cleaned);
  if (existing >= 0) return `[IMG:${existing}]`;
  photos.push({ url: cleaned, width: 0, height: 0 });
  return `[IMG:${photos.length - 1}]`;
}

/**
 * Feishu / ProseMirror often encodes bold via style, not <strong>.
 * Normalize a few high-signal patterns before turndown.
 */
export function preprocessHtmlForMarkdown(html: string): string {
  let h = html;
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  h = h.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');

  // style bold/italic → semantic tags (non-greedy inner text only, nested-safe-ish)
  h = h.replace(
    /<span\b[^>]*style=["'][^"']*font-weight\s*:\s*(?:bold|[6-9]00)[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
    (_m, inner: string) => `<strong>${inner}</strong>`
  );
  h = h.replace(
    /<span\b[^>]*style=["'][^"']*font-style\s*:\s*italic[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
    (_m, inner: string) => `<em>${inner}</em>`
  );

  // Empty Feishu leaf paragraphs that only hold <br>
  h = h.replace(/<p\b[^>]*>\s*(?:<span\b[^>]*>\s*)*(?:<br\s*\/?>\s*)+(?:<\/span>\s*)*<\/p>/gi, '\n');

  // Prefer data-origin-src / data-src on img: rewrite as src for turndown
  h = h.replace(/<img\b([^>]*)>/gi, (tag, attrs: string) => {
    const origin =
      attrs.match(/\bdata-origin-src=["']([^"']+)["']/i) ||
      attrs.match(/\bdata-src=["']([^"']+)["']/i) ||
      attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (!origin) return '';
    let u = origin[1];
    if (u.startsWith('//')) u = 'https:' + u;
    if (!isUsableImageUrl(u)) return '';
    // Strip other src-like attrs and set a clean src
    let a = attrs
      .replace(/\b(?:src|data-src|data-origin-src)=["'][^"']*["']/gi, '')
      .trim();
    return `<img src="${u}" ${a}>`;
  });

  return h;
}

function createTurndown(photos: PhotoSink[]): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    hr: '---',
  });
  td.use(turndownPluginGfm.gfm);

  // Images → [IMG:N] so archive pipeline can download & rewrite
  td.addRule('archiveImages', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as unknown as {
        getAttribute?: (n: string) => string | null;
      };
      const raw =
        (el.getAttribute &&
          (el.getAttribute('src') ||
            el.getAttribute('data-origin-src') ||
            el.getAttribute('data-src'))) ||
        '';
      const marker = pushPhoto(photos, raw);
      return marker ? `\n\n${marker}\n\n` : '';
    },
  });

  // Drop pure chrome / svg icons (cast: turndown accepts any tag name)
  td.remove([
    'script',
    'style',
    'noscript',
    'svg',
    'button',
    'nav',
    'footer',
    'header',
  ] as unknown as Array<keyof HTMLElementTagNameMap>);

  return td;
}

/**
 * Convert HTML fragment → markdown, collecting photos into `photos`.
 */
export function htmlToMarkdown(html: string, photos: PhotoSink[] = []): string {
  if (!html || !html.trim()) return '';
  const prepared = preprocessHtmlForMarkdown(html);
  const td = createTurndown(photos);
  let md = td.turndown(prepared);

  // Turndown may leave bare image markdown if rule missed; harvest
  md = md.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, _alt, url: string) => {
    return pushPhoto(photos, url) || '';
  });

  return md.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Feishu/Jina noise cleanup shared by all webpage sources.
 */
export function cleanWebpageMarkdown(
  text: string,
  opts: { isFeishu?: boolean } = {}
): string {
  let t = text;

  t = t.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  t = t.replace(/\u00a0/g, ' ');

  t = t.replace(/^Title:\s*.+$/gm, '');
  t = t.replace(/^URL Source:\s*.+$/gm, '');
  t = t.replace(/^Published Time:\s*.+$/gm, '');
  t = t.replace(/^Markdown Content:\s*$/gim, '');
  t = t.replace(/^Warning:\s*.+$/gm, '');

  // Drop blob image leftovers in markdown
  t = t.replace(/!?\[[^\]]*\]\(blob:[^)]+\)/gi, '');
  t = t.replace(/^blob:https?:\/\/\S+\s*$/gim, '');

  if (opts.isFeishu) {
    const feishuNoise = [
      /^#\s*Feishu Docs\s*$/gim,
      /^Error accessing wiki space\s*$/gim,
      /^Wiki space inaccessible\s*$/gim,
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
      /^Unable to print\s*$/gim,
      /^Failed to load\.?\s*(Please try again\.?)?\s*$/gim,
      /^Loading(\.\.\.|…)?\s*$/gim,
      /^请稍后重试\s*$/gim,
      /^加载失败\s*$/gim,
    ];
    for (const re of feishuNoise) t = t.replace(re, '');

    t = t.replace(
      /(?:^|\n)(?:\s*[-*]\s+\[[^\]]+\]\(https?:\/\/[^)]*(?:feishu\.cn|larksuite\.com)[^)]*\)\s*\n){2,}/g,
      '\n'
    );
  }

  t = t.replace(
    /^(?!#\s)([一二三四五六七八九十百千]+、[^\n]{2,40})\s*$/gm,
    '## $1'
  );

  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/** Score body quality for multi-source pick. */
export function contentScore(text: string, photoCount: number): number {
  const plain = text.replace(/\[IMG:\d+\]/g, '').replace(/\s+/g, ' ').trim();
  let score = plain.length + photoCount * 400;

  const headings = (text.match(/^#{1,3}\s+\S/gm) || []).length;
  score += headings * 80;
  const tables = (text.match(/^\| .+\|/gm) || []).length;
  score += Math.min(tables, 20) * 15;
  const lists = (text.match(/^[-*]\s+\S/gm) || []).length;
  score += Math.min(lists, 40) * 5;

  const noiseHits = [
    /Wiki space inaccessible/i,
    /Unable to print/i,
    /Failed to load/i,
    /Error accessing wiki/i,
    /Log In or Sign Up/i,
    /blob:/i,
    /Type\s*['/]\s*for commands/i,
  ];
  for (const re of noiseHits) {
    if (re.test(text)) score -= 600;
  }

  return score;
}

export function extractMarkdownImages(text: string): {
  text: string;
  photos: PhotoSink[];
} {
  const photos: PhotoSink[] = [];
  let next = text.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, _desc, imgUrl: string) => pushPhoto(photos, imgUrl) || ''
  );
  next = next.replace(
    /<img\b[^>]*?\b(?:src|data-src|data-origin-src)=["']([^"']+)["'][^>]*>/gi,
    (_m, imgUrl: string) => pushPhoto(photos, imgUrl) || ''
  );
  next = next.replace(
    /^(https?:\/\/[^\s]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s]*)?)\s*$/gim,
    (_m, imgUrl: string) => pushPhoto(photos, imgUrl) || ''
  );
  next = next.replace(
    /^(https?:\/\/(?:[a-z0-9-]+\.)*(?:feishucdn\.com|larksuitecdn\.com|bytedance\.net|feishu\.cn|larksuite\.com)\/[^\s]+)\s*$/gim,
    (_m, imgUrl: string) => {
      if (/\.(?:css|js|woff2?|ttf|map)(?:\?|$)/i.test(imgUrl)) return '';
      return pushPhoto(photos, imgUrl) || '';
    }
  );
  return { text: next, photos };
}
