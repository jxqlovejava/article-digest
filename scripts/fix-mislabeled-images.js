/**
 * Fix image files whose extension doesn't match content (esp. SVG saved as .jpg).
 * Renames files and updates article HTML src references.
 *
 * Usage: node scripts/fix-mislabeled-images.js [imagesDir] [articlesDir]
 */
const fs = require('fs');
const path = require('path');

function detectImageExtFromBuffer(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return '.png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return '.webp';
  }
  const head = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || /^<svg[\s>]/i.test(head)) {
    return '.svg';
  }
  return null;
}

function main() {
  const imagesDir = path.resolve(process.argv[2] || path.join(process.cwd(), 'data/images'));
  const articlesDir = path.resolve(process.argv[3] || path.join(process.cwd(), 'data/articles'));
  if (!fs.existsSync(imagesDir)) {
    console.error('images dir missing', imagesDir);
    process.exit(1);
  }

  const renames = []; // { from, to, base }
  for (const name of fs.readdirSync(imagesDir)) {
    const p = path.join(imagesDir, name);
    if (!fs.statSync(p).isFile()) continue;
    const cur = path.extname(name).toLowerCase();
    if (!cur || cur === '.svg') continue; // already svg or no ext
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const detected = detectImageExtFromBuffer(buf.subarray(0, n));
    if (!detected) continue;
    const curNorm = cur === '.jpeg' ? '.jpg' : cur;
    // Only rename when browser would break: SVG/XML mislabeled, or optional PNG fix
    // SVG mislabeled is critical; PNG-as-jpg usually still renders — still fix SVG only for safety/speed
    // unless --all passed
    const all = process.argv.includes('--all');
    if (!all && detected !== '.svg') continue;
    if (curNorm === detected) continue;
    const nextName = name.slice(0, name.length - cur.length) + detected;
    const nextPath = path.join(imagesDir, nextName);
    if (fs.existsSync(nextPath)) {
      console.warn('skip exists', nextName);
      continue;
    }
    fs.renameSync(p, nextPath);
    renames.push({ from: name, to: nextName });
    console.log('rename', name, '->', nextName);
  }

  if (!renames.length) {
    console.log('no renames needed');
    return;
  }

  // Update article HTML references
  let articlesTouched = 0;
  if (fs.existsSync(articlesDir)) {
    for (const f of fs.readdirSync(articlesDir).filter((x) => x.endsWith('.html'))) {
      const ap = path.join(articlesDir, f);
      let html = fs.readFileSync(ap, 'utf-8');
      let changed = false;
      for (const { from, to } of renames) {
        if (html.includes(from)) {
          html = html.split(from).join(to);
          changed = true;
        }
      }
      // also soften wechat alt if present
      if (changed) {
        html = html.replace(/alt="推文图片"/g, 'alt="配图"');
        fs.writeFileSync(ap, html, 'utf-8');
        articlesTouched++;
        console.log('article', f);
      }
    }
  }
  console.log(`done renames=${renames.length} articles=${articlesTouched}`);
}

main();
