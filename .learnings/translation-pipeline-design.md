# 多遍翻译流水线设计（融合三家 translation skills）

## 背景
需求：知识库非中文文章自动翻译成中文，信达雅、排版不变、术语一致。

## 三家 skill 的精华与落点
- **baoyu-translate**（JimLiu/baoyu-skills）：「重写而非翻译」总原则（验收=读起来像中文母语原创）；refined 模式 分析→初翻→评审→精修；评审清单戒欧式中文（因此/然而/此外连接词、"被"字滥用、名词堆砌、比喻直译）；en-zh 内置术语表 15 条直接搬。
- **translate-book**（~/.claude/skills-backup）：glossary.json 术语机制——抽样建表、按篇只注入命中条目、手编不覆盖、改后单篇重跑。
- **huashu-proofreading**：三遍审校框架 + 降AI味清单（拆首先/其次/总之八股、句长变化、戒"值得注意的是"套话），并入评审 pass。

## 落地方案
- prompts/translate/{draft,critique,revise}.md 三文件（提示词即代码）；评审只诊断不改写，「无问题」跳过硬修；任一步失败回退上一稿。
- 归档时 markdown 层翻译（saveTweet 渲染前，原文 .orig.md）；存量 HTML block 层批量（translate-foreign-articles.ts，.bak-trans，3 并发，断点重跑）。

## 踩过的坑
1. **短段落漏翻**：isNonChinese 设了 nonHan<15 地板，"I made $16,000 last month."(14 字母）、"Not anymore."(10) 被误判不翻——阈值降到 6。
2. **编号标记泄漏**：无编号输入时 LLM 自发给输出加【1】——translateWithPasses 里 stripMarker 统一剥除；批量脚本的标题是从 translateWithPasses 直接拿的，首当其冲。
3. **长批次漏翻**：一次 2500 字符编号批里 LLM 偶尔把个别块原样放回——批量脚本加「译文仍是外文则单独重翻一次」的兜底。
4. **恢复重跑陷阱**：翻译过的文章检测会跳过，重跑前必须先从 .bak-trans 恢复原文。

## 文件
- `prompts/translate/{draft,critique,revise}.md`、`data/glossary.json`
- `src/services/translate.ts`、`renderer.ts`（saveTweet 接入）
- `scripts/translate-foreign-articles.ts`
