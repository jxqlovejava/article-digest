import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweet-search-test-'));

function loadSearch(dbFile: string) {
  process.env.SEARCH_DB_PATH = dbFile;
  const modPath = path.resolve(__dirname, './search');
  delete require.cache[require.resolve(modPath)];
  return require(modPath) as typeof import('./search');
}

function makeVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  // deterministic pseudo-random based on seed
  let x = seed || 1;
  for (let i = 0; i < dim; i++) {
    x = (x * 9301 + 49297) % 233280;
    v[i] = x / 233280;
  }
  return v;
}

function vecForWord(word: string, dim: number): Float32Array {
  let seed = 0;
  for (let i = 0; i < word.length; i++) seed = (seed * 31 + word.charCodeAt(i)) % 233280;
  return makeVector(dim, seed || 1);
}

describe('escapeFtsQuery', () => {
  const cases: [string, string][] = [
    ['hello world', 'hello world'],
    ['  IP  ', 'IP'],
    ['foo-bar', 'foo bar'],
    ['哈哈哈', '哈哈哈'],
    ['AI + 芯片', 'AI 芯片'],
    ['!@#$%', ''],
    ['UPPER lower', 'UPPER lower'],
  ];

  for (const [input, expected] of cases) {
    it(`escapes "${input}" -> "${expected}"`, () => {
      const search = loadSearch(path.join(tmpDir, `escape-${Date.now()}.db`));
      assert.strictEqual(search.escapeFtsQuery(input), expected);
    });
  }
});

describe('insert / delete / syncMeta', () => {
  let search: ReturnType<typeof loadSearch>;
  beforeEach(() => {
    search = loadSearch(path.join(tmpDir, `crud-${Date.now()}.db`));
  });

  it('inserts and finds by title', () => {
    search.insertArticle({
      fileName: 'a.html',
      title: 'AI investment thesis',
      author: 'Alice',
      authorHandle: 'alice',
      body: 'Body text here',
    });
    const ids = search.keywordSearch('investment');
    assert.deepStrictEqual(ids, ['a.html']);
  });

  it('deletes article from index', () => {
    search.insertArticle({
      fileName: 'b.html',
      title: 'Delete me',
      author: 'Bob',
      authorHandle: 'bob',
      body: 'Body',
    });
    assert.strictEqual(search.keywordSearch('Delete').length, 1);
    search.deleteArticle('b.html');
    assert.strictEqual(search.keywordSearch('Delete').length, 0);
  });

  it('syncMeta removes orphaned entries', () => {
    search.insertArticle({
      fileName: 'keep.html',
      title: 'Keep',
      author: 'A',
      authorHandle: 'a',
      body: 'Body',
    });
    search.insertArticle({
      fileName: 'orphan.html',
      title: 'Orphan',
      author: 'B',
      authorHandle: 'b',
      body: 'Body',
    });
    search.syncMeta(['keep.html']);
    assert.strictEqual(search.keywordSearch('Keep').length, 1);
    assert.strictEqual(search.keywordSearch('Orphan').length, 0);
  });
});

describe('keywordSearch', () => {
  let search: ReturnType<typeof loadSearch>;
  beforeEach(() => {
    search = loadSearch(path.join(tmpDir, `kw-${Date.now()}.db`));
    search.insertArticle({ fileName: 'cjk.html', title: '中文标题', author: 'A', authorHandle: 'a', body: '哈哈哈哈真有趣' });
    search.insertArticle({ fileName: 'ascii.html', title: 'AI future', author: 'B', authorHandle: 'b', body: 'The future of artificial intelligence' });
    search.insertArticle({ fileName: 'mixed.html', title: 'AI 芯片', author: 'C', authorHandle: 'c', body: 'AI芯片改变世界' });
  });

  it('matches CJK trigram exactly', () => {
    assert.deepStrictEqual(search.keywordSearch('哈哈哈'), ['cjk.html']);
  });

  it('falls back to short keyword for 2-char CJK and matches substring', () => {
    assert.deepStrictEqual(search.keywordSearch('哈哈'), ['cjk.html']);
  });

  it('matches ASCII term and returns ranked results', () => {
    const ids = search.keywordSearch('future');
    assert.ok(ids.includes('ascii.html'));
  });

  it('matches mixed query with multiple terms', () => {
    const ids = search.keywordSearch('AI 芯片');
    assert.ok(ids.includes('mixed.html'));
  });

  it('requires Latin brand tokens in mixed CN/EN queries (not loose CJK bigrams)', () => {
    search.insertArticle({
      fileName: 'reddit-gold.html',
      title: '怎么在 Reddit 赚到自己的第一桶金',
      author: 'A',
      authorHandle: 'a',
      body: 'Reddit 搞钱完整指南',
    });
    search.insertArticle({
      fileName: 'unrelated-money.html',
      title: '月入23w，我把自己拆给你看',
      author: 'B',
      authorHandle: 'b',
      body: '自己创业赚到第一桶金的经历，跟社区无关',
    });
    search.insertArticle({
      fileName: 'reddit-guide.html',
      title: 'Reddit 全网最全使用指南：从入门到榨干',
      author: 'C',
      authorHandle: 'c',
      body: 'Reddit 入门',
    });

    const ids = search.keywordSearch('怎么在Reddit赚到自己的第一桶金');
    assert.ok(ids.includes('reddit-gold.html'), 'exact Reddit topic should hit');
    assert.ok(!ids.includes('unrelated-money.html'), 'must not match only 自己/第一桶金 without Reddit');
    // Generic Reddit guide lacks 赚到/第一桶金 — should not match this specific query
    assert.ok(!ids.includes('reddit-guide.html'), 'must require Chinese content tokens, not brand alone');
    assert.strictEqual(ids[0], 'reddit-gold.html', 'best title match should rank first');
  });

  it('matches natural-language CJK questions via title cores (容错率)', () => {
    search.insertArticle({
      fileName: 'fault-tolerance.html',
      title: '提高投资“容错率”的三个思路',
      author: '思想钢印',
      authorHandle: 'x',
      body: '投资要提高容错率，分散风险，留出安全边际。',
    });
    search.insertArticle({
      fileName: 'unrelated.html',
      title: 'AI 产品六条原则',
      author: 'Y',
      authorHandle: 'y',
      body: '产品原则与容错无关',
    });

    const ids = search.keywordSearch('高容错率的投资者通常遵循哪些原则？');
    assert.ok(
      ids.includes('fault-tolerance.html'),
      'should find 容错率 article from full question'
    );
    assert.strictEqual(ids[0], 'fault-tolerance.html', '容错率 title should rank first');
  });

  it('returns empty for nonexistent term', () => {
    assert.deepStrictEqual(search.keywordSearch('xyzabc'), []);
  });

  it('returns empty for query shorter than 2 chars', async () => {
    assert.deepStrictEqual(search.keywordSearch('Z'), []);
    assert.deepStrictEqual(await search.searchArticles('Z'), []);
  });
});

