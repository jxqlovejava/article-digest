/**
 * fix-touch-scroll.ts
 *
 * 一次性迁移:修复存量文章页的触摸交互。
 *   1. CSS:html/body、.page-wrapper 的 touch-action 从 pan-y 改为 pan-x pan-y
 *      (让浏览器原生支持可横向滚动模块内的左右滑动,如代码块)
 *   2. CSS:.article-content pre 补 touch-action: pan-x pan-y
 *   3. JS:替换触摸处理块 —— 可横向滚动模块内放行原生横向滚动;
 *      屏幕左缘横滑(右移 >48px)立即 history.back() 返回上一页,更灵敏
 *
 * 与 renderTweetHtml 模板保持一致;未来新文章自动生效。幂等可重跑。
 *
 * Usage(在 app 容器内,ts-node 已随 devDeps 装入镜像):
 *   docker exec <app容器> npx ts-node scripts/fix-touch-scroll.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = process.env.ARTICLES_DIR || path.join(BASE, 'data', 'articles');

// 与 renderTweetHtml 模板内的触摸处理块保持一致
const NEW_JS = `// Disable pinch-zoom and page-level horizontal swipe, keep vertical scroll.
// 可横向滚动模块(代码块等)内交给浏览器原生横向滚动;屏幕左缘横滑立即返回上一页。
(function() {
  var _touchStartX = 0, _touchStartY = 0;
  var _lastTouchEnd = 0;
  var _insideHScroll = false;
  var _edgeBackArmed = false;
  var _edgeBackDone = false;
  var _EDGE = 44;      // 左缘返回识别区宽度(px)
  var _BACK_DX = 48;   // 触发返回的最小右移(px)
  function isInsideHScroll(el) {
    while (el && el !== document.body) {
      var st = window.getComputedStyle(el);
      if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) return true;
      el = el.parentElement;
    }
    return false;
  }
  document.addEventListener('touchstart', function(e) {
    if (e.touches.length > 1) { e.preventDefault(); return; }
    var t = e.touches[0];
    _touchStartX = t.clientX;
    _touchStartY = t.clientY;
    _insideHScroll = isInsideHScroll(e.target);
    // 左缘横滑返回:起点贴近屏幕左缘、且不在可横向滚动模块内
    _edgeBackArmed = t.clientX <= _EDGE && !_insideHScroll;
    _edgeBackDone = false;
  }, { passive: false });
  document.addEventListener('touchmove', function(e) {
    if (e.touches.length > 1) { e.preventDefault(); return; }
    var t = e.touches[0];
    var dx = t.clientX - _touchStartX;
    var dy = t.clientY - _touchStartY;
    // 可横向滚动模块内:交给浏览器原生横向滚动,不拦截
    if (_insideHScroll) return;
    // 左缘横滑返回:右移超过阈值且横向主导 → 立即返回上一页
    if (_edgeBackArmed && !_edgeBackDone && dx > _BACK_DX && Math.abs(dx) > Math.abs(dy)) {
      _edgeBackDone = true;
      e.preventDefault();
      history.length > 1 ? history.back() : (location.href = '/');
      return;
    }
    // Block horizontal swipe gestures (keep vertical scroll only)
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      e.preventDefault();
    }
  }, { passive: false });
  document.addEventListener('touchend', function(e) {
    var now = Date.now();
    if (now - _lastTouchEnd <= 300) e.preventDefault();
    _lastTouchEnd = now;
  }, false);
  document.addEventListener('gesturestart', function(e) { e.preventDefault(); });
  document.addEventListener('gesturechange', function(e) { e.preventDefault(); });
  document.addEventListener('gestureend', function(e) { e.preventDefault(); });
})();`;

function main(): void {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('[migrate:scroll] articles dir missing — nothing to do');
    return;
  }
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let cssFixed = 0;
  let jsFixed = 0;
  let injected = 0;
  for (const f of files) {
    const p = path.join(ARTICLES_DIR, f);
    let html: string;
    try {
      html = fs.readFileSync(p, 'utf-8');
    } catch (err) {
      console.error(`[migrate:scroll] read fail ${f}:`, err instanceof Error ? err.message : err);
      continue;
    }
    let next = html;
    let changed = false;

    // 1) CSS: pan-y → pan-x pan-y(html/body 与 .page-wrapper)
    const cssNext = next.replace(/touch-action: pan-y/g, 'touch-action: pan-x pan-y');
    if (cssNext !== next) { next = cssNext; changed = true; }

    // 2) CSS: .article-content pre 补 touch-action
    const preNext = next.replace(
      'overflow-x: auto; margin-bottom: 0.8em; line-height: 1.5;',
      'overflow-x: auto; touch-action: pan-x pan-y; margin-bottom: 0.8em; line-height: 1.5;'
    );
    if (preNext !== next) { next = preNext; changed = true; }

    // 3) JS 触摸处理块:从「// Disable pinch-zoom」到 IIFE 结束整体替换
    if (!next.includes('_insideHScroll')) {
      const start = next.indexOf('// Disable pinch-zoom');
      const end = start >= 0 ? next.indexOf('})();', start) : -1;
      if (start >= 0 && end >= 0) {
        next = next.slice(0, start) + NEW_JS + next.slice(end + 5);
        changed = true;
        jsFixed++;
      } else if (start < 0) {
        // 极老文章没有该块:注入
        const bodyEnd = next.indexOf('</body>');
        if (bodyEnd >= 0) {
          next = next.slice(0, bodyEnd) + '<script>\n' + NEW_JS + '\n</script>\n' + next.slice(bodyEnd);
          changed = true;
          injected++;
        }
      }
    }

    if (changed) {
      fs.writeFileSync(p, next, 'utf-8');
      cssFixed++;
    }
  }
  console.log(`[migrate:scroll] done: ${cssFixed} file(s) updated (css), ${jsFixed} js-block replaced, ${injected} injected`);
}

main();
