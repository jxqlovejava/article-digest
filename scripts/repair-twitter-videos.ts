/**
 * repair-twitter-videos.ts
 *
 * 修复历史文章中视频下载失败回退成 video.twimg.com 原始链接的问题
 * (根因是 downloadFile 旧的 20s 总超时,长视频必挂;已修复为 60s 无活动超时)。
 *
 * 对每篇仍含 video.twimg.com 的文章:
 *   1. 提取所有 Twitter 视频 URL
 *   2. 逐个下载(走代理,无总时长限制) → 上传 COS(键 videos/<base>_fixvid<k>.mp4)
 *   3. HTML 中的 URL 替换为 COS 地址
 * 下载失败(如原视频已 404)保留原链接,可重跑。
 *
 * Usage(容器内):
 *   docker exec app-green npx ts-node scripts/repair-twitter-videos.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { downloadFile } from '../src/services/renderer';
import { isCosEnabled, uploadToCos, cosObjectExists, cosUrl } from '../src/services/cos';

const BASE = path.join(__dirname, '..');
const ARTICLES_DIR = path.join(BASE, 'data', 'articles');
const TMP_DIR = path.join(BASE, 'data', 'videos');

async function main() {
  if (!isCosEnabled()) {
    console.error('COS not configured');
    process.exit(1);
  }
  const htmlFiles = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  let fixedArticles = 0, fixedVideos = 0, failedVideos = 0;

  for (const f of htmlFiles) {
    const p = path.join(ARTICLES_DIR, f);
    let html = fs.readFileSync(p, 'utf-8');
    const urls = [...new Set([...html.matchAll(/https:\/\/video\.twimg\.com[^"<]+/g)].map(m => m[0]))];
    if (urls.length === 0) continue;

    const base = f.replace(/\.html$/, '');
    let touched = false;
    for (let k = 0; k < urls.length; k++) {
      const url = urls[k];
      const key = `videos/${base}_fixvid${k}.mp4`;
      try {
        if (!(await cosObjectExists(key))) {
          const tmpPath = path.join(TMP_DIR, key.replace('videos/', ''));
          await downloadFile(url.replace(/&amp;/g, '&'), tmpPath);
          await uploadToCos(tmpPath, key, 'video/mp4', 'video');
          fs.unlinkSync(tmpPath);
          console.log(`[repair] uploaded ${key}`);
        }
        html = html.split(url).join(cosUrl(key));
        touched = true;
        fixedVideos++;
      } catch (err) {
        failedVideos++;
        console.error(`[repair] FAIL ${f} ${url}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (touched) {
      fs.writeFileSync(p, html, 'utf-8');
      fixedArticles++;
    }
  }
  console.log(`\nDone. articles fixed: ${fixedArticles}, videos fixed: ${fixedVideos}, failed: ${failedVideos}`);
}

main().catch(err => { console.error(err); process.exit(1); });
