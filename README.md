# Tweet Archive

自动保存推特推文为本地网页，支持通过 iOS 快捷指令一键归档。

## 功能

- 接收推文 URL，自动抓取内容（文本、图片、作者、互动数据）
- 生成格式化的静态 HTML 页面
- 自动下载推文中的图片到本地
- 生成索引页面，按时间倒序浏览所有保存的推文
- 支持多源抓取：FxTwitter API → Jina AI → Twitter oEmbed（自动回退）

## 快速开始

### 1. 克隆并启动

```bash
git clone <仓库地址> tweet-archive
cd tweet-archive

# 方式一：Docker（推荐）
docker-compose up -d

# 方式二：直接运行
npm install
npm run build
npm start
```

服务启动后访问 `http://你的服务器IP:3000`

### 2. 测试 API

```bash
curl -X POST http://localhost:3000/api/archive \
  -H "Content-Type: application/json" \
  -d '{"url":"https://twitter.com/username/status/1234567890"}'
```

### 3. iOS 快捷指令配置

1. 打开 iOS **快捷指令** App
2. 创建新快捷指令，命名为 **"保存推文"**
3. 添加操作：
   - **从输入中获取 URL**（快捷指令会自动接收分享的内容）
   - **获取 URL 的内容** → 方法选 **POST**，URL 填 `http://你的服务器IP:3000/api/archive`
   - 在请求体中添加 JSON：
     ```
     {"url": "[快捷指令变量: URL]"}
     ```
4. 打开快捷指令的 **详细信息** → 打开 **"在分享表单中显示"**
5. 在 Twitter App 中点击任意推文的 **分享按钮**
6. 在分享菜单中找到并点击 **"保存推文"**
7. 完成！推文会自动保存到你的服务器

### 4. Nginx + HTTPS 配置（可选）

如果你有域名，建议配置 HTTPS：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /api/archive` | JSON body: `{ "url": "推文URL" }` | 保存推文 |
| `GET /api/health` | - | 健康检查 |
| `GET /` | - | 浏览保存的推文列表 |

## 目录结构

```
data/
  articles/     # 生成的 HTML 文件
  images/       # 下载的图片
  public/       # 索引页面
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
