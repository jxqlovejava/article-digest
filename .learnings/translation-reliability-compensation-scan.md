# 保存英文文章没翻译——异步翻译失败静默 + 缺补偿机制

## 问题
用户保存英文文章（如 "I built a penguin sledding game with DeepSeek V4 Flash 0731…"），正文和标题一直没翻译成中文。手动跑 `npm run translate:foreign` 却能成功翻译。

## 根因
新文章保存后走**异步翻译**（server.ts `translateArticleContent(fileName).catch(...)`，fire-and-forget）。这条链路有多个可靠性缺陷叠加：

1. **`translateMarkdown` 误报 `translated: true`**：单批翻译失败时 `consecutiveFails=1 < 3` 不触发提前退出，最后无条件 `return { translated: true }`。调用方 `translateArticleContent` 靠 `if (!out.translated) continue` 判断，永远不跳过 → **LLM/代理瞬时失败被静默吞掉，正文保持原文**。
2. **fire-and-forget 无重试、无补偿**：异步翻译一旦失败（代理抖动/限流/LLM 输出漂移），没有重试、没有后续扫描兜底，文章永远停留英文，且无告警无可见性。
3. 服务器上 12 篇英文文章（07/27~08/07 保存）全部因此漏翻。

## 解决方案
三层修复（治本）：

1. **`translate.ts` 修正 `translated` 语义**：`anyTranslated` 标志 —— 仅当至少一批真正产出译文才返回 `translated: true`；全失败返回 `false`，调用方据此跳过/重试。
2. **`translateArticleContent` 批次失败重试**：编号译文解析后统计"有实际变化的文段数"，为 0（LLM 失败或编号漂移）→ 重试一次。
3. **补偿扫描 `scanUntranslatedArticles()` + 定时调度**（治本兜底）：遍历有 `.orig.md`（原为外文）但正文仍为外文的文章，逐个调 `translateArticleContent` 补翻。server.ts 启动延迟 60s + 每 30 分钟定时跑，3 并发、防重入、失败不影响其他文章。**即使保存时异步翻译失败，也会被后续扫描自动补上。**

## 为什么重要
fire-and-forget 的后台任务必须配套"失败可见 + 自动补偿"，否则瞬时失败就是永久静默失败。翻译这类跨多次 LLM 调用的管线尤其脆弱——单次失败不该让整篇永久漏翻。

## 如何应用
- 新增 `translated: true` 语义是"至少一批真翻译了"，改动 translateMarkdown 返回逻辑时注意调用方兼容。
- 判断文章是否翻译用 `isArticleUntranslated`（isNonChinese 口径），别用 `han<latin*0.05` 之类的经验阈值（会把"中文为主+英文术语"误判为未翻译）。
- 部署后 app 容器启动 60s 内会自动跑一次补偿扫描，日志 `[comp-scan]` 可见。

## 文件
- `src/services/translate.ts`（translated 语义修复）
- `src/services/renderer.ts`（translateArticleContent 重试 + scanUntranslatedArticles/isArticleUntranslated）
- `src/server.ts`（补偿扫描定时调度）
