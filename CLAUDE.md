# tweet-disgest

X/Twitter 推文收藏归档服务。通过 FxTwitter API + Jina AI 抓取推文内容，生成自托管 HTML 页面。

## 部署

- **服务器**: ubuntu@124.220.236.129
- **SSH 密钥**: ~/Documents/hermes.pem
- **部署方式**: Docker Compose（node:20-alpine）
- **端口**: 3000
- **代理**: mihomo `allow-lan: true`，Docker 通过 `host.docker.internal:7890` 访问
- **镜像源**: `https://docker.1panel.live`（Docker Hub 国内不通）

### 架构

```
用户 → nginx(:3000, tweet-nginx) → tweet-app(:3000)
                                     └→ 视频/图片: 下载→上传腾讯云 COS→删本地, HTML 写 COS URL
```

docker-compose 管理双容器：nginx（反向代理 + gzip）→ app（Express）。同一网络，nginx 重启 < 1s，app 重启 < 3s。

### 腾讯云 COS（视频/图床）

- **桶**: `articlevideo-1316871392`，地域 `ap-shanghai`（与 CVM 同地域，上传走内网免费）
- **权限**: 公有读私有写；对象标签 `type=video` / `type=image`
- **封装**: `src/services/cos.ts`（`isCosEnabled()` 未配置时整体降级本地存储）
- **环境变量**（服务器 `.env`，不进 git）: `COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION/COS_BASE_URL/COS_TAG_VIDEO/COS_TAG_IMAGE`
- **保存流程**: 下载到本地 → `tryUploadMediaToCos()` 上传并删本地 → `localImagePaths/localVideoPaths` 写 COS URL；上传失败回退本地相对路径
- **历史迁移**: `docker exec <app容器> npm run migrate:cos`（可重跑，已存在跳过；不删本地文件，验证后手动 `rm -rf data/videos/* data/images/*`）
- **视频修复**: `docker exec <app容器> npm run repair:videos`（修复下载失败回退成 video.twimg.com 的文章；下载支持 60s 无活动超时 + Range 断点续传 5 轮重试）
- **视频清晰度**: FxTwitter 的 url 已是最高码率 MP4 档；更高质量只在 HLS(m3u8) 里，需 ffmpeg，未实现
- **注意**: `package.json` 新增依赖后必须重建 `tweet-base`（`docker build -f Dockerfile.base -t tweet-base:latest .`，apt/pip 层有缓存只跑 npm install）；COS ACL 修改生效有几秒延迟

### 自动翻译（非中文 → 中文）

- **检测**: `translate.ts isNonChinese()` 泛语种——假名(日)/谚文(韩)/拉丁字母主导且汉字 <20% 即非中文（`nonHan < 6` 不翻，防短行误判；短段落也会翻，别再调高阈值）
- **多遍流水线**（学 baoyu-translate refined 模式）: 初翻(draft)→评审(critique,只诊断)→精修(revise)；评审输出「无问题」则跳过硬修；任一步失败回退上一稿/原文。Prompt 在 `prompts/translate/*.md`（提示词即代码，改完重跑生效）
- **术语表**: `data/glossary.json`——命中注入（只注入本文出现的条目），**手编不会被覆盖**；改术语后重跑单篇 `ONLY=<file> npm run translate:foreign`
- **新文章**: `saveTweet` 渲染前 `translateMarkdown()`，原文备份 `data/articles/<base>.orig.md`
- **存量**: `docker exec <app容器> npm run translate:foreign`（HTML block 层翻译，`.bak-trans` 备份，meta/FTS 同步，可断点重跑，3 并发）
- **陷阱**: 输入无编号时 LLM 会自发给输出加【1】标记——`stripMarker` 统一剥除，改动翻译输出格式时注意回归
- **部署**: `prompts/` 目录必须随 `src/ scripts/ public/` 一起 scp（Dockerfile 已 COPY）

### 作者评论区内容合并（正文未完结 → 合并作者自回帖）

