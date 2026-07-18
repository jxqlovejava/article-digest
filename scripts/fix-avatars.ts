/**
 * Re-download avatars for articles that still use unavatar.io URLs.
 * Run with: TS_NODE_TRANSPILE_ONLY=true npx ts-node scripts/fix-avatars.ts
 */
import fs from 'fs';
import path from 'path';

// Minimal copy of download logic (avoids importing full renderer)
const EMAIL = process.env.HTTPS_PROXY || 'http://127.0.0.1:7890';
const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const META_FILE = path.join(DATA_DIR, 'meta.json');

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*#\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 120);
}

async function download(url: string, dest: string): Promise<boolean> {
  const { default: axios } = await import('axios');
  const agent = new HttpsProxyAgent(EMAIL);
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000, maxRedirects: 5,
      httpsAgent: agent, headers: { 'User-Agent': 'TweetArchive/1.0' },
    });
    const ct = String(res.headers['content-type'] || '');
    let ext = '.jpg';
    if (ct.includes('image/png')) ext = '.png';
    else if (ct.includes('image/webp')) ext = '.webp';
    else if (ct.includes('image/gif')) ext = '.gif';
    fs.writeFileSync(dest + ext, Buffer.from(res.data));
    return true;
  } catch (err) {
    console.error(`[fix-avatars] Download failed: ${url}:`, (err as any)?.message);
    return false;
  }
}

async function main() {
  const meta: any[] = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  let fixed = 0;
  let skipped = 0;

  for (const entry of meta) {
    const avatarUrl = entry.authorAvatar || '';
    if (!avatarUrl.startsWith('https://unavatar.io/')) {
      skipped++;
      continue;
    }
    const screenName = avatarUrl.split('/').pop() || '';
    if (!screenName) continue;

    const baseName = `twitter_${screenName}_${sanitizeFileName(entry.author || screenName)}`;
    const basePath = path.join(AVATARS_DIR, baseName);

    // Check if already downloaded
    if (fs.existsSync(AVATARS_DIR)) {
      const existing = fs.readdirSync(AVATARS_DIR).find(f => f.startsWith(baseName));
      if (existing) {
        // Already has local avatar, update meta
        entry.authorAvatar = '/avatars/' + existing;
        fixed++;
        continue;
      }
    }

    // Try downloading from unavatar.io
    const ok = await download(avatarUrl, basePath);
    if (ok) {
      const ext = fs.readdirSync(AVATARS_DIR).find(f => f.startsWith(baseName + '.'))?.split('.').pop() || 'jpg';
      entry.authorAvatar = `/avatars/${baseName}.${ext}`;
      fixed++;
      console.log(`[fix-avatars] Downloaded: ${screenName}`);
    }
  }

  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  console.log(`[fix-avatars] Done: fixed=${fixed} skipped=${skipped} total=${meta.length}`);
}

main().catch(console.error);
