const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.join(__dirname, 'data', 'articles');

function isAvatarUrl(url) {
  if (url.includes('unavatar.io') ||
    url.includes('profile_images') ||
    /pbs\.twimg\.com\/profile_images\//.test(url)) return true;
  // Twitter avatar size suffixes in filename
  if (/_(normal|mini|bigger|x96|400x400|200x200)(\.[a-z]+)?(?:\?|$)/i.test(url)) return true;
  return false;
}

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const original = content;

  // Match: <img src="..." alt="头图" class="header-img" />
  const headerImgRegex = /<img\s+src="([^"]+)"\s+alt="头图"\s+class="header-img"\s*\/>/g;

  let changed = false;
  content = content.replace(headerImgRegex, (match, src) => {
    if (isAvatarUrl(src)) {
      changed = true;
      console.log(`  [REMOVE] ${path.basename(filePath)} — avatar header: ${src.substring(0, 80)}...`);
      return '';
    }
    return match;
  });

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  }
  return false;
}

function main() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('Articles directory not found:', ARTICLES_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(ARTICLES_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(ARTICLES_DIR, f));

  console.log(`Found ${files.length} HTML files`);

  let fixed = 0;
  for (const file of files) {
    if (fixFile(file)) fixed++;
  }

  console.log(`\nFixed ${fixed} files with avatar headers`);
}

main();
