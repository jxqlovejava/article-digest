# Tweet Archive

自动归档 X/Twitter 推文与网页文章到自托管 HTML 的私人知识库：全文+语义搜索、知识管理、自动翻译，可选腾讯云 COS 媒体存储。

只需把一条推文 / 微信文章 / 网页链接发给服务器（网页、curl 或 iOS 快捷指令），系统就会抓取正文与媒体、渲染成离线 HTML 存档，并异步完成翻译与知识标注。

## 功能特性

- **一键归档推文**：抓取正文、图片、视频、作者信息与互动数据，生成离线 HTML 页面；多源抓取自动回退：FxTwitter API → Jina AI → Twitter oEmbed
- **网页 / 微信文章归档**：任意网页链接走 Jina AI + turndown（可选 MarkItDown），微信文章专门解析（含代码块还原、原文链接追溯）
- **媒体本地化**：图片、视频、头像自动下载到本地；支持断点续传与 60s 无活动超时
- **全文 + 语义搜索**：SQLite FTS5 关键词检索 + 384 维向量语义检索（`@xenova/transformers`），中英文混合查询，标题/作者/正文加权
- **自动翻译**：非中文 → 中文，多遍流水线（初翻 → 评审 → 精修），术语表注入，原文备份 `.orig.md`
- **知识管理**：文章知识分类（记忆/概念/流程/设计）、自测题生成、间隔重复复习、跨文章关联、主题聚类、日/周/月综合、三层记忆（L1 痕迹 → L2 整合 → L3 综合）
- **LLM 问答**：基于收藏库的 RAG 问答（SSE 流式输出）、观点提取与关联、推荐问题
- **管理能力**：置顶、已读/未读、删除、X 书签 + 点赞自动同步归档（每 5 分钟轮询）
- **iOS 快捷指令**：分享菜单一键保存（见 `IOS_SHORTCUT_GUIDE.md`）
- **可选腾讯云 COS 图床**：图片/视频上传 COS，HTML 写公网 URL，上传失败自动回退本地

## 系统架构

```
用户 / 浏览器 / iOS 快捷指令
        │  HTTP :3000
        ▼
   nginx（可选反向代理，gzip + SSE 透传）
        │  proxy_pass → app:3000
        ▼
   Express 服务（src/server.ts）
   ├─ POST /api/archive
   │    └─ src/services/fetcher.ts
   │        ├─ 推文:  FxTwitter → Jina AI → oEmbed（逐级回退）
   │        ├─ 微信:  直接抓取 mp.weixin.qq.com
   │        └─ 网页:  Jina AI markdown/html + turndown + MarkItDown
   ├─ src/services/renderer.ts
   │    ├─ 渲染 HTML → data/articles/*.html（原文备份 *.orig.md）
   │    ├─ 下载媒体 → data/images data/videos data/avatars
   │    └─ 可选 → src/services/cos.ts 上传腾讯云 COS 并删本地
   ├─ src/services/translate.ts（LLM 多遍翻译，异步 + 30 分钟补偿扫描）
   ├─ src/services/search.ts（FTS5 + 语义向量 → data/search.db）
   ├─ src/services/knowledge-*（分类/测验/间隔重复/关联/聚类/综合/记忆）
   └─ src/services/llm.ts（DeepSeek，OpenAI 兼容接口，可走代理）

data/                            # 唯一有状态目录（已 gitignore，需备份）
  articles/                      # 归档 HTML 页面 + .orig.md 原文
  images/  videos/  avatars/     # 下载的媒体
  meta.json                      # 文章元数据索引（标题/作者/时间/互动数/置顶/已读）
  blocked.txt                    # 屏蔽的 URL（同步书签时跳过）
  glossary.json                  # 翻译术语表
  search.db                      # SQLite：FTS5 关键词 + 384 维语义向量
  knowledge.db                   # SQLite：跨文章关联、复习任务等
  quizzes/  syntheses/  clusters.json   # 自测题 / 日周月综合 / 主题聚类
  memory/trace  memory/L2  memory/L3    # 三层记忆

public/                          # 静态前端（启动时自动生成/更新 index.html）
  index.html  search.html  qa.html  knowledge.html
```