describe('shortKeywordSearch word boundaries', () => {
  let search: ReturnType<typeof loadSearch>;
  beforeEach(() => {
    search = loadSearch(path.join(tmpDir, `short-${Date.now()}.db`));
    search.insertArticle({ fileName: 'ship.html', title: 'Ship', author: 'A', authorHandle: 'a', body: 'A big ship on the sea' });
    search.insertArticle({ fileName: 'ip.html', title: 'IP', author: 'B', authorHandle: 'b', body: 'My IP address is here' });
    search.insertArticle({ fileName: 'ipo.html', title: 'IPO', author: 'C', authorHandle: 'c', body: 'We had an IPO today' });
    search.insertArticle({ fileName: 'cjk.html', title: '中国美国', author: 'D', authorHandle: 'd', body: '中国美国历史' });
  });

  it('does not match "IP" inside "ship"', () => {
    assert.ok(!search.shortKeywordSearch('IP').includes('ship.html'));
  });

  it('matches standalone "IP"', () => {
    assert.ok(search.shortKeywordSearch('IP').includes('ip.html'));
  });

  it('does not match "IP" inside "IPO"', () => {
    assert.ok(!search.shortKeywordSearch('IP').includes('ipo.html'));
  });

  it('matches CJK substring across character boundaries', () => {
    assert.ok(search.shortKeywordSearch('中国').includes('cjk.html'));
    assert.ok(search.shortKeywordSearch('国美').includes('cjk.html'));
    assert.ok(search.shortKeywordSearch('美国').includes('cjk.html'));
  });

  it('escapes LIKE wildcards so "%" and "_" are literal', () => {
    search.insertArticle({ fileName: 'pct.html', title: 'test%foo', author: 'E', authorHandle: 'e', body: 'Body' });
    search.insertArticle({ fileName: 'underscore.html', title: 'test_foo', author: 'F', authorHandle: 'f', body: 'Body' });
    search.insertArticle({ fileName: 'nomatch.html', title: 'testXfoo', author: 'G', authorHandle: 'g', body: 'Body' });
    assert.deepStrictEqual(search.shortKeywordSearch('test%foo'), ['pct.html']);
    assert.deepStrictEqual(search.shortKeywordSearch('test_foo'), ['underscore.html']);
    assert.ok(!search.shortKeywordSearch('test%foo').includes('nomatch.html'));
  });
});

describe('searchArticles with mocked embeddings', () => {
  let search: ReturnType<typeof loadSearch>;
  beforeEach(() => {
    search = loadSearch(path.join(tmpDir, `semantic-${Date.now()}.db`));
    search.setTestEmbedder(async (text: string) => {
      const word = text.toLowerCase().includes('cat') ? 'cat'
        : text.toLowerCase().includes('dog') ? 'dog'
        : 'other';
      return vecForWord(word, 384);
    });
  });

  it('combines keyword and semantic results without duplicates', async () => {
    search.insertArticle({ fileName: 'cat.html', title: 'Cat story', author: 'A', authorHandle: 'a', body: 'A story about felines' });
    search.insertArticle({ fileName: 'dog.html', title: 'Dog story', author: 'B', authorHandle: 'b', body: 'A story about canines' });
    await search.generateEmbedding('cat.html', 'cat');
    await search.generateEmbedding('dog.html', 'dog');

    const ids = await search.searchArticles('cat');
    assert.ok(ids.includes('cat.html'));
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it('returns semantic match even when keyword misses', async () => {
    search.insertArticle({ fileName: 'kitten.html', title: 'Kitten', author: 'A', authorHandle: 'a', body: 'Small cute animal' });
    await search.generateEmbedding('kitten.html', 'cat');

    const ids = await search.searchArticles('cat');
    assert.ok(ids.includes('kitten.html'));
  });

  it('returns keyword match when embedder is null', async () => {
    search.setTestEmbedder(null);
    search.insertArticle({ fileName: 'cat.html', title: 'Cat', author: 'A', authorHandle: 'a', body: 'Meow' });
    const ids = await search.searchArticles('Cat');
    assert.deepStrictEqual(ids, ['cat.html']);
  });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
