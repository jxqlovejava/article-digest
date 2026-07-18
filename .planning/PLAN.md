# Share Feature: 长图文分享预览

## Goal

为每篇文章详情页添加分享功能：点击右上角分享图标 → 生成长图文预览 → 保存图片到本地。

## Scope

**仅修改 `src/services/renderer.ts`**，具体是 `renderTweetHtml()` 函数（文章详情页模板）。

无需修改 server.ts、fetcher.ts、索引页、API 路由。

---

## 技术方案

### 截图库：html2canvas

- 从 CDN 加载 `html2canvas@1.4.1`
- 通过 `<script>` 标签异步加载，不阻塞页面渲染
- 捕获 `.article-card` 元素作为长图

### 交互流程

```
点击分享按钮 → 加载 html2canvas（如未加载）→ 截图 .article-card
→ 全屏预览弹窗（显示生成的长图）
→ 点击"保存图片" → canvas.toBlob() → 触发下载
```

---

## 实现步骤

### Step 1: 添加分享图标 SVG

在 `ICONS` 常量对象中新增 `share` 图标：

```
位置: src/services/renderer.ts:54 (ICONS 对象末尾)
内容: 分享/导出风格 SVG (18px, currentColor, stroke-based)
```

### Step 2: 在文章页 top-bar 添加分享按钮

修改 `renderTweetHtml()` 的 top-bar 区域（第 354-360 行），在主题切换按钮之前添加分享按钮：

```html
<button class="share-btn" onclick="openSharePreview()" title="分享长图">
  <!-- share SVG icon -->
</button>
```

### Step 3: 添加 html2canvas CDN 加载逻辑

在文章页 `<script>` 中添加动态加载：

```javascript
var html2canvasLoaded = false;
function loadHtml2canvas(callback) {
  if (html2canvasLoaded) { callback(); return; }
  if (window.html2canvas) { html2canvasLoaded = true; callback(); return; }
  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
  script.onload = function() { html2canvasLoaded = true; callback(); };
  document.head.appendChild(script);
}
```

### Step 4: 添加分享预览弹窗 HTML

在 `</body>` 前添加弹窗 DOM：

```html
<div class="share-overlay" id="shareOverlay" style="display:none">
  <div class="share-preview">
    <div class="share-preview-header">
      <button class="share-close-btn" onclick="closeSharePreview()">✕</button>
    </div>
    <div class="share-preview-body" id="sharePreviewBody">
      <!-- canvas/image inserted here -->
    </div>
    <div class="share-preview-footer">
      <button class="share-save-btn" onclick="saveShareImage()">保存图片</button>
    </div>
  </div>
</div>
```

### Step 5: 添加分享相关 CSS

在 `<style>` 块中添加：

```css
/* 分享按钮 */
.share-btn {
  width: 32px; height: 32px; border: none; border-radius: 50%;
  background: transparent; color: var(--text-secondary); cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: all 0.2s;
}
.share-btn:hover { color: var(--text); }

/* 分享预览弹窗 */
.share-overlay { /* 全屏半透明遮罩 */ }
.share-preview { /* 居中预览容器 */ }
.share-preview-body img { /* 长图滚动显示 */ }
.share-save-btn { /* 保存按钮样式 */ }
```

### Step 6: 添加分享 JavaScript

```javascript
var shareImageDataUrl = null;

function openSharePreview() {
  loadHtml2canvas(function() {
    var card = document.querySelector('.article-card');
    html2canvas(card, {
      backgroundColor: getComputedStyle(document.documentElement)
        .getPropertyValue('--bg').trim() || '#f5f5f5',
      scale: 2,  // 2x for retina
      useCORS: true,
      logging: false,
    }).then(function(canvas) {
      shareImageDataUrl = canvas.toDataURL('image/png');
      // 显示预览弹窗
      var previewBody = document.getElementById('sharePreviewBody');
      previewBody.innerHTML = '<img src="' + shareImageDataUrl + '" alt="分享预览" />';
      document.getElementById('shareOverlay').style.display = 'flex';
    });
  });
}

function closeSharePreview() {
  document.getElementById('shareOverlay').style.display = 'none';
}

function saveShareImage() {
  if (!shareImageDataUrl) return;
  var a = document.createElement('a');
  a.href = shareImageDataUrl;
  a.download = document.title + '.png';
  a.click();
}
```

### Step 7: 构建验证

```bash
npm run build        # TypeScript 编译
```

### Step 8: 部署 & 验收

按 CLAUDE.md 部署流程：scp → grep → deploy.sh → curl → 浏览器验证

---

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/services/renderer.ts` | 修改 | ICONS + renderTweetHtml() 模板 |

## 风险 & 边界情况

| 场景 | 处理 |
|------|------|
| html2canvas CDN 加载失败 | 按钮点击无反应，静默失败 |
| 文章内容极长 | html2canvas 自动处理完整高度 |
| 暗色模式 | canvas backgroundColor 读取当前主题 `--bg` 变量 |
| 图片跨域 | `useCORS: true`（本地图片同源，无需额外处理） |
| 移动端保存 | `<a download>` 在 iOS Safari 中可能无效，需长按图片保存 |
| 旧文章 | 无需迁移，旧文打开时动态加载新模板 |