**COS 媒体流程**：归档时先把图片/视频下载到本地 `data/images`、`data/videos` → 配置了 COS 后 `tryUploadMediaToCos()` 将文件上传到桶（对象标签 `type=image` / `type=video`）→ HTML 写入 COS 公网 URL → 删除本地文件；上传失败自动回退本地相对路径。存量数据可用 `npm run migrate:cos` 迁移（可断点续传，不删本地文件）。

## 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | ≥ 20（推荐 20/22） | 开发依赖 `@types/node@20`，Docker 镜像内为 Node 22 |
| npm | 随 Node | 依赖管理 |
| Docker（可选） | 任意较新版本 | 方式一部署，含 `docker compose` 插件 |
| HTTPS_PROXY（可选） | 例如 mihomo/Clash 于 `127.0.0.1:7890` | 中国大陆访问 X 内容 / 抓图必需 |

> 无任何环境变量时系统也能跑起来（仅抓推文 + 本地存档 + 搜索），翻译 / 问答 / 知识管理 / 书签同步 / COS 属于按功能启用。

## 环境变量配置

创建 `.env`（已被 `.gitignore` 排除，不进版本库）。下表为代码实际读取的全部变量（`src/server.ts`、`src/services/*.ts`、`src/services/cos.ts`、`src/services/translate.ts`、`src/services/llm.ts` 等）。

### 基础

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | 可选 | `3000` | 服务监听端口 |

### 代理（国内网络抓 X 必需）

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `HTTPS_PROXY` / `HTTP_PROXY` | 按需 | 抓取与媒体下载默认 `http://127.0.0.1:7890`，LLM 默认空 | 出网代理地址；Docker 中指向 `http://host.docker.internal:7890` |
| `USE_PROXY` | 按需 | 关闭 | 设为 `1` 或 `true` 才真正启用代理抓取/下载（避免无代理时误连本地 7890） |

> Docker 的 `docker-compose.yml` 已预设 `USE_PROXY=1` + `HTTPS_PROXY=http://host.docker.internal:7890`，需要宿主机跑 mihomo/Clash 且开启 `allow-lan`。

### LLM（翻译 / 问答 / 知识管理 / 观点 的前置条件）

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `LLM_API_KEY` | 启用 LLM 功能时必填 | 空 | DeepSeek API Key（OpenAI 兼容接口） |
| `LLM_BASE_URL` | 可选 | `https://api.deepseek.com` | OpenAI 兼容 Base URL |
| `LLM_MODEL` | 可选 | `deepseek-v4-flash` | 默认 / 短上下文模型 |
| `LLM_MODEL_PRO` | 可选 | `deepseek-v4-pro` | 长上下文 / QA 模型（别名 `LLM_MODEL_QA`） |
| `LLM_PRO_CONTEXT_CHARS` | 可选 | `6000` | 估算 prompt 超过该字符数自动切 Pro 模型 |
| `LLM_TIMEOUT` | 可选 | `90000` | 非流式请求超时（毫秒） |
| `LLM_STREAM_TIMEOUT` | 可选 | `0`（禁用） | 流式请求硬超时；`0` 表示不设总超时（推荐） |
| `LLM_THINKING` | 可选 | 关闭 | `1`/`true`/`enabled` 开启 DeepSeek 思考模式（默认关闭以保 QA 可靠性） |

### X 认证（书签/点赞同步、X Article 渲染、作者评论合并）

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `X_AUTH_TOKEN` | 启用 X 扩展功能时必填 | 空 | 浏览器登录 x.com 后 Cookie 中的 `auth_token` |
| `X_CT0` | 同上 | 空 | Cookie 中的 `ct0`（CSRF token，与 auth_token 配对） |
| `X_USER_ID` | 同步点赞时必填 | 空 | X 用户 ID（GraphQL 拉取点赞列表用） |