- **触发**: 主推文正文「明显未完结」(引子/预告/列 N 条只写部分)时,自动抓作者在评论区的自回帖并入正文,合成一篇
- **判断**: LLM 读正文判完整性,`prompts/comments/detect-incomplete.md`;只有未完结才抓(省掉每篇都抓评论的延迟);完结推文直接跳过
- **抓取**: 已认证 GraphQL `TweetDetail`(`iFEr5AcP121Og4wx9Yqo3w/TweetDetail`)会话线程;过滤作者本人——回复推文的 `core.user_results.result.core.screen_name` 与主推文作者比对(**legacy 里没有 screen_name**);bounded 分页 ≤3 页
- **补齐**: GraphQL `full_text` 会把某些回复截断(实测截在序号"❼"处,丢规则正文)——每条自回帖再用 FxTwitter 单推接口取完整文本,取更长者
- **过滤**: `prompts/comments/filter-replies.md` 只保留「文章正文延续」评论,丢闲聊/广告(推广贴);LLM 判定异常时保守全保留
- **合并**: **直接拼进正文**(`\n\n` 分隔,无标题无引用标记)——读起来像一篇连续文章;评论媒体 [IMG:N]/[VIDEO:N] 重索引入主媒体数组
- **降级**: 无 X_AUTH_TOKEN / LLM 不可用 / 抓取失败 → 跳过,绝不阻塞归档
- **接入点**: `fetchTweet()` FxTwitter 成功路径返回前调 `maybeMergeAuthorComments()`(fetcher.ts)
- **坑**: LLM 会把过滤条目标记返回成 `"[1]"` 字符串而非数字 `1`——`toIndex` 剥 `[]` 再解析,否则过滤会清空全部

### 更新流程

```bash
npm run build
# 用 scp 不用 rsync（rsync 有过多次漏同步的案例）
scp -i ~/Documents/hermes.pem -r \
  src/ scripts/ public/ nginx.conf upstream.conf \
  ubuntu@124.220.236.129:/home/ubuntu/tweet-disgest/
# 验证
ssh -i ~/Documents/hermes.pem ubuntu@124.220.236.129 \
  "grep '<关键改动>' /home/ubuntu/tweet-disgest/src/services/renderer.ts"
# 零停机部署
ssh -i ~/Documents/hermes.pem ubuntu@124.220.236.129 \
  "sudo sh /home/ubuntu/tweet-disgest/deploy.sh"
```

### 验收

部署后逐条验证：

```bash
# 1. 源文件已同步到服务器
ssh -i ~/Documents/hermes.pem ubuntu@124.220.236.129 \
  "grep '<关键改动>' /home/ubuntu/tweet-disgest/src/services/renderer.ts"

# 2. 容器正常运行（tweet-nginx + 一个 app）
ssh -i ~/Documents/hermes.pem ubuntu@124.220.236.129 \
  "sudo docker ps --format '{{.Names}} {{.Status}}'"

# 3. HTTP 返回 200
ssh -i ~/Documents/hermes.pem ubuntu@124.220.236.129 \
  "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/"

# 4. 如果改了 renderTweetHtml 的样式，旧文章需运行迁移脚本
#    写一个 sed/正则批量替换 data/articles/*.html
```

**反复出现的新模式：**
- 修改后必须逐条验证，不可跳过
- "部署成功" ≠ 改动生效——必须在服务器上 grep 确认源文件已同步
- 浏览器强刷新（Cmd+Shift+R）确认前端生效

---

## Spec

### 1. 推文抓取

- **FxTwitter 优先**：主路径，`tweet.text.trim().length > 10` 视为有效
- **Twitter Article**：`tweet.article` 存在时总是解析 Draft.js blocks + entityMap，**文章正文比 `tweet.text` 长则采用正文**。X Article 发布推文的 `tweet.text` 常是 100+ 字符预览（`raw_text` 末尾带指向 `x.com/i/article/...` 的 t.co），不可用 `text.trim().length <= 30` 当判断门槛——会丢掉完整正文（历史 bug：OtherSideBJ_2085175270185848897 只存了预览）
- **Jina AI 降级**：FxTwitter 失败后使用（国内不通，仅作后备）
- **oEmbed 兜底**：最后手段
- **全部失败**：返回明确错误信息

