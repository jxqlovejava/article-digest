/**
 * FAB v4: AI sparkle color — gray/black → conventional AI indigo-violet.
 * Updates --ai-fab-fg (+ matching hover shadow tint) and star SVG gradient.
 * Usage: node scripts/migrate-ai-fab-v4.js [articlesDir]
 */
const fs = require('fs');
const path = require('path');

const articlesDir = process.argv[2] || path.join(__dirname, '..', 'data', 'articles');

const LIGHT_FG = '#6c63ff';
const DARK_FG = '#b4a7ff';

const NEW_BTN =
  `<a href="/qa" class="ask-ai-btn" title="问 AI" aria-label="问 AI" id="askAiBtn"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="aiSpark" x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#6366f1"/><stop offset="55%" stop-color="currentColor"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs><path d="M12 1.2l2.55 6.75 6.75 2.55-6.75 2.55L12 19.8l-2.55-6.75L2.7 10.5l6.75-2.55L12 1.2z" fill="url(#aiSpark)"/><path d="M19.2 15.1l1.25 3.15 3.15 1.25-3.15 1.25-1.25 3.15-1.25-3.15-3.15-1.25 3.15-1.25 1.25-3.15z" fill="url(#aiSpark)" opacity="0.88"/></svg></a>`;

const BTN_RE =
  /<a href="\/qa" class="ask-ai-btn"[^>]*>[\s\S]*?<\/a>/;

function migrate(html) {
  if (!html.includes('ask-ai-btn') && !html.includes('--ai-fab-fg')) {
    return { html, changed: false };
  }

  let out = html;
  const before = out;

  // Light theme fg (first :root block)
  out = out.replace(
    /(:root\s*\{[\s\S]*?)--ai-fab-fg:\s*[^;]+;/,
    `$1--ai-fab-fg: ${LIGHT_FG};`
  );

  // Dark theme fg
  out = out.replace(
    /(\[data-theme="dark"\]\s*\{[\s\S]*?)--ai-fab-fg:\s*[^;]+;/,
    `$1--ai-fab-fg: ${DARK_FG};`
  );

  // Hover shadows: gray → soft purple tint (best-effort, keep if no match)
  out = out.replace(
    /(:root\s*\{[\s\S]*?)--ai-fab-shadow-hover:\s*[^;]+;/,
    `$1--ai-fab-shadow-hover: 0 8px 22px rgba(108,99,255,0.18), 0 2px 6px rgba(15,23,42,0.08);`
  );
  out = out.replace(
    /(\[data-theme="dark"\]\s*\{[\s\S]*?)--ai-fab-shadow-hover:\s*[^;]+;/,
    `$1--ai-fab-shadow-hover: 0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(180,167,255,0.16);`
  );

  if (BTN_RE.test(out)) {
    out = out.replace(BTN_RE, NEW_BTN);
  }

  return { html: out, changed: out !== before };
}

function main() {
  if (!fs.existsSync(articlesDir)) {
    console.error('Articles dir not found:', articlesDir);
    process.exit(1);
  }

  const files = fs.readdirSync(articlesDir).filter((f) => f.endsWith('.html'));
  let changed = 0;
  for (const file of files) {
    const full = path.join(articlesDir, file);
    const raw = fs.readFileSync(full, 'utf8');
    const result = migrate(raw);
    if (result.changed) {
      fs.writeFileSync(full, result.html, 'utf8');
      changed += 1;
    }
  }
  console.log(`[migrate-ai-fab-v4] ${changed}/${files.length} articles updated`);
}

main();
