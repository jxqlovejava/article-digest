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
```

docker-compose 管理双容器：nginx（反向代理 + gzip）→ app（Express）。同一网络，nginx 重启 < 1s，app 重启 < 3s。

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
- **Twitter Article**：`tweet.text` 为空/很短且 `tweet.article` 存在时，解析 Draft.js blocks + entityMap
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
