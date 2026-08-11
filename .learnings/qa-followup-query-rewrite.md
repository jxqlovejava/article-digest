# RAG 问答追问失败——检索没用对话历史

## 问题
知识问答(/qa)追问时,明明是同主题追问,AI 却回答"知识库未找到相关收藏"。

## 根因
`synthesize.ts` 的 `retrieveTopArticles(question)` 检索只用**当前这句原始问题**。追问句("它的章节结构是怎么安排的?")没有主题关键词 → FTS 0 命中 → `buildQaUserMessage` 走"未找到"分支 → 模型按系统提示只能说没有。history 虽然传给了 LLM 消息列表,但**检索环节完全没用**。

## 解决方案
检索前加 `rewriteQueryForRetrieval()`:有历史且问题像追问(短或含 这/那/它/上面/前面/继续 等指代词)时,用便宜模型 0 温度把追问改写成独立问题("它"→实际主题),**改写结果只用于检索**;最终回答仍用原问题+历史。改写失败/过短回退原句。answerQuestion 和 answerQuestionStream 两处都接。

## 为什么重要
RAG 多轮对话的通用陷阱:指代消解必须在**检索前**做,不是把历史塞进生成 prompt 就够。检索 query 和生成 query 是两回事。

## 如何应用
改任何检索逻辑时记住:retrieval query ≠ user query。有对话历史存在时,先判断是否需要 rewrite(指代词启发式),rewrite 用便宜模型+低 maxTokens,别让它进入生成路径。

## 文件
- `src/services/synthesize.ts`(rewriteQueryForRetrieval + 两处接入)
