/**
 * Migration: 文章详情页图片预览 — 旧文章补双指捏合缩放
 *
 * 把旧版 lightbox(仅左右滑动切换)升级为支持双指缩放 / 放大后平移 / 双击切换的版本,
 * 对齐微信公众号图片预览体验。新代码块从 dist/services/renderer.js 提取
 * (与 renderer.ts 单一来源,不在本脚本里重复维护)。
 *
 * Usage (on server):
 *   docker exec <app容器> npm run migrate:lightbox
 *
 * 可重复运行:已迁移(含"双指缩放"文案)或没有旧 lightbox 的文章自动跳过。
 */

const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.resolve(process.cwd(), 'data/articles');
const DIST_FILE = path.resolve(process.cwd(), 'dist/services/renderer.js');

// ---- 从编译产物提取新版 lightbox 手势代码块 ----
const dist = fs.readFileSync(DIST_FILE, 'utf8');
const LIGHTBOX_MARK = '// ---- Image lightbox ----';
const BLOCK_START = '  var startX = 0, startY = 0, currentX = 0, currentY = 0;';
const BLOCK_END = '\n  function init() {';

const markIdx = dist.indexOf(LIGHTBOX_MARK);
const ns = markIdx >= 0 ? dist.indexOf(BLOCK_START, markIdx) : -1;
const ne = ns >= 0 ? dist.indexOf(BLOCK_END, ns) : -1;
if (ns < 0 || ne < 0) {
  console.error('[migrate:lightbox] 无法从 dist/services/renderer.js 提取新版 lightbox 代码,请先 npm run build');
  process.exit(1);
}
const NEW_BLOCK = dist.slice(ns, ne);
console.log('[migrate:lightbox] 已从 dist 提取新版 lightbox 代码块(' + NEW_BLOCK.length + ' 字符)');

// ---- 三处目标替换 ----
const OLD_HINT = '左右滑动切换 · 下拉关闭';
const NEW_HINT = '双指缩放 · 左右滑动切换 · 下拉关闭';

const OLD_EDGE =
  '    // 左缘横滑返回:起点贴近屏幕左缘、且不在可横向滚动模块内\n' +
  '    _edgeBackArmed = t.clientX <= _EDGE && !_insideHScroll;';
const NEW_EDGE =
  "    // 左缘横滑返回:起点贴近屏幕左缘、且不在可横向滚动模块内、且图片预览未打开\n" +
  "    var _lb = document.getElementById('imgLightbox');\n" +
  "    var _lbOpen = !!(_lb && _lb.classList.contains('show'));\n" +
  '    _edgeBackArmed = t.clientX <= _EDGE && !_insideHScroll && !_lbOpen;';

if (!fs.existsSync(ARTICLES_DIR)) {
  console.error('[migrate:lightbox] 目录不存在: ' + ARTICLES_DIR);
  process.exit(1);
}

let total = 0, migrated = 0, skipped = 0, failed = 0;

for (const file of fs.readdirSync(ARTICLES_DIR)) {
  if (!file.endsWith('.html')) continue;
  total++;
  const filePath = path.join(ARTICLES_DIR, file);
  let html;
  try {
    html = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error('  ✗ 读取失败 ' + file + ': ' + e.message);
    failed++;
    continue;
  }

  // 已迁移或没有旧 lightbox 的文章跳过
  if (html.includes('双指缩放')) { skipped++; continue; }
  if (html.indexOf(LIGHTBOX_MARK) < 0) { skipped++; continue; }

  let out = html;

  // 1. 替换 lightbox 手势代码块
  const lbIdx = out.indexOf(LIGHTBOX_MARK);
  const s = out.indexOf(BLOCK_START, lbIdx);
  const e = s >= 0 ? out.indexOf(BLOCK_END, s) : -1;
  if (s < 0 || e <= s) {
    console.error('  ✗ ' + file + ': 未找到旧 lightbox 手势代码块标记,跳过');
    failed++;
    continue;
  }
  out = out.slice(0, s) + NEW_BLOCK + out.slice(e);

  // 2. 替换提示文案
  out = out.split(OLD_HINT).join(NEW_HINT);

  // 3. 替换左缘横滑返回守卫(图片预览打开时不触发)
  out = out.split(OLD_EDGE).join(NEW_EDGE);

  try {
    fs.writeFileSync(filePath, out);
    migrated++;
    console.log('  ✓ ' + file);
  } catch (err) {
    console.error('  ✗ 写入失败 ' + file + ': ' + err.message);
    failed++;
  }
}

console.log('\n[migrate:lightbox] 完成: 共 ' + total + ' 篇, 迁移 ' + migrated + ', 跳过 ' + skipped + ', 失败 ' + failed);