### 腾讯云 COS（可选媒体存储）

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `COS_SECRET_ID` | 启用 COS 时必填 | 空 | 腾讯云 SecretId |
| `COS_SECRET_KEY` | 启用 COS 时必填 | 空 | 腾讯云 SecretKey |
| `COS_BUCKET` | 启用 COS 时必填 | 空 | 桶名，如 `articlevideo-1316871392` |
| `COS_REGION` | 启用 COS 时必填 | 空 | 地域，如 `ap-shanghai` |
| `COS_BASE_URL` | 启用 COS 时必填 | 空 | 桶的公网访问域名（公有读私有写） |
| `COS_TAG_VIDEO` | 可选 | `type=video` | 视频对象标签，键须与控制台一致 |
| `COS_TAG_IMAGE` | 可选 | `type=image` | 图片对象标签 |

> 以上 5 项同时配置后 `isCosEnabled()` 才为真；缺任一配置整体降级本地存储。

### 其他可选

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `SEARCH_DB_PATH` | 可选 | `data/search.db` | 搜索库路径覆盖（测试用） |
| `KNOWLEDGE_DB_PATH` | 可选 | `data/knowledge.db` | 知识库路径覆盖（测试用） |
| `MARKITDOWN_PYTHON` / `MARKITDOWN_BIN` | 可选 | `python3` | MarkItDown Python 解释器 |
| `MARKITDOWN_SCRIPT` | 可选 | `scripts/markitdown_html.py` | MarkItDown 脚本路径覆盖 |
| `QA_ARTICLE_CHARS` | 可选 | `1200` | QA 单篇文章最多注入字符数 |
| `QA_HISTORY_TURNS` | 可选 | `4` | QA 最多携带的历史轮数 |
| `QA_HISTORY_CHARS` | 可选 | `600` | QA 单轮历史最多字符数 |
| `QA_MAX_TOKENS` | 可选 | `4096` | QA 回答最大 token（下限 1024） |
| `QA_TOP_K` | 可选 | `5` | RAG 检索 Top-K（1–12） |
| `NODE_ENV` | 可选 | 未设置 | 测试用（`test` 跳过部分日志） |

最小示例 `.env`：

```bash
# LLM（翻译/问答/知识管理）
LLM_API_KEY=sk-xxxx
# 国内网络抓 X
USE_PROXY=1
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
# 可选：X 书签同步
X_AUTH_TOKEN=xxxx
X_CT0=xxxx
X_USER_ID=1234567890
# 可选：腾讯云 COS
COS_SECRET_ID=xxxx
COS_SECRET_KEY=xxxx
COS_BUCKET=articlevideo-1316871392
COS_REGION=ap-shanghai
COS_BASE_URL=https://articlevideo-1316871392.cos.ap-shanghai.myqcloud.com
```

## 部署

### 方式一：Docker（推荐）

> 注意：`docker-compose.yml` 中应用容器带 `profiles`，直接 `docker compose up -d` 只会启动 nginx。请使用 `--profile full`（或 `blue`）。

```bash
# 1. 克隆并进入仓库
git clone <仓库地址> tweet-archive
cd tweet-archive

# 2. 配置环境变量
cp 上面的示例写入 .env

# 3. 构建并启动（含 nginx + 单应用实例）
docker compose --profile full up -d --build

# 4. 健康检查
curl http://localhost:3000/api/health
# => {"status":"ok","time":"..."}
```

不使用 compose 的单容器方式：