### 2. Twitter Article 解析（Draft.js → Markdown）

| Block Type | Markdown |
|-----------|----------|
| `unstyled` | 纯文本 + 内联样式（Bold→`**` Italic→`*` Code→`` ` `` Underline→`<u>` Strikethrough→`~~`） |
| `header-one/two/three` | `#` `##` `###` |
| `code-block` | ` ``` ` 围栏 |
| `blockquote` | `> ` |
| `ordered-list-item` | `1. 2. 3.`（连续块计数，断开重置） |
| `unordered-list-item` | `- ` |
| `atomic` | 查 entityMap：MARKDOWN→插入内容、DIVIDER→`---`、其他→`[IMG]` |

**entityMap** 是 `[{key, value}]` list，不是 dict。`value.type` 决定处理方式。

| Entity Type | 处理 |
|------------|------|
| MARKDOWN | 直接插入 markdown 内容 |
| DIVIDER | `---` |
| IMAGE | `[IMG]` → 映射到 media_entities 图片 |
| VIDEO | `[VIDEO]` → 映射到 media_entities 视频 |

**media_entities** 处理：
- `ApiImage` → `TweetPhoto`，生成 `[IMG:N]` 标记
- `ApiVideo` → `TweetVideo`（取最高码率 MP4），生成 `[VIDEO:N]` → 渲染 `<video>` 标签

**封面图**：`article.cover_media.media_info.original_img_url` → `[IMG:0]` 置顶。

**表格**：GFM markdown table（`| --- |`）由 marked 自动渲染为 `<table>`。

### 3. 图像处理

- **头像**：强制 `https://unavatar.io/x/{screen_name}`，禁止 pbs.twimg.com/profile_images
- **头图防误判**：`isAvatarUrl` 检测 unavatar.io、profile_images、尺寸后缀（`_normal`/`_400x400` 等）、本地文件 < 10KB
- **头图提取逻辑**：从正文开头遍历 `<!--IMG:N-->`，跳过所有头像，取第一个真实图片作为头图。不是只检查第一张
- **图片下载**：通过 `HTTPS_PROXY` 代理下载到 `data/images/`
- **头图位置**：标题之前，class="header-img"，CSS 破边全宽

### 4. HTML 渲染

- Markdown→HTML：marked + highlight.js
- @mention / #hashtag：自动转链接
- 头像：36px 圆形，article-meta 中
- 响应式：480px 断点
- 索引页：启动时自动生成，无文章时显示空状态
- **图标**：评论/转发/喜欢使用 X 风格 SVG（`ICONS` 常量），不用 emoji
- **列表页布局**：
  - `.item-row` 左右 padding 各 16px
  - 每条左侧显示博主头像（`meta-avatar`，18px 圆形，unavatar.io）
  - 元数据分行：作者名（`meta-author`）+ 时间（`meta-time`）
  - 数据指标：`article-stats` 内等间距 `stat`
- **菜单**：未读显示"标为已读"（调 `markRead`），已读显示"标为未读"（调 `markUnread`）

### 5. API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | `{"status":"ok"}` |
| `/api/archive` | POST | 保存推文 `{url}` |
| `/api/pin` | POST | 置顶 `{id, pin}` |
| `/api/read` | POST | 标已读 |
| `/api/unread` | POST | 标未读 |
| `/api/delete` | POST | 删除 |
| `/` | GET | 索引页 |

### 6. Dockerfile 关键点

- `mkdir -p public` 必须在 `npm run build` 之前（postbuild 需要 public/）
- 环境变量：`USE_PROXY=1`, `HTTPS_PROXY=http://host.docker.internal:7890`
- `extra_hosts: host.docker.internal:host-gateway`

### 7. 已知陷阱

