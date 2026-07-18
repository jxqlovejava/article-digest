import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function sanitizeForFile(name: string): string {
  return name.replace(/[^\w一-龥\-]/g, '_').replace(/_{2,}/g, '_').substring(0, 80);
}

function main() {
  if (!fs.existsSync(META_FILE)) {
    console.log('No meta.json');
    return;
  }
  const meta: any[] = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  if (!fs.existsSync(AVATARS_DIR)) {
    console.log('No avatars dir');
    return;
  }
  const avatarFiles = fs.readdirSync(AVATARS_DIR);

  let fixed = 0;
  for (const entry of meta) {
    const avatar = entry.authorAvatar || '';
    if (!avatar.startsWith('/avatars/')) continue;
    const fileName = path.basename(avatar);
    const exists = avatarFiles.includes(fileName);
    if (exists) continue;

    // Try decoding HTML entities in the path
    const decoded = decodeHtmlEntities(fileName);
    const decodedBase = decoded.replace(/\.[^.]+$/, '');
    const decodedExt = decoded.match(/\.[^.]+$/)?.[0] || '';

    // Look for exact decoded filename or starts-with match
    let match = avatarFiles.find(f => f === decoded);
    if (!match) {
      match = avatarFiles.find(f => f.startsWith(decodedBase + '.'));
    }
    // Also try stripping all non-ascii/non-word to find close match
    if (!match) {
      const sanitized = sanitizeForFile(decodedBase);
      match = avatarFiles.find(f => {
        const b = f.replace(/\.[^.]+$/, '');
        return b === sanitized || b.startsWith(sanitized + '_') || sanitized.startsWith(b + '_');
      });
    }

    if (match) {
      entry.authorAvatar = '/avatars/' + match;
      fixed++;
      console.log(`[fix] ${entry.fileName} -> /avatars/${match}`);
    } else {
      console.log(`[missing] ${entry.fileName}: ${fileName}`);
    }
  }

  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  console.log(`[fix-meta-avatars] fixed=${fixed}`);
}

main();
