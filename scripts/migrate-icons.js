const fs = require('fs');
const path = require('path');

const ICONS = {
  comment: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  repost: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>',
  like: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>',
};

const ARTICLES_DIR = path.resolve(__dirname, '..', 'data', 'articles');

const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
let updated = 0;

for (const file of files) {
  const filePath = path.join(ARTICLES_DIR, file);
  const original = fs.readFileSync(filePath, 'utf-8');
  let html = original;

  html = html.replace(
    /<span>💬 ([\d,]+)<\/span>/g,
    '<span class="stat">' + ICONS.comment + '<span>$1</span></span>'
  );
  html = html.replace(
    /<span>🔄 ([\d,]+)<\/span>/g,
    '<span class="stat">' + ICONS.repost + '<span>$1</span></span>'
  );
  html = html.replace(
    /<span>❤️ ([\d,]+)<\/span>/g,
    '<span class="stat">' + ICONS.like + '<span>$1</span></span>'
  );

  if (html !== original) {
    fs.writeFileSync(filePath, html, 'utf-8');
    updated++;
  }
}

console.log('Updated ' + updated + ' articles');
