/**
 * fix-edge-back-swipe.ts
 *
 * 一次性迁移:升级存量文章页的左缘横滑返回交互(修复「不灵敏 + 不丝滑」)。
 *
 * 上一版(fix-touch-scroll.ts)的问题是:
 *   1) isInsideHScroll 把正文容器 .article-content(overflow-x:auto)也当成可横向滚动,
 *      一旦内容略溢出,整篇正文都会被判定为「可横向滚动」→ 左缘返回被解除武装,滑不动;
 *   2) 触发条件是 dx>48 且严格横向主导,手指稍带纵向漂移就触发不了;
 *   3) 一触发就立刻 history.back(),手势没完成就跳转,突兀。
 *
 * 新版:
 *   1) isInsideHScroll 跳过 .article-content 本身,只认正文内的横向滚动子模块(如代码块);
 *   2) 左缘识别区放宽到 60px;dx>6 且横向主导即进入跟手;
 *   3) 页面跟手滑动(带阻力),松手超过 25% 屏宽才回退,否则平滑弹回。
 *
 * 与 renderTweetHtml 模板保持一致(含图片预览打开时不触发)。幂等可重跑。
 *
 * Usage(在 app 容器内,ts-node 已随 devDeps 装入镜像):
 *   docker exec <app容器> npx ts-node scripts/fix-edge-back-swipe.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = process.env.ARTICLES_DIR || path.join(BASE, 'data', 'articles');

// 与 renderTweetHtml 模板内的触摸处理块保持一致
const NEW_JS = `// Disable pinch-zoom and page-level horizontal swipe, keep vertical scroll.
// 可横向滚动模块(代码块等)内交给浏览器原生横向滚动;
// 屏幕左缘横滑返回:页面跟手滑动,松手过阈值丝滑回退,不足则弹回。
(function() {
  var _touchStartX = 0, _touchStartY = 0;
  var _lastTouchEnd = 0;
  var _insideHScroll = false;
  var _edgeBack = false;       // 本次触摸已武装左缘返回
  var _edgeEngaged = false;    // 已进入跟手返回
  var _edgeMaxDx = 0;
  var _EDGE = 60;              // 左缘返回识别区宽度(px)
  var _wrapper = document.querySelector('.page-wrapper');
  function isInsideHScroll(el) {
    while (el && el !== document.body) {
      // 正文容器本身不算(否则整篇都可能被误判成可横向滚动而失效),只认正文内的横向滚动子模块
      if (el.classList && el.classList.contains('article-content')) return false;
      var st = window.getComputedStyle(el);
      if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) return true;
      el = el.parentElement;
    }
    return false;
  }
  function setFollow(x) {
    if (!_wrapper) return;
    var t = Math.max(0, Math.min(Math.round(x * 0.55), Math.round(window.innerWidth * 0.45)));
    // 只改 transform(合成器,不触发重绘);transition/shadow 在进入跟手时设一次
    _wrapper.style.transform = 'translateX(' + t + 'px)';
  }
  function snapBack() {
    if (!_wrapper) return;
    _wrapper.style.transition = 'transform 0.25s ease-out, box-shadow 0.25s ease-out';
    _wrapper.style.transform = 'translateX(0)';
    _wrapper.style.boxShadow = '';
    setTimeout(function() {
      if (_wrapper) { _wrapper.style.transition = ''; _wrapper.style.willChange = ''; }
    }, 280);
  }
  function commitBack() {
    // 松手即回退:不再先做滑出动画再延迟跳转,避免「滑到一半停顿一下再回首页」的尴尬。
    // 跟手阶段已给足交互反馈,跳转交给浏览器原生返回过渡。
    history.length > 1 ? history.back() : (location.href = '/');
  }
  document.addEventListener('touchstart', function(e) {
    if (e.touches.length > 1) { e.preventDefault(); return; }
    var t = e.touches[0];
    _touchStartX = t.clientX;
    _touchStartY = t.clientY;
    _insideHScroll = isInsideHScroll(e.target);
    // 图片预览打开时不触发返回
    var _lb = document.getElementById('imgLightbox');
    var _lbOpen = !!(_lb && _lb.classList.contains('show'));
    // 左缘返回:起点贴近左缘、不在横向滚动子模块内、且图片预览未打开
    _edgeBack = t.clientX <= _EDGE && !_insideHScroll && !_lbOpen;
    _edgeEngaged = false;
    _edgeMaxDx = 0;
  }, { passive: false });
  document.addEventListener('touchmove', function(e) {
    if (e.touches.length > 1) { e.preventDefault(); return; }
    var t = e.touches[0];
    var dx = t.clientX - _touchStartX;
    var dy = t.clientY - _touchStartY;
    // 可横向滚动模块内:交给浏览器原生横向滚动,不拦截
    if (_insideHScroll) return;
    if (_edgeBack) {
      // 明显向右且横向主导 → 进入跟手返回
      if (dx > 6 && Math.abs(dx) > Math.abs(dy) * 0.8) {
        if (!_edgeEngaged && _wrapper) {
          // 只在此设一次 transition:none + 阴影 + will-change,避免逐帧重绘卡顿
          _wrapper.style.transition = 'none';
          _wrapper.style.boxShadow = '4px 0 20px rgba(0,0,0,0.15)';
          _wrapper.style.willChange = 'transform';
        }
        _edgeEngaged = true;
      }
      if (_edgeEngaged) {
        e.preventDefault();
        if (dx > _edgeMaxDx) _edgeMaxDx = dx;
        setFollow(dx);
        return;
      }
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
    if (_edgeBack) {
      if (_edgeEngaged) {
        var threshold = Math.max(80, window.innerWidth * 0.25);
        if (_edgeMaxDx > threshold) commitBack();
        else snapBack();
      }
      _edgeBack = false;
      _edgeEngaged = false;
    }
  }, false);
  document.addEventListener('touchcancel', function() {
    _edgeBack = false;
    _edgeEngaged = false;
    snapBack();
  }, false);
  document.addEventListener('gesturestart', function(e) { e.preventDefault(); });
  document.addEventListener('gesturechange', function(e) { e.preventDefault(); });
  document.addEventListener('gestureend', function(e) { e.preventDefault(); });
})();`;

function main(): void {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('[migrate:edgeback] articles dir missing — nothing to do');
    return;
  }
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let replaced = 0;
  let skipped = 0;
  for (const f of files) {
    const p = path.join(ARTICLES_DIR, f);
    let html: string;
    try {
      html = fs.readFileSync(p, 'utf-8');
    } catch (err) {
      console.error(`[migrate:edgeback] read fail ${f}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (html.includes("willChange = 'transform'")) { skipped++; continue; }  // 已是最新版
    const start = html.indexOf('// Disable pinch-zoom');
    const end = start >= 0 ? html.indexOf('})();', start) : -1;
    if (start >= 0 && end >= 0) {
      html = html.slice(0, start) + NEW_JS + html.slice(end + 5);
      fs.writeFileSync(p, html, 'utf-8');
      replaced++;
    } else {
      console.log(`[migrate:edgeback] skip ${f}: touch block not found`);
    }
  }
  console.log(`[migrate:edgeback] done: ${replaced} upgraded, ${skipped} already new`);
}

main();