**部署相关：**
- **手动 `docker restart` app 容器后必须 `docker kill -s HUP tweet-nginx`**：nginx 只在启动/HUP 时解析 upstream 主机名并缓存 IP，app 容器重建/重启换 IP 后全站 502（deploy.sh 已内置 HUP，手动 restart 没有）
- **磁盘告警先清 docker**：`docker image prune -f` + `docker rmi tweet-disgest_app:<非活跃色>`。蓝绿双镜像 + base 重建会累积（32 个镜像曾占 11G）
- **rsync 不可靠，必须用 scp**：rsync 多次报告成功但文件未同步到服务器。现在统一 `scp -i ~/Documents/hermes.pem -r`
- **部署后必须验证服务器源文件**：scp 后 `grep <关键改动> /home/ubuntu/tweet-disgest/src/...` 确认，再执行 deploy.sh
- **docker-compose 1.29.2 有 ContainerConfig bug**：不能用来启停容器。构建用 `docker build`，容器管理用 `docker run/rm`，nginx 用 `kill -s HUP` 热重载
- **端口 3000 被占用时需手动清理**：`sudo docker rm -f $(sudo docker ps -aq)` 清场再启动

**代码修改：**
- **改 CSS/样式必须改两处**：`renderTweetHtml()` 和 `renderIndexHtml()` 各有一个 `<style>` 块，变量/主题色/公共样式改一处另一处不生效。用 `replace_all: true`
- **linter 会实时改文件**：每次 Edit 前必须先 Read 获取最新内容，否则报「File has been modified since read」
- **mihomo 默认 `allow-lan: false`**：Docker 容器连不上代理（`/home/ubuntu/.config/mihomo/config.yaml`）
- **Docker 构建必须 `--no-cache`**：否则 COPY src 用缓存
- **`escapeHtml` 不接受 undefined**：模板中取字段时必须 `field || ''` 兜底
- **JS 模板拼接**：server-side（template literal）和 client-side（string concat）各一份，改功能时两边同步
- **文章页是静态 HTML**：`data/articles/*.html` 是保存时预渲染的。改了 `renderTweetHtml()` 后旧文需运行迁移脚本批量替换
- entityMap 是 list 不是 dict
- atomic 块内容在 entityMap 里，不在 block.text 里
- pbs.twimg.com 国内不通，图片必须走代理下载

**设计约定：**
- **蓝色表示可点击**：帖主昵称（`.meta-author`）用 `var(--text)` 而不是 `var(--accent)`，避免误导用户
- **暗色模式 accent 色要柔和**：用灰蓝色调如 `#7d93ad`，不能是亮蓝

---

## 工作规范（防止反复修改）

### 自动部署守则

改完 Bug 或完成一个功能后：
1. **自动验证** — `npm run build` 通过 → 服务器 `grep` 确认改动 → `curl` 确认 HTTP 200
2. **验证通过后自动部署** — 不询问，直接走 scp + deploy.sh 流程
3. **旧文章迁移** — 如果改了 `renderTweetHtml()` 或其他影响存量 HTML 的代码，验证时检查旧文章，同步更新后 scp 到服务器
4. **验证失败** — 停下来修复，不部署

即三步闭环：验证 → 通过 → 部署。不需要逐条确认，除非验证失败。

### 改前读代码

任何修改前，必须先完整阅读相关文件：
- `grep` 搜索所有引用位置，确认没有遗漏的副本
- 标注关键约束条件（如 `escapeHtml` 不接受 `undefined`、entityMap 是 list 不是 dict）
- 不做基于猜测的修改——不确定的数据结构先打印确认

### 改后跑验证

每次修改后执行验证清单：
- [ ] `npm run build` 成功
- [ ] 如果是样式改动：检查文章页 + 索引页 + 暗色模式 + 移动端
- [ ] 如果改了 `renderTweetHtml()`：考虑旧文章是否需要迁移脚本
- [ ] 本地验证通过后再部署
- [ ] 部署后逐条验证（见上方"验收"流程）
- [ ] 浏览器 Cmd+Shift+R 强刷新确认
