/**
 * Normalize scraped text fields (title, author, handle, body snippets).
 *
 * WeChat / Jina / oEmbed often leave HTML entities or JS \uXXXX escapes in place.
 * If we later escapeHtml() without fully decoding first, "&amp;" becomes "&amp;amp;"
 * (and can stack to &amp;amp;amp; on re-saves). Always reduce to plain Unicode text
 * before store or re-escape.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeNumericEntity(body: string): string {
  if (/^x/i.test(body)) {
    const n = parseInt(body.slice(1), 16);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
    try {
      return String.fromCodePoint(n);
    } catch {
      return '';
    }
  }
  const n = parseInt(body, 10);
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** One pass of HTML entity decoding (named + numeric). &amp; handled last via named map. */
function decodeHtmlEntitiesOnce(text: string): string {
  // Numeric first: &#123; &#x1F4A9;
  let s = text.replace(/&#(x?[0-9a-fA-F]+);/g, (_m, body: string) => {
    const ch = decodeNumericEntity(body);
    return ch === '' ? _m : ch;
  });
  // Named: &nbsp; &amp; &quot; …
  s = s.replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, name: string) => {
    const key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED, key)) return NAMED[key];
    return m;
  });
  return s;
}

/** JS-style unicode escapes: \u4e2d \u{1F600} (and doubled \\u from JSON-ish sources). */
function decodeUnicodeEscapes(text: string): string {
  let s = text;
  // JavaScript string escapes from source extraction (e.g. WeChat `msg_title`
  // containing literal \n). The \\\\ → placeholder dance ensures that a
  // backslash that was originally escaped in JS source (\\\\ → one \) is not
  // later consumed as part of a \\n.
  const BSLASH = ''; // private-use codepoint as temporary placeholder
  s = s.replace(/\\\\/g, BSLASH);
  s = s.replace(/\\n/g, '\n');
  s = s.replace(new RegExp(BSLASH, 'g'), '\\');
  // \u{XXXXX}
  s = s.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, hex: string) => {
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch {
      return _m;
    }
  });
  // \uXXXX (repeat for sequences)
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Rare: \xNN
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return s;
}

/**
 * Fully normalize a scraped string to plain display text.
 * - Unicode escapes
 * - HTML entities (iterates to undo double/triple encoding like &amp;amp;)
 * - Collapses NBSP-like spaces
 * - Trims
 */
export function normalizeScrapedText(input: string | null | undefined): string {
  if (input == null) return '';
  let s = String(input);
  if (!s) return '';

  // WeChat sometimes appends .html(false) after title string
  s = s.replace(/\.html\(false\)$/i, '');

  // Iterative decode: entities can be stacked (&amp;amp;amp;)
  let prev = '';
  for (let i = 0; i < 8 && s !== prev; i++) {
    prev = s;
    s = decodeUnicodeEscapes(s);
    s = decodeHtmlEntitiesOnce(s);
  }

  // Normalize exotic spaces to regular space
  s = s.replace(/[\u00a0\u202f\u2007\u2060]/g, ' ');
  // Zero-width junk
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  // Collapse runs of spaces (but keep newlines if any)
  s = s.replace(/[^\S\n]+/g, ' ');
  return s.trim();
}

/** Alias kept for call sites that only need entity decode. */
export function decodeHtmlEntities(text: string): string {
  return normalizeScrapedText(text);
}

/** Normalize author-like short fields (name / screen_name). */
export function normalizeAuthorField(input: string | null | undefined): string {
  return normalizeScrapedText(input);
}