```bash
# 先构建基础镜像（依赖 + markitdown，package.json 变更后需重建）
docker build -f Dockerfile.base -t tweet-base:latest .

# 再构建应用镜像
docker build -t tweet-app .

# 运行（data 是唯一有状态目录，务必挂载）
docker run -d --name tweet-app \
  -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  --env-file .env \
  --add-host host.docker.internal:host-gateway \
  tweet-app

# 若宿主机有 mihomo/Clash 代理：
#   -e USE_PROXY=1 -e HTTPS_PROXY=http://host.docker.internal:7890 -e HTTP_PROXY=http://host.docker.internal:7890
```

### 方式二：裸 Node 运行

```bash
git clone <仓库地址> tweet-archive
cd tweet-archive

npm install
npm run build        # tsc 编译 + 拷贝 highlight.js 样式
npm start            # node dist/index.js

# 开发模式（ts-node 热跑）
npm run dev
```

健康检查：

```bash
curl http://localhost:3000/api/health
# => {"status":"ok","time":"2026-...T...Z"}
```

访问 `http://<服务器IP>:3000`。

### （可选）Nginx 反向代理

仓库内的 `nginx.conf` 是给 Docker 蓝绿拓扑用的（`upstream app_backend`）。裸 Node 部署时可套用同一思路：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # SSE（/api/qa/stream）必须关闭缓冲
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

HTTPS 可用 certbot 一键签发；应用已设置 `trust proxy`，反向代理下限流可正常工作。

## 使用

### 归档一条推文

```bash
curl -X POST http://localhost:3000/api/archive \
  -H "Content-Type: application/json" \
  -d '{"url":"https://twitter.com/username/status/1234567890"}'
```

支持三种输入，自动识别：

- `https://x.com/xxx/status/123` / `https://twitter.com/...` → 推文（多源回退抓取）
- `https://mp.weixin.qq.com/...` → 微信文章
- 其他任意 URL → 网页文章（Jina AI + turndown）

保存成功返回 `{ success, fileName, tweet }`；同一条推文内容未变化时返回 `{ success, skipped: true }` 跳过。

### Web UI

| 页面 | 地址 | 说明 |
|------|------|------|
| 首页 | `http://<host>:3000/` | 归档列表（按时间倒序、置顶优先、分页加载） |
| 搜索 | `http://<host>:3000/search` | 全文 + 语义搜索 |
| 问答 | `http://<host>:3000/qa` | 基于收藏库的 RAG 问答 |
| 知识 | `http://<host>:3000/knowledge` | 分类/测验/复习/聚类/记忆 |
| 文章 | `http://<host>:3000/articles/<file>.html` | 单篇归档页（访问自动标记已读） |

### iOS 快捷指令

完整图文步骤见 **[`IOS_SHORTCUT_GUIDE.md`](IOS_SHORTCUT_GUIDE.md)**。要点：新建快捷指令「保存推文」→ 添加「获取 URL 内容」→ 方法 POST → URL 填 `http://你的服务器:3000/api/archive` → 请求体 JSON `{"url":"快捷指令输入 URL"}` → 打开「在共享表单中显示」，之后在 X App 分享菜单一键归档。

### API 端点

