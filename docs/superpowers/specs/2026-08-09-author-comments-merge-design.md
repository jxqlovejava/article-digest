# 作者评论区内容合并 — 设计文档

日期：2026-08-09
状态：已批准

## 背景

X 上常见「作者把文章正文放在评论区」的写法：主推文只有标题/引子，正文拆成多条自回帖放在评论区（例：`17年炒股心得：从16w到417w，死记这10条铁律！`，正文在评论里）。

现状：`fetchTweet()` 主路径（FxTwitter）只返回主推文正文 + article，**不抓评论**，导致这类推文归档后只有引子，正文丢失。

目标：新归档时自动识别「正文明显未完结」的推文，抓取作者本人的评论并合并进正文，合成一篇文章。

## 范围

- **新归档主流程**：`fetchTweet()` 自动合并作者评论区（核心）。
- **单篇实测**：对 `17年炒股心得` 那篇做一次验证。
- **不做**全量历史回填脚本。

## 架构与数据流

```
fetchTweet()
  └─ fetchFromFxTwitter() → tweet（正文 + article）
      └─ [新增] maybeMergeAuthorComments(tweet)
            ├─ ① 前置：未配置 X_AUTH_TOKEN → 跳过
            ├─ ② AI 完整性判断：LLM 读正文 → 是否「明显未完结」
            │    prompts/comments/detect-incomplete.md（提示词即代码）
            ├─ ③ 未完结 → fetchAuthorSelfReplies() 抓作者自回帖
            │    走已认证 GraphQL TweetDetail 端点（fetcher 已在用）
            │    过滤：作者本人（screen_name 比对）+ 文本长度 ≥ 15
            │    分页：bounded（最多 3 页，无 bottom cursor 即停）
            ├─ ④ LLM 过滤：只保留「文章正文延续」评论,丢闲聊/广告
            │    prompts/comments/filter-replies.md
            ├─ ⑤ 合并：正文尾部追加 + 评论媒体 [IMG:N]/[VIDEO:N] 重索引
            └─ ⑥ 任一失败 → 原样返回，绝不阻塞归档
```

## 组件

### 1. `prompts/comments/detect-incomplete.md`（新增）

LLM 完整性判断提示词。输入主推文正文，输出结构化结论：正文是否「明显未完结」。

触发判断的信号（提示词内定义）：
- 标题/开头宣示了内容量（如「10条铁律」）但正文只给了部分
- 结尾是明显的预告/续写信号（「评论区见」「接着说」「接下来说第 N 条」）
- 正文在句子/列表中途戛然而止
- 正文只是标题党引子

要求：**保守触发**——只有「明显未完结」才判定需要抓评论，避免为完整短推文付 GraphQL 抓取成本。

### 2. `src/services/fetcher.ts`（修改）

新增两个函数：

- `maybeMergeAuthorComments(tweet: FetchedTweet): Promise<FetchedTweet>`
  - 前置条件：`X_AUTH_TOKEN` 存在 且 LLM 可用，否则直接返回原 tweet
  - 调完整性判断；判定「未完结」才进入抓取
  - 组装合并结果，失败 catch 后返回原 tweet

- `fetchAuthorSelfReplies(tweetId, authorScreenName): Promise<FetchedTweet[]>`
  - 复用现有 GraphQL headers / `TweetDetail` 端点（`iFEr5AcP121Og4wx9Yqo3w/TweetDetail`）
  - 遍历 `instructions → entries`，提取 tweet（镜像 `fetchArticleViaGraphQL` 的解析方式）
  - 过滤：`legacy.screen_name === authorScreenName` 且 `in_reply_to_screen_name === authorScreenName`（自回帖链）
  - 从 entryId `tweet-*` / `conversationthread-*` 提取；媒体解析走现有 `parseArticleContent`/media 逻辑
  - bounded 分页（cursor），最多 3 页
  - 按时间升序返回

### 3. 媒体合并（修改）

评论中的 `[IMG:N]`/`[VIDEO:N]` 需要重索引到合并后的主媒体数组。现有 `renderer.mergeEmbeddedArticle` 已有此逻辑（`renderer.ts:3064`），镜像其逻辑到 fetcher 的 `mergeAuthorReplies`，供评论合并复用（新增图片去重追加 + 重索引）。

### 3b. 评论内容过滤（实现中新增）

作者自回帖里可能混入推广/闲聊（如 `我正在写一本《搞钱秘籍》…私聊我`）。新增第二个 LLM pass：

- `prompts/comments/filter-replies.md` — 把每条评论标注为「文章正文延续」vs「闲聊/广告」，输出 `keep/drop` 条目标记
- 硬过滤在前：文本长度 < 15 的直接丢弃（`收到`/纯 emoji）
- LLM 判定异常时**保守全保留**（宁可多保留正文不丢内容）
- 坑：LLM 会把条目标记返回成字符串 `"[1]"` 而非数字 `1`——`toIndex` 统一剥掉 `[]` 再解析，否则过滤会清空全部（已在 `2026-08-09` 踩坑）

### 4. `fetchTweet()` 接入（修改）

FxTwitter 成功路径返回前调用 `maybeMergeAuthorComments(tweet)`。

## 合并格式

```
<正文>

---

**作者在评论区的补充**

> 评论 1 文本

> 评论 2 文本
```

- blockquote（`>`）由现有 marked 渲染，视觉上区分评论区。
- 合并发生在 `saveTweet` 之前 → `.orig.md` 备份、翻译、搜索索引、观点抽取自动包含合并内容。

## 错误处理与降级

| 情形 | 行为 |
|---|---|
| 无 `X_AUTH_TOKEN` | 跳过评论合并，归档正常 |
| LLM 未启用/判断失败 | 跳过评论合并（保守，不因判断失败硬抓） |
| GraphQL 抓取失败 | warn，返回原 tweet |
| 无作者自回帖 | 返回原 tweet |
| 评论媒体下载失败 | 走现有媒体下载的 best-effort 逻辑，不阻塞 |

## 验收

1. `npm run build` 通过。
2. 用「17年炒股心得」推文 URL 实测：正文未完结 → 自动合并作者评论 → 生成的 HTML 含「作者在评论区的补充」区块，媒体正常。
3. 用一篇完结的普通推文回归：不触发抓取，正文不变。
4. 部署后服务器 `grep` 确认改动同步 + `curl` 200。
