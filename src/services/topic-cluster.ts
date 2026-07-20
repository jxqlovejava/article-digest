import fs from 'fs';
import path from 'path';
import type { TopicCluster } from '../types/knowledge';
import { loadMeta, getArticlesDir } from './renderer';
import { chatWithJson, isLlmEnabled, ChatMessage } from './llm';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CLUSTERS_FILE = path.join(DATA_DIR, 'clusters.json');

// ── Topic extraction helpers (shared with synthesis.ts pattern) ─────────

const CHINESE_STOP_WORDS = new Set([
  '一个', '这个', '那个', '这些', '那些', '什么', '怎么', '如何',
  '可以', '没有', '不是', '就是', '但是', '而且', '因为', '所以',
  '如果', '虽然', '然后', '之后', '同时', '还有', '已经', '以及',
  '或者', '那么', '这样', '那样', '这里', '那里', '每个', '所有',
  '我们', '他们', '它们', '你们', '自己', '别人', '其他',
  '其中', '之一', '一些', '很多', '大量', '部分', '整个',
  '这种', '那种', '通过', '进行', '利用', '使用', '需要', '能够',
  '应该', '可能', '不会', '不断', '开始', '成为', '进入', '出现',
  '目前', '当前', '未来', '过去', '之前', '之后', '期间', '时候',
  '问题', '情况', '方面', '方式', '方法', '过程', '结果', '影响',
  '信息', '数据', '内容', '领域', '行业', '市场', '经济', '社会',
  '发展', '变化', '趋势', '管理', '技术', '系统', '产品', '服务',
]);

const ENGLISH_STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'not', 'but', 'had', 'has', 'was', 'all',
  'can', 'any', 'its', 'our', 'who', 'see', 'use', 'may', 'via', 'how',
  'get', 'set', 'say', 'one', 'two', 'new', 'now', 'yet', 'also', 'just',
  'than', 'that', 'this', 'with', 'from', 'they', 'have', 'been', 'were',
  'more', 'some', 'what', 'when', 'where', 'which', 'their', 'them',
  'into', 'over', 'such', 'each', 'about', 'would', 'could', 'should',
  'other', 'after', 'then', 'than', 'many', 'these', 'those',
]);

function extractPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTopics(text: string, maxTopics = 15): string[] {
  const cnPhrases: string[] = [];
  const cnMatches = text.match(/[一-鿿]{2,}/g) || [];
  for (const phrase of cnMatches) {
    const trimmed = phrase.trim();
    if (trimmed.length >= 2 && !CHINESE_STOP_WORDS.has(trimmed)) {
      cnPhrases.push(trimmed);
    }
  }

  const enWords: string[] = [];
  const enMatches = text.match(/[a-zA-Z]{3,}/g) || [];
  for (const word of enMatches) {
    const lower = word.toLowerCase();
    if (!ENGLISH_STOP_WORDS.has(lower)) {
      enWords.push(lower);
    }
  }

  const freq = new Map<string, number>();
  for (const p of cnPhrases) freq.set(p, (freq.get(p) || 0) + 1);
  for (const w of enWords) freq.set(w, (freq.get(w) || 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    })
    .slice(0, maxTopics)
    .map(([term]) => term);
}

function readArticleText(fileName: string): string {
  const articlesDir = getArticlesDir();
  const htmlPath = path.join(articlesDir, fileName);
  if (!fs.existsSync(htmlPath)) return '';
  try {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    return extractPlainText(html);
  } catch {
    return '';
  }
}

interface ArticleTopics {
  fileName: string;
  title: string;
  topics: string[];
}

function loadAllArticleTopics(): ArticleTopics[] {
  const meta = loadMeta();
  // Filter to only articles that have a corresponding HTML file
  return meta
    .filter(m => {
      const articlesDir = getArticlesDir();
      return fs.existsSync(path.join(articlesDir, m.fileName));
    })
    .map(m => {
      const text = readArticleText(m.fileName);
      return {
        fileName: m.fileName,
        title: m.title || m.fileName,
        topics: extractTopics(text),
      };
    });
}

// ── Clustering algorithm ────────────────────────────────────────────────

/**
 * Build co-occurrence graph: articles share an edge if >= 2 common topics.
 * Connected components = clusters.
 */
function buildClustersFallback(articles: ArticleTopics[]): TopicCluster[] {
  const now = Date.now();

  // Build adjacency: article index -> set of connected article indices
  const n = articles.length;
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set());

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const shared = articles[i].topics.filter(t => articles[j].topics.includes(t));
      if (shared.length >= 2) {
        adj[i].add(j);
        adj[j].add(i);
      }
    }
  }

  // Find connected components (BFS)
  const visited = new Set<number>();
  const clusters: TopicCluster[] = [];

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;

    const component: number[] = [];
    const queue = [i];
    visited.add(i);

    while (queue.length > 0) {
      const idx = queue.shift()!;
      component.push(idx);
      for (const neighbor of adj[idx]) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    // Build cluster from component
    const articleFileNames = component.map(idx => articles[idx].fileName);
    const componentArticles = component.map(idx => articles[idx]);

    // Collect all topics across articles
    const allTopics = new Map<string, number>();
    for (const a of componentArticles) {
      for (const t of a.topics) {
        allTopics.set(t, (allTopics.get(t) || 0) + 1);
      }
    }

    // Topic with highest frequency becomes the cluster topic
    const sortedTopics = [...allTopics.entries()].sort((a, b) => b[1] - a[1]);
    const topic = sortedTopics.length > 0 ? sortedTopics[0][0] : '未分类';

    // Generate summary by concatenating titles + first 200 chars
    const summary = componentArticles
      .map(a => {
        const text = readArticleText(a.fileName);
        return `${a.title}：${text.substring(0, 200)}`;
      })
      .join('\n\n');

    clusters.push({
      topic,
      articleFileNames,
      summary: summary.substring(0, 2000),
      agreements: [],
      disagreements: [],
      generatedAt: now,
    });
  }

  // If no clusters found, each article is its own cluster
  if (clusters.length === 0) {
    for (const a of articles) {
      clusters.push({
        topic: a.topics[0] || '未分类',
        articleFileNames: [a.fileName],
        summary: a.title,
        agreements: [],
        disagreements: [],
        generatedAt: now,
      });
    }
  }

  return clusters;
}