| 端点 | 方法 | 请求体 / 参数 | 说明 |
|------|------|---------------|------|
| `/api/archive` | POST | `{url}` | 归档推文 / 微信文章 / 网页 |
| `/api/health` | GET | - | 健康检查 |
| `/api/articles` | GET | `?offset&limit`（默认 60/页，上限 200） | 分页文章列表 |
| `/api/search` | GET | `?q=`（≥2 字符） | 全文 + 语义搜索（限流 30 次/分钟） |
| `/api/search/keywords` | GET | - | 搜索建议关键词 |
| `/api/pin` | POST | `{id, pin}` | 置顶 / 取消置顶 |
| `/api/read` | POST | `{id}` | 标记已读 |
| `/api/unread` | POST | `{id}` | 标记未读 |
| `/api/delete` | POST | `{id}` | 删除文章 |
| `/api/sync-bookmarks` | POST | - | 手动同步 X 书签 + 点赞并自动归档（需 X 认证） |
| `/api/opinions/extract` | POST | `{fileName}` | 提取单篇观点（需 LLM） |
| `/api/opinions/extract-all` | POST | - | 批量提取观点（需 LLM） |
| `/api/opinions` | GET | `?fileName` | 查看观点 |
| `/api/opinions/link` | POST | - | 观点跨文章关联（需 LLM） |
| `/api/qa` | POST | `{question, contextArticle?, history?}` | RAG 问答（需 LLM） |
| `/api/qa/stream` | POST | 同上 | SSE 流式问答 |
| `/api/qa/suggestions` | GET | `?context` | 推荐问题 |
| `/api/qa/suggestions/use` | POST | `{context?, count?}` | 消费推荐问题 |
| `/api/knowledge/classify` | GET | `?fileName` | 单篇知识分类标注（需 LLM） |
| `/api/knowledge/classify-all` | POST | - | 全库分类标注（需 LLM） |
| `/api/knowledge/quiz` | GET | `?fileName` | 获取自测题 |
| `/api/knowledge/quiz/generate` | POST | `{fileName}` | 生成本文自测题（需 LLM） |
| `/api/knowledge/reviews/due` | GET | - | 到期复习任务 |
| `/api/knowledge/reviews/grade` | POST | `{questionId, answer}` | 提交复习作答（SM-2 调度） |
| `/api/knowledge/reviews/stats` | GET | - | 复习统计 |
| `/api/knowledge/links` | GET | `?fileName` | 跨文章关联 |
| `/api/knowledge/links/discover` | POST | `{fileName?}` | 发现关联（缺省全库，需 LLM） |
| `/api/knowledge/clusters` | GET | - | 主题聚类列表 |
| `/api/knowledge/clusters/rebuild` | POST | - | 重建聚类（需 LLM） |
| `/api/knowledge/synthesis/latest` | GET | - | 最近的日/周/月综合 |
| `/api/knowledge/synthesis/generate` | POST | `{period}`（daily/weekly/monthly） | 生成综合（需 LLM） |
| `/api/knowledge/memory/overview` | GET | - | 记忆总览 |
| `/api/knowledge/memory/L2` | GET | `?surface` | 读取 L2 整合文档 |
| `/api/knowledge/memory/consolidate` | POST | `{surface}` | 触发 L2 整合（需 LLM） |
| `/api/knowledge/memory/L3` | GET | `?slot` | 读取 L3 综合文档 |

静态资源：`/articles/*.html`、`/images/*`、`/avatars/*`、`/videos/*`。

## 可选功能

### 1. 自动翻译（非中文 → 中文）

- 前置：`LLM_API_KEY`。新文章保存后**异步**翻译（不阻塞归档响应），原文先备份为 `data/articles/<base>.orig.md`
- 多遍流水线：初翻（draft）→ 评审（critique，只诊断）→ 精修（revise）；评审判定「无问题」则跳过精修；任一步失败自动回退上一稿
- 术语表 `data/glossary.json`：命中术语注入翻译 prompt（手编条目不会被覆盖）
- 补偿扫描：启动后 60s + 每 30 分钟扫描漏翻文章自动补翻
- Prompt 即代码：`prompts/translate/*.md`，改动后重跑即生效
- 存量翻译：`npm run translate:foreign`（HTML block 层翻译，可断点重跑，3 并发）；西班牙语存量 `npm run translate:es`
- 连续 3 批 LLM 失败（如欠费 402）会提前退出并保留原文

### 2. 作者评论区内容合并

- 前置：`X_AUTH_TOKEN` + `LLM_API_KEY`
- 主推文正文「明显未完结」（引子 / 预告 / 列 N 条只写了部分）时，自动抓取作者在评论区的自回帖并入正文，合成一篇完整文章
- 抓取走已认证 GraphQL 会话线程；每条自回帖再用 FxTwitter 单推接口补齐被截断的完整文本；LLM 过滤闲聊 / 广告后合并
- 任一步失败（无 Cookie / LLM 不可用 / 抓取失败）**降级返回原推文，绝不阻塞归档**

