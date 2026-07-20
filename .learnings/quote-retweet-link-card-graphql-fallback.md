# Quote/retweet 中的 X Article 链接卡片需要 GraphQL 兜底

## 问题
归档 LEI 的最新推文时，页面只显示评论文字，没有显示被引用的原始推文内容。

## 根因
该推文是 quote tweet，被引用的原始推文是一个 X Article 链接卡片：
- FxTwitter 返回的 `quote.text` 为空
- `raw_text.text` 只有 `https://t.co/...`
- 现有 `expandQuoteOrRetweet` 只在 `q.text` 非空时才展开
- FxTwitter 不暴露 article 内容

## 解决方案
1. 用 X 内部 GraphQL `TweetDetail` 查询（带 `withArticleRichContent: true`）获取 article 卡片信息
2. 处理 `TweetWithVisibilityResults` wrapper：`result.tweet.article` 而不是 `result.article`
3. 当 `content_state.blocks` 为空时，回退到 `preview_text`
4. 在 `expandQuoteOrRetweet` 和 `fetchFromFxTwitter` 中，对 text 为空但 raw_text 含 t.co 的 link-card 调用该 GraphQL 兜底

## 为什么重要
这是 FxTwitter 的常见盲区：只发一个链接的推文（尤其是 X Article）会被识别为空 text。后续再遇到 quote/retweet 这种内容，不会再丢原文。

## 如何应用
新增或修改推文抓取逻辑时：
- 不要只信任 `tweet.text`
- 当 `text` 为空且 `raw_text` 是 t.co 链接时，尝试解析为 article/卡片
- 本地 Docker 容器内可用 `X_AUTH_TOKEN` 调 GraphQL，guest token 已失效

## 文件
- `src/services/fetcher.ts`
