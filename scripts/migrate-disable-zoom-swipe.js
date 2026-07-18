const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.resolve(process.cwd(), 'data/articles');

function migrateFile(filePath) {
  let html = fs.readFileSync(filePath, 'utf-8');
  let modified = false;

  // 1. Update viewport to disable zoom
  const viewportRe = /(<meta[^>]*name=["']viewport["'][^>]*content=["'])([^"']*)(["'][^>]*>)/i;
  const viewportMatch = html.match(viewportRe);
  if (viewportMatch) {
    let content = viewportMatch[2];
    if (!/user-scalable\s*=\s*no/i.test(content)) {
      content = content.replace(/user-scalable\s*=[^,]*/i, '').replace(/maximum-scale\s*=[^,]*/i, '').replace(/,\s*,/g, ',').replace(/,\s*$/g, '');
      content = content + (content.endsWith(',') || content.length === 0 ? '' : ',') + ' maximum-scale=1.0, user-scalable=no';
      html = html.replace(viewportMatch[0], viewportMatch[1] + content + viewportMatch[3]);
      modified = true;
    }
  }

  // 2. Add overscroll-behavior-x and page-wrapper styles
  const pageWrapperCss = `
    html, body { overscroll-behavior-x: none; }
    .page-wrapper { overflow-x: hidden; position: relative; min-height: 100vh; }
  `;
  if (!html.includes('.page-wrapper')) {
    const styleEndRe = /(<style[^>]*>)([\s\S]*?)(<\/style>)/i;
    html = html.replace(styleEndRe, function(match, open, body, close) {
      return open + body + pageWrapperCss + close;
    });
    modified = true;
  }

  // 3. Wrap body children in page-wrapper if not already wrapped
  if (!/<body[^>]*>\s*<div class="page-wrapper">/i.test(html)) {
    html = html.replace(/(<body[^>]*>)\s*([\s\S]*?)\s*(<\/body>)/i, function(match, open, body, close) {
      return open + '<div class="page-wrapper">' + body + '</div>' + close;
    });
    modified = true;
  }

  // 4. Add pinch-zoom block script
  const zoomBlockScript = `
<script>
// Disable pinch-zoom and page-level horizontal swipe, keep vertical scroll
(function() {
  var lastTouchEnd = 0;
  document.addEventListener('touchstart', function(e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', function(e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', function(e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, false);
  document.addEventListener('gesturestart', function(e) { e.preventDefault(); });
  document.addEventListener('gesturechange', function(e) { e.preventDefault(); });
  document.addEventListener('gestureend', function(e) { e.preventDefault(); });
})();
</script>
`;
  if (!html.includes('Disable pinch-zoom')) {
    const headCloseRe = /(<\/head>)/i;
    html = html.replace(headCloseRe, zoomBlockScript + '$1');
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, html, 'utf-8');
    console.log('Migrated:', path.basename(filePath));
  } else {
    console.log('Skipped:', path.basename(filePath));
  }
}

function main() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('No articles directory');
    return;
  }
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  for (const file of files) {
    migrateFile(path.join(ARTICLES_DIR, file));
  }
}

main();
