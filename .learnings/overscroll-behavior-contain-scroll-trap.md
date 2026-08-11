# 桌面端文章页无法下滑——overscroll-behavior: contain 吞滚轮

## 问题
电脑端打开文章详情页,鼠标滚轮滚不动,但索引页正常。程序能滚(`window.scrollBy` 有效)、真实滚轮不行。

## 根因
`renderTweetHtml()` 里给 `.page-wrapper` 加了 `overflow-y: auto`(使其成为滚动容器),同时给 `html, body` 加了 `overscroll-behavior: contain`。滚轮落在 `.page-wrapper` 上 → 它内部不溢出(高度被内容撑开,scrollHeight==clientHeight)滚不动 → 本应链式上传到视口,却被 `contain` 拦截纵向链条 → 滚轮被吞。

变体测试定位最小根因:**去掉 `overscroll-behavior: contain`(保留 `overflow-y: auto`)滚轮即恢复**;只去掉 `overflow-y: auto` 保留 contain 仍坏。`overscroll-behavior-x: none` 已覆盖横向,`contain` 唯一作用就是加了纵向含——恰好破坏桌面滚轮。

## 解决方案
`html, body` 规则删除 `overscroll-behavior: contain`,保留 `overscroll-behavior-x: none; touch-action: pan-y`。横向屏蔽仍由 `touch-action: pan-y` + JS `touchmove` 处理器 + `overscroll-behavior-x: none` 保证,移动端纵向滚动不受影响。

存量修复:renderer.ts 改了只影响新文章;线上 174 篇已渲染文章需 sed 批量替换 `data/articles/*.html`(先 tar 备份)。

## 为什么重要
`overscroll-behavior: contain` 是桌面滚轮的常见陷阱:当一个不可内部滚动的滚动容器 + 全轴 contain 组合时,滚轮事件被吞、不链上传视口。调试时**真实滚轮事件**和 `window.scrollBy` 结果可能不同——程序能滚 ≠ 用户能滚。

## 如何应用
- 给滚动容器加 `overflow-y: auto` 时,不要在 `html/body` 上放 `overscroll-behavior: contain`(用 `overscroll-behavior-x: none` 就够了)。
- 改滚动相关 CSS 后用 `page.mouse.wheel()`(Playwright)验证,别只用 `scrollBy`。
- 修改 `renderTweetHtml()` 的 CSS 后,存量文章需迁移脚本,且 CSS 在 `renderTweetHtml()` 和 `renderIndexHtml()` 各有一份。

## 文件
- `src/services/renderer.ts`(html/body 规则,删 contain)
- 服务器 `data/articles/*.html`(174 篇 sed 迁移,备份在 `/home/ubuntu/backup-scroll-fix/`)
