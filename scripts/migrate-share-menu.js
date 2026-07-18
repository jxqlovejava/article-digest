#!/usr/bin/env node
/**
 * Migrate article pages: share button → menu (复制链接 / 分享长图)
 *
 * Usage: node scripts/migrate-share-menu.js
 */
const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.resolve(__dirname, '../data/articles');

const MENU_CSS = `
    .share-menu-wrap { position: relative; display: inline-flex; align-items: center; }
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
`;

const MENU_JS = `
var _shareToastTimer = 0;
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
`;

function buildShareButtonHtml(iconInner) {
  return (
    `<div class="share-menu-wrap">` +
    `<span class="share-btn" id="shareBtn" onclick="toggleShareMenu(event)" title="分享" role="button" aria-haspopup="menu" aria-expanded="false">${iconInner}</span>` +
    `<div class="share-menu" id="shareMenu" role="menu" aria-label="分享选项">` +
    `<button type="button" class="share-menu-item" role="menuitem" onclick="copyArticleLink()">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` +
    `复制链接</button>` +
    `<button type="button" class="share-menu-item" role="menuitem" onclick="shareAsLongImage()">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>` +
    `分享长图</button>` +
    `</div></div>`
  );
}

function migrateFile(filePath) {
  let html = fs.readFileSync(filePath, 'utf-8');
  if (html.includes('toggleShareMenu') && html.includes('copyArticleLink') && html.includes('shareMenu')) {
    return 'skip';
  }
  if (!html.includes('shareBtn') && !html.includes('openSharePreview')) {
    return 'skip';
  }

  let changed = false;

  // 1) CSS
  if (!html.includes('.share-menu-wrap')) {
    if (html.includes('.share-btn:hover { color: var(--text); }')) {
      html = html.replace(
        '.share-btn:hover { color: var(--text); }',
        '.share-btn:hover { color: var(--text); }' + MENU_CSS
      );
      changed = true;
    } else if (html.includes('</style>')) {
      html = html.replace('</style>', MENU_CSS + '\n  </style>');
      changed = true;
    }
  }

  // 2) Replace share button
  const btnRe =
    /<span class="share-btn" id="shareBtn" onclick="openSharePreview\(\)" title="分享长图">([\s\S]*?)<\/span>/;
  const m = html.match(btnRe);
  if (m) {
    html = html.replace(btnRe, buildShareButtonHtml(m[1]));
    changed = true;
  } else if (!html.includes('id="shareMenu"')) {
    // already different markup — try generic id=shareBtn span
    const btnRe2 =
      /<span class="share-btn" id="shareBtn"[^>]*>([\s\S]*?)<\/span>/;
    const m2 = html.match(btnRe2);
    if (m2 && !html.includes('share-menu-wrap')) {
      html = html.replace(btnRe2, buildShareButtonHtml(m2[1]));
      changed = true;
    }
  }

  // 3) Backdrop + toast near share overlay or before </body>
  if (!html.includes('id="shareMenuBackdrop"')) {
    const inject =
      '<div class="share-menu-backdrop" id="shareMenuBackdrop" onclick="closeShareMenu()" aria-hidden="true"></div>' +
      '<div class="share-toast" id="shareToast" role="status" aria-live="polite"></div>';
    if (html.includes('<div class="share-overlay"')) {
      html = html.replace('<div class="share-overlay"', inject + '\n<div class="share-overlay"');
      changed = true;
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', inject + '\n</body>');
      changed = true;
    }
  }

  // 4) JS helpers
  if (!html.includes('function toggleShareMenu')) {
    if (html.includes('function openSharePreview()')) {
      html = html.replace('function openSharePreview()', MENU_JS + '\nfunction openSharePreview()');
      changed = true;
    } else if (html.includes('</script>')) {
      // last script block
      const idx = html.lastIndexOf('</script>');
      html = html.slice(0, idx) + MENU_JS + '\n' + html.slice(idx);
      changed = true;
    }
  }

  // 5) openSharePreview should close menu first (best-effort)
  if (html.includes('function openSharePreview()') && !html.includes('closeShareMenu();\n  var overlay = document.getElementById(\'shareOverlay\')')) {
    html = html.replace(
      /function openSharePreview\(\)\s*\{\s*var overlay = document\.getElementById\('shareOverlay'\);/,
      "function openSharePreview() {\n  if (typeof closeShareMenu === 'function') closeShareMenu();\n  var overlay = document.getElementById('shareOverlay');"
    );
    changed = true;
  }

  if (!changed) return 'miss';
  fs.writeFileSync(filePath, html, 'utf-8');
  return 'ok';
}

function main() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.error('No articles dir:', ARTICLES_DIR);
    process.exit(1);
  }
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let ok = 0;
  let skip = 0;
  let miss = 0;
  for (const f of files) {
    const r = migrateFile(path.join(ARTICLES_DIR, f));
    if (r === 'ok') ok++;
    else if (r === 'skip') skip++;
    else {
      miss++;
      if (miss <= 8) console.warn('miss:', f);
    }
  }
  console.log(`migrate-share-menu: ok=${ok} skip=${skip} miss=${miss} total=${files.length}`);
}

main();
