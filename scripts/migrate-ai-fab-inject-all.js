/**
 * Inject redesigned Ask-AI FAB into ALL article pages (add if missing, upgrade if old).
 * Usage: node scripts/migrate-ai-fab-inject-all.js [articlesDir]
 */
const fs = require('fs');
const path = require('path');

const articlesDir = process.argv[2] || path.join(__dirname, '..', 'data', 'articles');

const LIGHT_VARS = `      --ai-fab-bg: rgba(255,255,255,0.92);
      --ai-fab-fg: #4f6ef7;
      --ai-fab-ring: rgba(79,110,247,0.22);
      --ai-fab-shadow: 0 2px 8px rgba(15,23,42,0.06), 0 10px 28px rgba(15,23,42,0.12);
      --ai-fab-shadow-hover: 0 4px 12px rgba(15,23,42,0.08), 0 16px 36px rgba(79,110,247,0.22);`;

const DARK_VARS = `      --ai-fab-bg: rgba(32,36,44,0.92);
      --ai-fab-fg: #a8b8f0;
      --ai-fab-ring: rgba(168,184,240,0.28);
      --ai-fab-shadow: 0 2px 10px rgba(0,0,0,0.35), 0 12px 32px rgba(0,0,0,0.45);
      --ai-fab-shadow-hover: 0 4px 14px rgba(0,0,0,0.4), 0 16px 40px rgba(120,140,220,0.25);`;

const NEW_CSS = `    .ask-ai-btn {
      position: fixed; bottom: 28px; right: 24px; z-index: 9999;
      width: 52px; height: 52px; border-radius: 50%;
      border: 1px solid var(--ai-fab-ring);
      background: var(--ai-fab-bg);
      color: var(--ai-fab-fg);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: var(--ai-fab-shadow);
      backdrop-filter: blur(14px) saturate(1.2);
      -webkit-backdrop-filter: blur(14px) saturate(1.2);
      transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1),
                  box-shadow 0.22s ease, background 0.2s ease, color 0.2s ease;
      -webkit-tap-highlight-color: transparent;
      text-decoration: none;
    }
    .ask-ai-btn::after {
      content: '';
      position: absolute; inset: -3px; border-radius: 50%;
      border: 1.5px solid transparent;
      background: linear-gradient(135deg, rgba(79,110,247,0.45), rgba(167,139,250,0.35), rgba(79,110,247,0.15)) border-box;
      -webkit-mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
      opacity: 0.85;
    }
    .ask-ai-btn:hover {
      transform: translateY(-2px) scale(1.04);
      box-shadow: var(--ai-fab-shadow-hover);
      color: var(--ai-fab-fg);
    }
    .ask-ai-btn:active { transform: translateY(0) scale(0.96); }
    .ask-ai-btn:focus-visible { outline: 2px solid var(--ai-fab-fg); outline-offset: 3px; }
    .ask-ai-btn svg { width: 22px; height: 22px; display: block; position: relative; z-index: 1; }
    @media (max-width: 480px) {
      .ask-ai-btn { bottom: 22px; right: 16px; width: 48px; height: 48px; }
      .ask-ai-btn svg { width: 20px; height: 20px; }
    }`;

const NEW_BTN = `<a href="/qa" class="ask-ai-btn" title="问 AI" aria-label="问 AI" id="askAiBtn"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 3.2l1.35 3.95 3.95 1.35-3.95 1.35L12 13.8l-1.35-3.95L6.7 8.5l3.95-1.35L12 3.2z" fill="currentColor" opacity="0.95"/><path d="M18.6 13.4l.85 2.35 2.35.85-2.35.85-.85 2.35-.85-2.35-2.35-.85 2.35-.85.85-2.35z" fill="currentColor" opacity="0.75"/><path d="M6.1 15.1l.55 1.55 1.55.55-1.55.55-.55 1.55-.55-1.55-1.55-.55 1.55-.55.55-1.55z" fill="currentColor" opacity="0.65"/></svg></a>`;

const SET_HREF_JS = `(function(){function setAiHref(){var ctx=decodeURIComponent(window.location.pathname).replace(/^\\/articles\\//,'');var btn=document.getElementById('askAiBtn');if(btn&&ctx)btn.href='/qa?context='+encodeURIComponent(ctx)+'&new=1';}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',setAiHref);}else{setAiHref();}})();`;

function migrate(html) {
  let out = html;
  let changed = false;

  if (!out.includes('--ai-fab-bg:')) {
    if (/:root\s*\{/.test(out)) {
      out = out.replace(/(:root\s*\{)/, `$1\n${LIGHT_VARS}`);
      changed = true;
    }
    if (/\[data-theme="dark"\]\s*\{/.test(out)) {
      out = out.replace(/(\[data-theme="dark"\]\s*\{)/, `$1\n${DARK_VARS}`);
      changed = true;
    }
  }

  if (/\.ask-ai-btn\s*\{/.test(out)) {
    const next = out.replace(
      /\.ask-ai-btn\s*\{[\s\S]*?@media \(max-width: 480px\)\s*\{\s*\.ask-ai-btn[\s\S]*?\}\s*\}/,
      NEW_CSS
    );
    if (next !== out) {
      out = next;
      changed = true;
    }
  } else if (out.includes('</style>')) {
    out = out.replace('</style>', `${NEW_CSS}\n  </style>`);
    changed = true;
  }

  if (/<a href="\/qa" class="ask-ai-btn"/.test(out)) {
    const next = out.replace(/<a href="\/qa" class="ask-ai-btn"[\s\S]*?<\/a>/, NEW_BTN);
    if (next !== out) {
      out = next;
      changed = true;
    }
  } else if (out.includes('</body>')) {
    // Prefer inserting before last closing page wrapper if present
    if (out.includes('</div>\n</div>\n</body>')) {
      out = out.replace('</div>\n</div>\n</body>', `${NEW_BTN}\n</div>\n</div>\n</body>`);
    } else {
      out = out.replace('</body>', `${NEW_BTN}\n</body>`);
    }
    changed = true;
  }

  if (out.includes('askAiBtn') && !out.includes("btn.href = '/qa?context='") && !out.includes('btn.href="/qa?context=')) {
    if (out.includes('</body>')) {
      out = out.replace('</body>', `<script>${SET_HREF_JS}</script>\n</body>`);
      changed = true;
    }
  }

  return { html: out, changed };
}

const files = fs.readdirSync(articlesDir).filter(f => f.endsWith('.html'));
let updated = 0;
for (const file of files) {
  const fp = path.join(articlesDir, file);
  const html = fs.readFileSync(fp, 'utf8');
  // Skip only if already fully migrated
  if (html.includes('ask-ai-btn') && html.includes('--ai-fab-bg:') && html.includes('opacity="0.95"')) {
    continue;
  }
  const { html: next, changed } = migrate(html);
  if (changed && next !== html) {
    fs.writeFileSync(fp, next, 'utf8');
    updated++;
  }
}
console.log(`Done. Updated ${updated}/${files.length}`);
