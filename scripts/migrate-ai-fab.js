const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'services', 'renderer.ts');
const ARTICLES_DIR = path.join(__dirname, '..', 'data', 'articles');

const renderer = fs.readFileSync(RENDERER, 'utf8');

const askMatch = renderer.match(/<a href="\/qa" class="ask-ai-btn"[\s\S]*?<\/a>/);
if (!askMatch) {
  console.error('Could not find new ask-ai-btn in renderer.ts');
  process.exit(1);
}
const newAsk = askMatch[0];

const btnMatch = renderer.match(/\.ask-ai-btn \{[\s\S]*?\n    \}/);
const hoverMatch = renderer.match(/\.ask-ai-btn:hover \{[\s\S]*?\n    \}/);
if (!btnMatch || !hoverMatch) {
  console.error('Could not find ask-ai-btn CSS in renderer.ts');
  process.exit(1);
}
const newBtnCss = btnMatch[0];
const newHoverCss = hoverMatch[0];

let count = 0;
for (const f of fs.readdirSync(ARTICLES_DIR)) {
  if (!f.endsWith('.html')) continue;
  const p = path.join(ARTICLES_DIR, f);
  let html = fs.readFileSync(p, 'utf8');
  if (!html.includes('ask-ai-btn')) continue;

  html = html.replace(/<a href="\/qa" class="ask-ai-btn"[\s\S]*?<\/a>/, newAsk);
  html = html.replace(/\.ask-ai-btn \{[\s\S]*?\n    \}/, newBtnCss);
  html = html.replace(/\.ask-ai-btn:hover \{[\s\S]*?\n    \}/, newHoverCss);

  if (!html.includes('--ai-fab:')) {
    html = html.replace(/(--accent-bg: #eef2ff;)(\s*--border: #eee;)/, '$1\n      --ai-fab: #8a9fe0;$2');
    html = html.replace(/(--accent-bg: #1c2738;)(\s*--border: #3a3a3a;)/, '$1\n      --ai-fab: #a8b8f0;$2');
  }

  fs.writeFileSync(p, html);
  count++;
}
console.log(`Migrated ${count} article(s).`);
