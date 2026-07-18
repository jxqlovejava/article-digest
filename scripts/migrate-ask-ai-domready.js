const fs = require('fs');
const path = require('path');

const articlesDir = process.argv[2] || path.join(process.cwd(), 'data', 'articles');
if (!fs.existsSync(articlesDir)) {
  console.error('Articles dir not found:', articlesDir);
  process.exit(1);
}

const marker = '// Set AI button href dynamically with context article on page load';
const newBlock = `${marker}
(function() {
  function setAiHref() {
    var ctx = decodeURIComponent(window.location.pathname).replace(/^\\/articles\\//, '');
    var btn = document.getElementById('askAiBtn');
    if (btn && ctx) btn.href = '/qa?context=' + encodeURIComponent(ctx) + '&new=1';
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setAiHref);
  } else {
    setAiHref();
  }
})();`;

const files = fs.readdirSync(articlesDir).filter(f => f.endsWith('.html'));
let updated = 0;
let scanned = 0;

for (const file of files) {
  const filePath = path.join(articlesDir, file);
  let html = fs.readFileSync(filePath, 'utf-8');
  scanned++;
  const idx = html.indexOf(marker);
  if (idx === -1) continue;
  const endIdx = html.indexOf('})();', idx);
  if (endIdx === -1) continue;
  const before = html.substring(0, idx);
  const after = html.substring(endIdx + '})();'.length);
  html = before + newBlock + after;
  fs.writeFileSync(filePath, html, 'utf-8');
  updated++;
  console.log('Updated:', file);
}

console.log(`Scanned ${scanned}, updated ${updated}`);