// ── LLM-based clustering ────────────────────────────────────────────────

interface ClusterResult {
  clusters: Array<{
    topic: string;
    summaries: string[];
    agreements: string[];
    disagreements: string[];
  }>;
}

async function buildClustersWithLlm(articles: ArticleTopics[]): Promise<TopicCluster[]> {
  const now = Date.now();
  const BATCH_SIZE = 20;

  // Process articles in batches to keep LLM JSON responses manageable
  const allClusters: TopicCluster[] = [];
  for (let offset = 0; offset < articles.length; offset += BATCH_SIZE) {
    const batch = articles.slice(offset, offset + BATCH_SIZE);
    const articleList = batch
      .map(a => `- ${a.title} (${a.fileName})\n  主题: ${a.topics.join(', ')}`)
      .join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are a topic clustering assistant. Group the following articles by shared topics.

For each cluster, provide:
- topic: A concise name for the cluster
- summaries: Key takeaways from each article in this cluster
- agreements: Key agreements across articles
- disagreements: Key disagreements or tensions

Return ONLY valid JSON, no extra text: {"clusters": [{"topic": "...", "summaries": ["..."], "agreements": ["..."], "disagreements": ["..."]}]}

Rules:
- Articles can only belong to ONE cluster
- If an article doesn't fit any cluster, omit it
- Keep topics concise (2-5 words)
- Be specific about agreements and disagreements
- Make sure JSON is properly closed and valid`,
      },
      {
        role: 'user',
        content: articleList,
      },
    ];

    try {
      const result = await chatWithJson<ClusterResult>(messages, { temperature: 0.2 });
      for (const c of result.clusters || []) {
        const articleFileNames: string[] = [];
        for (const s of c.summaries || []) {
          for (const a of batch) {
            if (s.includes(a.title) && !articleFileNames.includes(a.fileName)) {
              articleFileNames.push(a.fileName);
            }
          }
        }
        allClusters.push({
          topic: c.topic || '未分类',
          articleFileNames,
          summary: (c.summaries || []).join('\n'),
          agreements: c.agreements || [],
          disagreements: c.disagreements || [],
          generatedAt: now,
        });
      }
    } catch (err) {
      console.error('[topic-cluster] LLM batch error:', err instanceof Error ? err.message : err);
    }
  }

  // Merge clusters with the same topic name across batches
  const merged = new Map<string, TopicCluster>();
  for (const c of allClusters) {
    const key = c.topic.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.articleFileNames = [...new Set([...existing.articleFileNames, ...c.articleFileNames])];
      existing.summary = existing.summary + '\n' + c.summary;
      existing.agreements = [...new Set([...existing.agreements, ...c.agreements])];
      existing.disagreements = [...new Set([...existing.disagreements, ...c.disagreements])];
    } else {
      merged.set(key, { ...c });
    }
  }

  return [...merged.values()];
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Build topic clusters by grouping articles with shared topics.
 * Uses LLM when available, otherwise falls back to co-occurrence graph.
 */
export async function buildTopicClusters(): Promise<TopicCluster[]> {
  const articles = loadAllArticleTopics();
  if (articles.length === 0) return [];

  // Filter out articles with no topics
  const nonEmpty = articles.filter(a => a.topics.length > 0);
  if (nonEmpty.length === 0) return [];

  let clusters: TopicCluster[];

  if (isLlmEnabled()) {
    clusters = await buildClustersWithLlm(nonEmpty);
  } else {
    clusters = buildClustersFallback(nonEmpty);
  }

  // Only keep clusters with ≥3 articles — fewer isn't meaningful
  clusters = clusters.filter(c => (c.articleFileNames || []).length >= 3);

  await saveClusters(clusters);
  return clusters;
}

/**
 * Read cached clusters from data/clusters.json.
 */
export async function getClusters(): Promise<TopicCluster[]> {
  try {
    if (!fs.existsSync(CLUSTERS_FILE)) return [];
    const raw = fs.readFileSync(CLUSTERS_FILE, 'utf-8');
    return JSON.parse(raw) as TopicCluster[];
  } catch (err) {
    console.error('[topic-cluster] Error reading clusters:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Save clusters to data/clusters.json.
 */
export async function saveClusters(clusters: TopicCluster[]): Promise<void> {
  fs.mkdirSync(path.dirname(CLUSTERS_FILE), { recursive: true });
  fs.writeFileSync(CLUSTERS_FILE, JSON.stringify(clusters, null, 2), 'utf-8');
}
