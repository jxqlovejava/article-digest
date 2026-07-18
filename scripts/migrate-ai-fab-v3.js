/**
 * FAB v3: no double border, larger sparkles icon.
 * Usage: node scripts/migrate-ai-fab-v3.js [articlesDir]
 */
const fs = require('fs');
const path = require('path');

const articlesDir = process.argv[2] || path.join(__dirname, '..', 'data', 'articles');

const LIGHT_VARS = `      --ai-fab-bg: #ffffff;
      --ai-fab-fg: #3b5bdb;
      --ai-fab-shadow: 0 4px 14px rgba(15,23,42,0.12), 0 1px 3px rgba(15,23,42,0.08);
      --ai-fab-shadow-hover: 0 8px 22px rgba(59,91,219,0.22), 0 2px 6px rgba(15,23,42,0.1);`;

const DARK_VARS = `      --ai-fab-bg: #262a33;
      --ai-fab-fg: #c5d0f5;
      --ai-fab-shadow: 0 4px 16px rgba(0,0,0,0.45), 0 1px 3px rgba(0,0,0,0.3);
      --ai-fab-shadow-hover: 0 8px 24px rgba(0,0,0,0.55), 0 0 0 1px rgba(197,208,245,0.12);`;

const NEW_CSS = `    .ask-ai-btn {
      position: fixed; bottom: 28px; right: 24px; z-index: 9999;
      width: 56px; height: 56px; border-radius: 50%;
      border: none;
      background: var(--ai-fab-bg);
      color: var(--ai-fab-fg);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: var(--ai-fab-shadow);
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
    .ask-ai-btn svg { width: 28px; height: 28px; display: block; }
    @media (max-width: 480px) {
      .ask-ai-btn { bottom: 22px; right: 16px; width: 52px; height: 52px; }
      .ask-ai-btn svg { width: 26px; height: 26px; }
    }`;

const NEW_BTN = `<a href="/qa" class="ask-ai-btn" title="问 AI" aria-label="问 AI" id="askAiBtn"><svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 1.2l2.55 6.75 6.75 2.55-6.75 2.55L12 19.8l-2.55-6.75L2.7 10.5l6.75-2.55L12 1.2z"/><path d="M19.2 15.1l1.25 3.15 3.15 1.25-3.15 1.25-1.25 3.15-1.25-3.15-3.15-1.25 3.15-1.25 1.25-3.15z" opacity="0.9"/></svg></a>`;

function replaceVars(html) {
  let out = html;
  // Drop obsolete ring vars + rewrite fab vars blocks (light)
  out = out.replace(/\s*--ai-fab-ring:[^;]+;/g, '');
  // Replace known light var blocks
  out = out.replace(
    /--ai-fab-bg:\s*[^;]+;\s*--ai-fab-fg:\s*[^;]+;\s*(?:--ai-fab-ring:\s*[^;]+;\s*)?--ai-fab-shadow:\s*[^;]+;\s*--ai-fab-shadow-hover:\s*[^;]+;/g,
    (match, offset) => {
      // Heuristic: dark block contains dark-ish bg values nearby in last 200 chars of context — simpler: count occurrences
      return match; // handled below more carefully
    }
  );

  // Simpler: rewrite each var independently if present
  const pairs = [
    [/--ai-fab-bg:\s*[^;]+;/, null], // handled with full block
  ];

  // Full light/dark by occurrence order: first :root block, then dark
  if (out.includes('--ai-fab-bg:')) {
    // Replace first occurrence set inside :root — match first fab block after :root
    out = out.replace(
      /(:root\s*\{[\s\S]*?)--ai-fab-bg:\s*[^;]+;\s*--ai-fab-fg:\s*[^;]+;\s*(?:--ai-fab-ring:\s*[^;]+;\s*)?--ai-fab-shadow:\s*[^;]+;\s*--ai-fab-shadow-hover:\s*[^;]+;/,
      `$1${LIGHT_VARS}`
    );
    out = out.replace(
      /(\[data-theme="dark"\]\s*\{[\s\S]*?)--ai-fab-bg:\s*[^;]+;\s*--ai-fab-fg:\s*[^;]+;\s*(?:--ai-fab-ring:\s*[^;]+;\s*)?--ai-fab-shadow:\s*[^;]+;\s*--ai-fab-shadow-hover:\s*[^;]+;/,
      `$1${DARK_VARS}`
    );
  } else {
    out = out.replace(/(:root\s*\{)/, `$1\n${LIGHT_VARS}`);
    out = out.replace(/(\[data-theme="dark"\]\s*\{)/, `$1\n${DARK_VARS}`);
  }
  // cleanup leftover ring
  out = out.replace(/\s*--ai-fab-ring:[^;]+;/g, '');
  return out;
}

function migrate(html) {
  let out = html;
  if (!out.includes('ask-ai-btn')) return { html: out, changed: false };

  const before = out;
  out = replaceVars(out);

  // Replace entire ask-ai CSS block including optional ::after
  // Match from .ask-ai-btn { through mobile media that only styles ask-ai-btn
  const cssRe = /\.ask-ai-btn\s*\{[\s\S]*?@media \(max-width: 480px\)\s*\{\s*\.ask-ai-btn[\s\S]*?\}\s*\}/;
  if (cssRe.test(out)) {
    out = out.replace(cssRe, NEW_CSS);
  }

  // Remove orphaned ::after if CSS re didn't catch (edge cases)
  out = out.replace(/\.ask-ai-btn::after\s*\{[\s\S]*?\n\s*\}/g, '');

  // Button markup
  out = out.replace(/<a href="\/qa" class="ask-ai-btn"[\s\S]*?<\/a>/, NEW_BTN);

  return { html: out, changed: out !== before };
}

const files = fs.readdirSync(articlesDir).filter(f => f.endsWith('.html'));
let updated = 0;
for (const file of files) {
  const fp = path.join(articlesDir, file);
  const html = fs.readFileSync(fp, 'utf8');
  const { html: next, changed } = migrate(html);
  if (changed) {
    fs.writeFileSync(fp, next, 'utf8');
    updated++;
  }
}
console.log(`Done. Updated ${updated}/${files.length}`);
