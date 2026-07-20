import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

let origCwd: string;

function setupTempDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'article-digest-test-'));
  fs.mkdirSync(path.join(tmp, 'data', 'articles'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data', 'syntheses', 'daily'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data', 'syntheses', 'weekly'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data', 'syntheses', 'monthly'), { recursive: true });
  return tmp;
}

function createMeta(tmpDir: string, meta: unknown[]): void {
  fs.writeFileSync(path.join(tmpDir, 'data', 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

function createArticle(tmpDir: string, fileName: string, title: string, content: string): void {
  const html = `<!DOCTYPE html><html><head><title>${title}</title></head><body><div class="article-content">${content}</div></body></html>`;
  fs.writeFileSync(path.join(tmpDir, 'data', 'articles', fileName), html, 'utf-8');
}

function clearRequireCache(): void {
  const patterns = [
    './renderer',
    './synthesis',
    './topic-cluster',
    './periodic-synthesis',
    './search',
    './llm',
    './opinions',
  ];
  for (const p of patterns) {
    try {
      const resolved = require.resolve(path.resolve(__dirname, p));
      delete require.cache[resolved];
    } catch { /* skip if never loaded */ }
  }
}

function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}/${m}/${day}`;
}

// ── Topic overlap fallback ──────────────────────────────────────────────

describe('synthesis — topic overlap fallback', () => {
  const tmpDir = setupTempDir();

  before(() => {
    origCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.SEARCH_DB_PATH = path.join(tmpDir, 'data', 'search.db');
    process.env.KNOWLEDGE_DB_PATH = path.join(tmpDir, 'data', 'knowledge.db');

    createArticle(tmpDir, 'ai_1.html', 'AI Overview',
      '<p>人工智能 机器学习 深度学习 神经网络 自然语言处理</p>');
    createArticle(tmpDir, 'ai_2.html', 'ML Deep Dive',
      '<p>机器学习 神经网络 监督学习 无监督学习 数据科学</p>');
    createArticle(tmpDir, 'finance_1.html', 'Market Update',
      '<p>股市 投资 理财 经济 市场分析</p>');

    createMeta(tmpDir, [
      { fileName: 'ai_1.html', title: 'AI Overview', author: 'Test', authorHandle: 'test', tweetUrl: '', tweetDate: '2026/01/01', savedDate: '2026/01/01', tweetTimestamp: 1767225600, savedTimestamp: 1767225600, contentKey: 'AI Overview', sourceType: 'twitter' },
      { fileName: 'ai_2.html', title: 'ML Deep Dive', author: 'Test', authorHandle: 'test2', tweetUrl: '', tweetDate: '2026/01/02', savedDate: '2026/01/02', tweetTimestamp: 1767312000, savedTimestamp: 1767312000, contentKey: 'ML Deep Dive', sourceType: 'twitter' },
      { fileName: 'finance_1.html', title: 'Market Update', author: 'Test', authorHandle: 'test3', tweetUrl: '', tweetDate: '2026/01/03', savedDate: '2026/01/03', tweetTimestamp: 1767398400, savedTimestamp: 1767398400, contentKey: 'Market Update', sourceType: 'twitter' },
    ]);

    clearRequireCache();
  });

  after(() => {
    process.chdir(origCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('discovers related articles via topic overlap (fallback)', async () => {
    // Temporarily disable LLM to force topic-overlap fallback
    const origKey = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = '';
    clearRequireCache();

    const synthesis = require(path.resolve(__dirname, './synthesis')) as typeof import('./synthesis');

    const links = await synthesis.discoverLinks('ai_1.html');

    assert.ok(Array.isArray(links), 'links should be an array');

    // ai_1.html and ai_2.html share 机器学习 and 神经网络 topics -> linked
    const ai2Link = links.find(l => l.targetFileName === 'ai_2.html');
    assert.ok(ai2Link, 'should find link between ai_1 and ai_2');
    assert.strictEqual(ai2Link!.sourceFileName, 'ai_1.html');
    assert.strictEqual(ai2Link!.relation, 'related');
    assert.ok(ai2Link!.strength > 0, 'strength should be positive');
    assert.ok(
      ai2Link!.explanation.includes('机器学习') || ai2Link!.explanation.includes('神经网络'),
      'explanation should mention shared topics'
    );

    // finance_1.html has no shared topics with ai_1.html -> no link
    const financeLink = links.find(l => l.targetFileName === 'finance_1.html');
    assert.ok(!financeLink, 'should NOT find link between ai_1 and finance_1');

    // Test DB query functions
    const ai1Links = synthesis.getLinksForArticle('ai_1.html');
    assert.ok(ai1Links.length >= 1, 'getLinksForArticle should return links');
    assert.ok(ai1Links.some(l => l.targetFileName === 'ai_2.html'), 'should include ai_2 link');

    const allLinks = synthesis.getAllLinks();
    assert.ok(allLinks.length >= 1, 'getAllLinks should return links');

    // Restore LLM key
    process.env.LLM_API_KEY = origKey;
  });
});

// ── Topic clustering ────────────────────────────────────────────────────

describe('topic-cluster — fallback clustering', () => {
  const tmpDir = setupTempDir();

  before(() => {
    origCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.SEARCH_DB_PATH = path.join(tmpDir, 'data', 'search.db');

    createArticle(tmpDir, 'ai_1.html', 'AI Overview',
      '<p>人工智能 机器学习 深度学习 神经网络 自然语言处理</p>');
    createArticle(tmpDir, 'ai_2.html', 'ML Deep Dive',
      '<p>机器学习 神经网络 监督学习 无监督学习 数据科学</p>');
    createArticle(tmpDir, 'finance_1.html', 'Market Update',
      '<p>股市 投资 理财 经济 市场分析</p>');

    createMeta(tmpDir, [
      { fileName: 'ai_1.html', title: 'AI Overview', author: 'Test', authorHandle: 'test', tweetUrl: '', tweetDate: '2026/01/01', savedDate: '2026/01/01', tweetTimestamp: 1767225600, savedTimestamp: 1767225600, contentKey: 'AI Overview', sourceType: 'twitter' },
      { fileName: 'ai_2.html', title: 'ML Deep Dive', author: 'Test', authorHandle: 'test2', tweetUrl: '', tweetDate: '2026/01/02', savedDate: '2026/01/02', tweetTimestamp: 1767312000, savedTimestamp: 1767312000, contentKey: 'ML Deep Dive', sourceType: 'twitter' },
      { fileName: 'finance_1.html', title: 'Market Update', author: 'Test', authorHandle: 'test3', tweetUrl: '', tweetDate: '2026/01/03', savedDate: '2026/01/03', tweetTimestamp: 1767398400, savedTimestamp: 1767398400, contentKey: 'Market Update', sourceType: 'twitter' },
    ]);
    clearRequireCache();
  });

  after(() => {
    process.chdir(origCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('builds topic clusters from co-occurrence graph', async () => {
    // Disable LLM to test fallback clustering
    const origKey = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = '';
    clearRequireCache();
    const tc = require(path.resolve(__dirname, './topic-cluster')) as typeof import('./topic-cluster');

    const clusters = await tc.buildTopicClusters();

    assert.ok(Array.isArray(clusters), 'clusters should be an array');
    assert.ok(clusters.length > 0, 'should have at least one cluster');

    // ai_1 and ai_2 share 机器学习 and 神经网络 -> same cluster
    const aiCluster = clusters.find(c =>
      c.articleFileNames.includes('ai_1.html') && c.articleFileNames.includes('ai_2.html')
    );
    assert.ok(aiCluster, 'ai_1 and ai_2 should be in the same cluster');
    assert.ok(aiCluster!.topic.length > 0, 'cluster topic should be non-empty');
    assert.ok(aiCluster!.summary.length > 0, 'cluster summary should be non-empty');

    // Verify save/load cycle
    await tc.saveClusters(clusters);
    const loaded = await tc.getClusters();
    assert.strictEqual(loaded.length, clusters.length, 'loaded clusters should match saved count');

    process.env.LLM_API_KEY = origKey;
  });
});

// ── Periodic synthesis file naming ──────────────────────────────────────

describe('periodic-synthesis — file naming', () => {
  const tmpDir = setupTempDir();

  before(() => {
    origCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.SEARCH_DB_PATH = path.join(tmpDir, 'data', 'search.db');

    const now = new Date();
    createArticle(tmpDir, 'test_1.html', 'Test Article',
      '<p>测试文章 人工智能 机器学习</p>');
    createMeta(tmpDir, [
      { fileName: 'test_1.html', title: 'Test Article', author: 'Test', authorHandle: 'test', tweetUrl: '', tweetDate: formatDateStr(now), savedDate: formatDateStr(now), tweetTimestamp: Math.floor(now.getTime() / 1000), savedTimestamp: now.getTime(), contentKey: 'Test Article', sourceType: 'twitter' },
    ]);
    clearRequireCache();
  });

  after(() => {
    process.chdir(origCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('generates correct YYYY-MM-DD filename for daily synthesis', async () => {
    clearRequireCache();
    const ps = require(path.resolve(__dirname, './periodic-synthesis')) as typeof import('./periodic-synthesis');

    const synthesis = await ps.generateDailySynthesis('daily');

    assert.ok(synthesis.id.startsWith('daily-'), 'id should start with daily-');
    assert.strictEqual(synthesis.period, 'daily');
    assert.ok(synthesis.generatedAt > 0, 'generatedAt should be a timestamp');

    const synDir = path.join(tmpDir, 'data', 'syntheses', 'daily');
    assert.ok(fs.existsSync(synDir), 'daily syntheses directory should exist');

    const files = fs.readdirSync(synDir).filter(f => f.endsWith('.json'));
    assert.ok(files.length > 0, 'should have at least one synthesis file');

    for (const fn of files) {
      assert.match(fn, /^\d{4}-\d{2}-\d{2}\.json$/,
        `filename "${fn}" should match YYYY-MM-DD.json format`);
    }
  });

  it('generates correct YYYY-Www weekly filename', async () => {
    clearRequireCache();
    const ps = require(path.resolve(__dirname, './periodic-synthesis')) as typeof import('./periodic-synthesis');

    const synthesis = await ps.generateWeeklySynthesis();

    assert.strictEqual(synthesis.period, 'weekly');
    assert.ok(synthesis.id.startsWith('weekly-'), 'id should start with weekly-');

    const synDir = path.join(tmpDir, 'data', 'syntheses', 'weekly');
    assert.ok(fs.existsSync(synDir), 'weekly syntheses directory should exist');

    const files = fs.readdirSync(synDir).filter(f => f.endsWith('.json'));
    for (const fn of files) {
      assert.match(fn, /^\d{4}-W\d{2}\.json$/,
        `filename "${fn}" should match YYYY-Www.json format`);
    }
  });

  it('generates correct YYYY-MM monthly filename', async () => {
    clearRequireCache();
    const ps = require(path.resolve(__dirname, './periodic-synthesis')) as typeof import('./periodic-synthesis');

    const synthesis = await ps.generateMonthlySynthesis();

    assert.strictEqual(synthesis.period, 'monthly');
    assert.ok(synthesis.id.startsWith('monthly-'), 'id should start with monthly-');

    const synDir = path.join(tmpDir, 'data', 'syntheses', 'monthly');
    assert.ok(fs.existsSync(synDir), 'monthly syntheses directory should exist');

    const files = fs.readdirSync(synDir).filter(f => f.endsWith('.json'));
    for (const fn of files) {
      assert.match(fn, /^\d{4}-\d{2}\.json$/,
        `filename "${fn}" should match YYYY-MM.json format`);
    }
  });
});
