/**
 * migrate-media-to-cos.ts
 *
 * 一次性迁移:把 data/videos/*.mp4 和 data/images/* 上传到腾讯云 COS,
 * 并把 data/articles/*.html 里的 ../videos/xxx、../images/xxx 引用改写为 COS 公网 URL。
 *
 * 安全约定:
 * - 已存在于 COS 的对象跳过上传(可中断重跑),但仍会改写 HTML 引用
 * - 上传失败的文件不改写对应 HTML,文章继续用本地副本
 * - 不删除本地文件!验证文章正常后手动删:
 *     rm -rf data/videos/* data/images/*
 *
 * Usage(在 app 容器内,需 .env 里的 COS_* 已生效):
 *   docker exec app-blue npx ts-node scripts/migrate-media-to-cos.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { isCosEnabled, uploadToCos, cosObjectExists, cosUrl, type CosKind } from '../src/services/cos';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(BASE, 'data', 'articles');

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

async function migrateDir(kind: CosKind, refMap: Map<string, string>): Promise<void> {
  const dir = path.join(BASE, 'data', kind === 'video' ? 'videos' : 'images');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  let uploaded = 0, skipped = 0, failed = 0;

  for (const name of files) {
    const localPath = path.join(dir, name);
    if (!fs.statSync(localPath).isFile()) continue;
    const key = `${kind === 'video' ? 'videos' : 'images'}/${name}`;
    try {
      if (await cosObjectExists(key)) {
        skipped++;
      } else {
        await uploadToCos(localPath, key, CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream', kind);
        uploaded++;
        console.log(`[cos] uploaded ${key} (${(fs.statSync(localPath).size / 1024 / 1024).toFixed(1)}MB)`);
      }
      // 只有确认在 COS 上的文件才记录引用映射
      refMap.set(`../${key}`, cosUrl(key));
    } catch (err) {
      failed++;
      console.error(`[cos] FAIL ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[cos] ${kind}: ${uploaded} uploaded, ${skipped} already in COS, ${failed} failed`);
}

function rewriteArticles(refMap: Map<string, string>): void {
  if (!fs.existsSync(ARTICLES_DIR)) return;
  const htmlFiles = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let changed = 0;
  for (const f of htmlFiles) {
    const p = path.join(ARTICLES_DIR, f);
    let html = fs.readFileSync(p, 'utf-8');
    let touched = false;
    for (const [localRef, url] of refMap) {
      if (html.includes(localRef)) {
        html = html.split(localRef).join(url);
        touched = true;
      }
    }
    if (touched) {
      fs.writeFileSync(p, html, 'utf-8');
      changed++;
    }
  }
  console.log(`[html] rewrote ${changed}/${htmlFiles.length} article files`);
}

async function main() {
  if (!isCosEnabled()) {
    console.error('COS not configured — set COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION/COS_BASE_URL');
    process.exit(1);
  }
  const refMap = new Map<string, string>();
  await migrateDir('video', refMap);
  await migrateDir('image', refMap);
  rewriteArticles(refMap);
  console.log('\nDone. 验证文章可正常播放/显示后,再手动删除本地文件: rm -rf data/videos/* data/images/*');
}

main().catch(err => { console.error(err); process.exit(1); });
