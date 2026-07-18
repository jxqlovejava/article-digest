#!/usr/bin/env node
/**
 * Inject article-page prefetch for /api/qa/suggestions so recommended
 * questions are warm when user opens AI Q&A from the FAB.
 *
 * Usage: node scripts/migrate-qa-prefetch.js
 */
const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.resolve(__dirname, '../data/articles');

// Minified one-liner used by most archived articles
const OLD_MINIFIED =
  "<script>(function(){function setAiHref(){var ctx=decodeURIComponent(window.location.pathname).replace(/^\\/articles\\//,'');var btn=document.getElementById('askAiBtn');if(btn&&ctx)btn.href='/qa?context='+encodeURIComponent(ctx)+'&new=1';}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',setAiHref);}else{setAiHref();}})();</script>";

const NEW_MINIFIED =
  "<script>(function(){function setAiHref(){var ctx=decodeURIComponent(window.location.pathname).replace(/^\\/articles\\//,'');var btn=document.getElementById('askAiBtn');if(btn&&ctx)btn.href='/qa?context='+encodeURIComponent(ctx)+'&new=1';if(ctx&&!window.__qaSuggestPrefetched){window.__qaSuggestPrefetched=true;try{fetch('/api/qa/suggestions?context='+encodeURIComponent(ctx),{credentials:'same-origin',cache:'no-store'}).catch(function(){});}catch(e){}}}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',setAiHref);}else{setAiHref();}})();</script>";

const NEW_PRETTY = `// Set AI button href + prefetch recommended questions while user reads article
(function() {
  function setAiHref() {
    var ctx = decodeURIComponent(window.location.pathname).replace(/^\\/articles\\//, '');
    var btn = document.getElementById('askAiBtn');
    if (btn && ctx) btn.href = '/qa?context=' + encodeURIComponent(ctx) + '&new=1';
    // Warm suggestions cache so /qa?context=… opens with questions ready
    if (ctx && !window.__qaSuggestPrefetched) {
      window.__qaSuggestPrefetched = true;
      try {
        fetch('/api/qa/suggestions?context=' + encodeURIComponent(ctx), {
          credentials: 'same-origin',
          cache: 'no-store'
        }).catch(function() {});
      } catch (e) {}
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setAiHref);
  } else {
    setAiHref();
  }
})();`;

function migrateFile(filePath) {
  let html = fs.readFileSync(filePath, 'utf-8');
  if (html.includes('__qaSuggestPrefetched')) {
    return 'skip';
  }
  if (!html.includes('askAiBtn') && !html.includes('setAiHref')) {
    return 'skip';
  }

  // 1) Minified one-liner (most production articles)
  if (html.includes(OLD_MINIFIED)) {
    html = html.replace(OLD_MINIFIED, NEW_MINIFIED);
    fs.writeFileSync(filePath, html, 'utf-8');
    return 'ok-min';
  }

  // 2) Any compact setAiHref script without prefetch
  const minRe =
    /<script>\(function\(\)\{function setAiHref\(\)\{var ctx=decodeURIComponent\(window\.location\.pathname\)\.replace\(\^\\\/articles\\\/\/,''\);var btn=document\.getElementById\('askAiBtn'\);if\(btn&&ctx\)btn\.href='\/qa\?context='\+encodeURIComponent\(ctx\)\+'&new=1';\}if\(document\.readyState==='loading'\)\{document\.addEventListener\('DOMContentLoaded',setAiHref\);\}else\{setAiHref\(\);\}\}\)\(\);<\/script>/;
  if (minRe.test(html)) {
    html = html.replace(minRe, NEW_MINIFIED);
    fs.writeFileSync(filePath, html, 'utf-8');
    return 'ok-min-re';
  }

  // 3) Pretty multi-line block from renderer source
  const prettyRe =
    /\/\/ Set AI button href[^\n]*\n\(function\(\) \{\n  function setAiHref\(\) \{[\s\S]*?\n  \}\n  if \(document\.readyState === 'loading'\) \{\n    document\.addEventListener\('DOMContentLoaded', setAiHref\);\n  \} else \{\n    setAiHref\(\);\n  \}\n\}\)\(\);/;
  if (prettyRe.test(html)) {
    html = html.replace(prettyRe, NEW_PRETTY);
    fs.writeFileSync(filePath, html, 'utf-8');
    return 'ok-pretty';
  }

  // 4) Inject before </body> if FAB exists but no setAiHref script
  if (html.includes('askAiBtn') && html.includes('</body>')) {
    html = html.replace('</body>', NEW_MINIFIED + '\n</body>');
    fs.writeFileSync(filePath, html, 'utf-8');
    return 'ok-inject';
  }

  return 'miss';
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
    if (r.startsWith('ok')) ok++;
    else if (r === 'skip') skip++;
    else {
      miss++;
      if (miss <= 10) console.warn('miss:', f);
    }
  }
  console.log(`migrate-qa-prefetch: ok=${ok} skip=${skip} miss=${miss} total=${files.length}`);
}

main();
