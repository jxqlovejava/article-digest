const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ARTICLES_DIR = '/app/data/articles';
const IMAGES_DIR = '/app/data/images';
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://host.docker.internal:7890';

function getProxyAgent(targetUrl) {
  const proxy = new URL(PROXY_URL);
  if (targetUrl.startsWith('https')) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(PROXY_URL);
  }
  return undefined;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const agent = getProxyAgent(url);
    const client = url.startsWith('https') ? https : http;
    const opts = new URL(url);
    if (agent) opts.agent = agent;
    opts.headers = { 'User-Agent': 'TweetArchive/1.0' };
    opts.timeout = 30000;

    client.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      const timer = setTimeout(() => {
        file.destroy();
        fs.unlink(destPath, () => {});
        reject(new Error('Timeout'));
      }, 30000);
      res.pipe(file);
      file.on('finish', () => {
        clearTimeout(timer);
        file.close();
        resolve();
      });
      file.on('error', (err) => {
        clearTimeout(timer);
        file.destroy();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

function extractScreenName(fileName) {
  const match = fileName.match(/^([^_]+)_/);
  return match ? match[1] : null;
}

async function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const baseName = path.basename(filePath, '.html');
  const screenName = extractScreenName(baseName);
  let changed = false;

  // 1. Fix avatar URL → unavatar.io
  const avatarRegex = /<img src="https:\/\/pbs\.twimg\.com\/profile_images\/[^"]+" alt="" class="avatar"/g;
  if (avatarRegex.test(content) && screenName) {
    content = content.replace(
      /<img src="https:\/\/pbs\.twimg\.com\/profile_images\/[^"]+" alt="" class="avatar"/g,
      `<img src="https://unavatar.io/x/${screenName}" alt="" class="avatar"`
    );
    changed = true;
    console.log(`  [AVATAR] Fixed avatar for ${baseName}`);
  }

  // 2. Download and fix header image
  const headerRegex = /<img src="(https:\/\/pbs\.twimg\.com\/media\/[^"]+)" alt="头图" class="header-img"/g;
  let headerMatch;
  while ((headerMatch = headerRegex.exec(content)) !== null) {
    const url = headerMatch[1];
    const ext = path.extname(new URL(url).pathname).split('?')[0] || '.jpg';
    const localName = `${baseName}_header${ext}`;
    const localPath = path.join(IMAGES_DIR, localName);
    try {
      await downloadFile(url, localPath);
      content = content.replace(url, `../images/${localName}`);
      changed = true;
      console.log(`  [HEADER] Downloaded header: ${localName}`);
    } catch (err) {
      console.log(`  [HEADER] FAILED: ${url.substring(0, 80)} — ${err.message}`);
    }
  }

  // 3. Download and fix inline tweet images
  const imgRegex = /<img src="(https:\/\/pbs\.twimg\.com\/media\/[^"]+)" alt="推文图片"/g;
  let imgMatch;
  let imgIdx = 0;
  while ((imgMatch = imgRegex.exec(content)) !== null) {
    const url = imgMatch[1];
    const ext = path.extname(new URL(url).pathname).split('?')[0] || '.jpg';
    const localName = `${baseName}_fix${imgIdx}${ext}`;
    const localPath = path.join(IMAGES_DIR, localName);
    try {
      await downloadFile(url, localPath);
      content = content.replace(url, `../images/${localName}`);
      changed = true;
      imgIdx++;
      console.log(`  [IMAGE] Downloaded: ${localName}`);
    } catch (err) {
      console.log(`  [IMAGE] FAILED: ${url.substring(0, 80)} — ${err.message}`);
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  }
  return false;
}

async function main() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('Articles directory not found:', ARTICLES_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(ARTICLES_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(ARTICLES_DIR, f));

  console.log(`Found ${files.length} HTML files`);
  console.log(`Using proxy: ${PROXY_URL}`);

  let fixed = 0;
  for (const file of files) {
    if (await fixFile(file)) fixed++;
  }

  console.log(`\nFixed ${fixed} files`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
