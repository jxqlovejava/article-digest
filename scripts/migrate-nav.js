const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.resolve(__dirname, '../data/articles');

const REPLACEMENTS = [
  // 1. Remove nested <div class="container"> before <article>
  {
    old: '  </div>\n  <div class="container">\n    <article class="article-card">',
    new: '  </div>\n    <article class="article-card">',
  },
  // 2. Remove closing </div> before <script>
  {
    old: '    </article>\n  </div>\n<script>',
    new: '    </article>\n<script>',
  },
  // 3. Back link text → SVG arrow
  {
    old: '<a href="/" class="back-link" style="margin-bottom:0">← 返回列表</a>',
    new: '<a href="/" class="back-link" style="margin-bottom:0" title="返回列表"><svg width="20" height="16" viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8H2"/><path d="M8 2l-6 6 6 6"/></svg></a>',
  },
  // 4. Top-bar: remove padding: 0 24px (desktop)
  {
    old: '.top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding: 0 24px; }',
    new: '.top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }',
  },
  // 5. Back-link: remove gap and font-size
  {
    old: '.back-link { display: inline-flex; color: var(--accent); align-items: center; gap: 6px; margin-bottom: 16px; color: #576b95; text-decoration: none; font-size: 14px; padding: 8px 0; }',
    new: '.back-link { display: inline-flex; color: var(--accent); align-items: center; margin-bottom: 16px; color: #576b95; text-decoration: none; padding: 8px 0; }',
  },
  // 6. Remove top-bar padding from mobile media query
  {
    old: '      .top-bar { padding: 0 16px; }\n',
    new: '',
  },
];

const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
let changed = 0;

for (const file of files) {
  const filePath = path.join(ARTICLES_DIR, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  let original = content;

  for (const { old, new: replacement } of REPLACEMENTS) {
    content = content.split(old).join(replacement);
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf-8');
    changed++;
    console.log(`✓ ${file}`);
  } else {
    console.log(`- ${file} (no changes)`);
  }
}

console.log(`\nDone: ${changed}/${files.length} files updated`);
