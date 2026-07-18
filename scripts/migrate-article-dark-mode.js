#!/usr/bin/env node
// scripts/migrate-article-dark-mode.js
// 批量修复旧文章 HTML 的暗色模式可读性

const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.resolve(process.cwd(), 'data', 'articles');

function fixFile(filePath) {
  let html = fs.readFileSync(filePath, 'utf-8');
  let original = html;

  // 1. Fix hardcoded light-mode colors in content styles (must run before adding --code-color variable)
  html = html.replace(/color: #1a1a1a;/g, 'color: var(--text);');
  html = html.replace(/background: #f0f0f0;/g, 'background: var(--code-bg);');
  html = html.replace(/color: #d63384;/g, 'color: var(--code-color);');
  html = html.replace(/background: #f6f8fa;/g, 'background: var(--code-bg);');
  html = html.replace(/color: #57606a;/g, 'color: var(--text-secondary);');
  html = html.replace(/accent-color: #576b95;/g, 'accent-color: var(--accent);');
  html = html.replace(/color: #ddd;/g, 'color: var(--border);');

  // 2. Improve dark-mode variables and add code tokens
  html = html.replace(/--text-secondary: #999;\s*--text-tertiary: #666;/g,
    '--text-secondary: #b0b0b0;\n      --text-tertiary: #888;');
  html = html.replace(/--border: #2a2a2a;\s*--shadow-sm: rgba\(0,0,0,0\.3\);\s*--shadow-md: rgba\(0,0,0,0\.4\);/g,
    '--border: #3a3a3a; --shadow-sm: rgba(0,0,0,0.3); --shadow-md: rgba(0,0,0,0.4);\n      --code-bg: #2d2d2d; --code-color: #ff8fab;');
  html = html.replace(/--border: #eee;\s*--shadow-sm: rgba\(0,0,0,0\.05\);\s*--shadow-md: rgba\(0,0,0,0\.1\);/g,
    '--border: #eee; --shadow-sm: rgba(0,0,0,0.05); --shadow-md: rgba(0,0,0,0.1);\n      --code-bg: #f2f2f2; --code-color: #d63384;');

  // 3. Add highlight-dark stylesheet link if missing
  if (!html.includes('highlight-dark.css')) {
    html = html.replace(
      /<link rel="stylesheet" href="\/highlight\.css">/,
      '<link rel="stylesheet" href="/highlight.css" id="hl-theme-light">\n  <link rel="stylesheet" href="/highlight-dark.css" id="hl-theme-dark" disabled>'
    );
  }

  // 4. Ensure updateThemeIcon also toggles highlight theme
  if (html.includes('function updateThemeIcon()') && !html.includes('var hlLight')) {
    html = html.replace(
      /function updateThemeIcon\(\) \{\s*var isDark = document\.documentElement\.getAttribute\('data-theme'\) === 'dark';\s*var s = document\.getElementById\('theme-icon-sun'\);\s*var m = document\.getElementById\('theme-icon-moon'\);\s*if \(s\) s\.style\.display = isDark \? 'none' : '';\s*if \(m\) m\.style\.display = isDark \? '' : 'none';\s*\}/,
      `function updateThemeIcon() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var s = document.getElementById('theme-icon-sun');
  var m = document.getElementById('theme-icon-moon');
  if (s) s.style.display = isDark ? 'none' : '';
  if (m) m.style.display = isDark ? '' : 'none';
  var hlLight = document.getElementById('hl-theme-light');
  var hlDark = document.getElementById('hl-theme-dark');
  if (hlLight) hlLight.disabled = isDark;
  if (hlDark) hlDark.disabled = !isDark;
}`
    );
  }

  if (html !== original) {
    fs.writeFileSync(filePath, html, 'utf-8');
    return true;
  }
  return false;
}

function main() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.error('Articles directory not found:', ARTICLES_DIR);
    process.exit(1);
  }
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let changed = 0;
  for (const file of files) {
    const modified = fixFile(path.join(ARTICLES_DIR, file));
    if (modified) {
      changed++;
      console.log('Updated:', file);
    }
  }
  console.log(`Done — ${changed}/${files.length} files updated.`);
}

main();
