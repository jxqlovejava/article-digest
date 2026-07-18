const fs = require('fs');
const path = require('path');

const articlesDir = process.argv[2] || path.join(process.cwd(), 'data', 'articles');
if (!fs.existsSync(articlesDir)) {
  console.error('Articles dir not found:', articlesDir);
  process.exit(1);
}

const oldCtx = "var ctx = window.location.pathname.replace(/^\\/articles\\//, '').replace(/\\.html$/, '');";
const newCtx = "var ctx = window.location.pathname.replace(/^\\/articles\\//, '');";
const oldHref = "if (btn && ctx) btn.href = '/qa?context=' + encodeURIComponent(ctx);";
const newHref = "if (btn && ctx) btn.href = '/qa?context=' + encodeURIComponent(ctx) + '&new=1';";

const files = fs.readdirSync(articlesDir).filter(f => f.endsWith('.html'));
let updated = 0;
let scanned = 0;

for (const file of files) {
  const filePath = path.join(articlesDir, file);
  let html = fs.readFileSync(filePath, 'utf-8');
  scanned++;
  if (!html.includes(oldCtx)) continue;
  html = html.replace(oldCtx, newCtx).replace(oldHref, newHref);
  fs.writeFileSync(filePath, html, 'utf-8');
  updated++;
  console.log('Updated:', file);
}

console.log(`Scanned ${scanned}, updated ${updated}`);
