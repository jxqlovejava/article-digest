# 作者评论区内容合并 — 实现踩坑记录

需求：主推文正文「明显未完结」（作者把内容放评论区）时，抓作者自回帖并入正文，合成一篇。

## GraphQL TweetDetail 回复结构（关键，全是实测确认的）

- **会话线程**：`threaded_conversation_with_injections_v2.instructions[]`，回复在 `TimelineTimelineModule` 的 `content.items[]` 里（**不是** `itemContent.tweet_results`，那是焦点推文/单条推文的路径）。每条 item 取 `it.item.itemContent.tweet_results.result`，可能有 `.tweet` 包装。
- **作者 screen_name 不在 legacy 里**！`user_results.result.legacy` 没有 `screen_name`。正确路径：`t.core.user_results.result.core.screen_name`。（现有 `fetchArticleViaGraphQL` 用的 `legacy.screen_name` 路径实际是 undefined——历史遗留，未在本次修。）
- **过滤作者**：`t.core.user_results.result.rest_id` 与焦点推文作者的 rest_id 比对（从同一响应 `tweet-<id>` 条目取）；或用 `core.screen_name` 字符串比对。
- **分页**：bottom cursor 在 `entry.entryId.includes('cursor-bottom')` 的 `content.operation.cursor.value`。**本文案例无 bottom cursor**（单页完整），但代码仍做 bounded ≤3 页兜底。cursor 可能为空 → 立即停。

## LLM 过滤的坑（本次真实踩到）

`filterArticleReplies` 让 LLM 返回 `keep: [N]` 条目标记。LLM 会把标签回显成**字符串** `"[1]"` 而非数字 `1`：
```
filter raw: {"keep":["[1]","[2]","[3]"],"drop":["[4]"]}
```
`parseInt("[1]")` → NaN → `keepSet={NaN}` → 过滤出**空数组** → 整条合并静默丢失。
修复：`toIndex` 剥掉 `[^\d-]` 再 parseInt，兼容数字与字符串；解析失败时保守全保留。

## 数据源 quirk（重要教训）

作者某条自回帖原文「❼」后没内容——**以为是数据源问题，其实是 GraphQL `full_text` 截断**！
- GraphQL `TweetDetail` 的 `legacy.full_text` 把那条回复**截断在序号"❼"处**，丢了规则正文。
- 同一推文用 **FxTwitter** 单推接口返回完整文本：`❼ 早上大跌别急着割，下午往往有反包…`。
- 教训：**不能只信 GraphQL 的 full_text**。修复：每条自回帖再用 FxTwitter 取完整文本，取更长者（`fetchReplyFullText`，并行 Promise.all）。

## 合并格式与渲染

- **v2（最终）**：直接拼进正文，`\n\n` 分隔，无标题、无 `---`、无 blockquote——读起来像一篇连续文章。
- v1 曾用 `---` + `**作者在评论区的补充**` + 每条 `> blockquote`（每行前缀 `> `），用户反馈不要这种展示。
- 评论媒体 `[IMG:N]`/`[VIDEO:N]` 重索引进主媒体数组——renderer 在 markdown 转换**前**就把 `[IMG:N]`→`<!--IMG:N-->`，媒体标记在任意位置都能正常渲染。
- 合并发生在 `saveTweet` 前，`.orig.md` 备份/翻译/搜索索引/观点抽取自动包含。

## 文件
- `src/services/fetcher.ts`：`maybeMergeAuthorComments` / `fetchAuthorSelfReplies` / `filterArticleReplies` / `mergeAuthorReplies`
- `prompts/comments/detect-incomplete.md`、`prompts/comments/filter-replies.md`
- 设计文档 `docs/superpowers/specs/2026-08-09-author-comments-merge-design.md`