### 3. 腾讯云 COS 媒体存储

- 前置：5 个 `COS_*` 必填变量全部配置
- 新归档：媒体下载到本地 → 上传 COS（对象标签 `type=image`/`type=video`）→ HTML 写公网 URL → 删本地；上传失败自动回退本地
- 存量迁移：`npm run migrate:cos`（断点续传，已存在跳过；不删本地文件，确认无误后自行清理 `data/videos/*`、`data/images/*`）
- 视频修复：`npm run repair:videos`（修复曾回退为 `video.twimg.com` 外链的文章）
- 桶权限建议：公有读私有写；上传走内网时地域与 CVM 同区可免流量费

## 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| 推文抓取 / 图片下载失败 | 国内网络无法直连 X、pbs.twimg.com | 设置 `USE_PROXY=1` + `HTTPS_PROXY`；Docker 默认走 `host.docker.internal:7890`，需宿主机 mihomo/Clash 开 `allow-lan` |
| 翻译不生效 | 未配 `LLM_API_KEY`；或内容本就是中文（`isNonChinese` 判定）；或 LLM 连续失败 | 检查 `.env` 并重启；短文本（<6 个非汉字）不翻属预期 |
| 问答 / 知识管理提示 `LLM not configured` | 缺少 `LLM_API_KEY` | 配置后重启；确认能访问 `LLM_BASE_URL`（必要时走代理） |
| 端口 3000 被占用 | 其他进程占用 | 改 `PORT` 环境变量，或改 compose/`docker run` 的端口映射如 `3001:3000` |
| `docker compose up -d` 后访问不到应用 | 应用容器带 `profiles`，默认只启动了 nginx | 用 `docker compose --profile full up -d --build` |
| 书签同步不工作 | 缺 `X_AUTH_TOKEN`/`X_CT0`（点赞还需 `X_USER_ID`），或 Cookie 过期 | 浏览器登录 x.com 后重新复制 Cookie，重启服务 |
| COS 图片/视频 404 | 桶不是公有读；`COS_BASE_URL` 填错；对象标签键与控制台不一致 | 检查桶 ACL（公有读私有写）、域名与地域、`COS_TAG_*` 键名 |
| 搜索不到刚归档的文章 | 索引未更新 / FTS 索引异常 | 手动触发 `npm run migrate:search` 重建索引；确认 `data/search.db` 可写 |
| 视频下载一半失败 / 链接是 video.twimg.com | 网络中断或历史遗留 | 重跑 `npm run repair:videos`（支持 Range 断点续传 + 60s 超时） |
| 归档返回 `All fetch methods failed` | FxTwitter、Jina AI、oEmbed 全部失败 | 检查出网与代理；Jina AI 在国内不通，必须走代理 |
| LLM 流式回答中途断开 / 空回答 | 代理掐断长 SSE 连接 | 保持 `LLM_STREAM_TIMEOUT=0`（不设总超时）；确认代理稳定；或设 `LLM_THINKING` 关闭思考 |

## 数据与备份

- 唯一有状态目录是 `data/`（gitignore），备份它即可；`public/index.html` 会在每次启动 `rebuildIndex()` 时自动重建
- 常用脚本：`npm run build`（编译）、`npm start`（运行）、`npm run dev`（开发）、`npm test`（单元测试）
- 反向代理场景应用已设 `trust proxy`，限流（搜索 30 次/分钟）正常工作

## 相关文档

- [`IOS_SHORTCUT_GUIDE.md`](IOS_SHORTCUT_GUIDE.md) — iOS 快捷指令完整配置
- `prompts/translate/` — 翻译流水线 prompt（draft / critique / revise）
- `prompts/comments/` — 作者评论合并 prompt
