# 视频/图片迁移到腾讯云 COS（含部署与权限坑）

## 背景
服务器 40G 磁盘到 98%。视频 1.3G + 图片 1.0G 迁到 COS 桶 `articlevideo-1316871392`（ap-shanghai，与 CVM 同地域，上传走内网免费），文章 HTML 直接引用 COS 默认域名 URL（免备案，无 CDN）。

## 实现
- `src/services/cos.ts`：`uploadToCos(localPath, key, contentType, kind)`，kind 决定对象标签 `type=video|image`（`x-cos-tagging` header，经 `putObject` 的 `Headers` 传入）；`isCosEnabled()` 未配置时整体降级本地存储
- `renderer.ts` 保存流程：下载到本地 → `tryUploadMediaToCos()` 上传+删本地 → 返回 COS URL；失败回退 `../videos|images/` 本地路径（文章永远不会因 COS 故障而坏）
- `scripts/migrate-media-to-cos.ts`（`npm run migrate:cos`，容器内跑）：headObject 判重可断点重跑，只改写已确认上传成功的引用，不删本地文件

## 踩过的坑
1. **桶权限改了不生效**：控制台改「公有读」后 API 读仍是 private；且 ACL 修改有**几秒传播延迟**，putBucketAcl 成功后立刻 curl 仍 403，等 2-5 秒即可。子账号 `QcloudCOSFullAccess` 可直接 `putBucketAcl` 改桶权限，不用等人在控制台点。
2. **package.json 加依赖必须重建 tweet-base**：app 镜像 FROM tweet-base，node_modules 在 base 里。`docker build -f Dockerfile.base -t tweet-base:latest .`（不要 --no-cache，apt/pip 层有缓存，只重跑 npm install）。docker build 无代理，但 npm registry 直连可达。
3. **docker --no-cache 部署会累积镜像**：蓝绿双镜像 + 旧 base 层，32 个镜像占 11G。清理：`docker image prune -f` + `docker rmi tweet-disgest_app:<非活跃色>`。
4. **长视频（1-2h）链路验证**：axios 30s 超时是 socket 无活动才触发（流式下载不受影响）；COS putObject 上限 5GB；真正瓶颈是中转磁盘——下载先落盘再上传，磁盘空闲必须 > 视频大小。下载失败自动回退 Twitter 原始 URL。
5. **COS SDK 不走代理**：cos-request 库忽略 HTTPS_PROXY，容器内直连 COS（正是想要的，代理只用于访问 Twitter）。

## 后续：长视频下载超时修复 + 断点续传

- **根因**：`downloadFile` 流式写盘阶段有 20s **总时长**硬超时（报 `Timeout`），长视频必失败 → 文章回退成 video.twimg.com 原始链接（国内浏览器放不了）。56 篇历史文章中招。
- **修复**：60s **无数据活动**超时（data 事件重置计时器）+ 字节级断点续传（半成品保留，下轮 `Range: bytes=N-` 续传，5 轮重试，Content-Range 校验总大小，不符删除重来）。
- **修复存量**：`scripts/repair-twitter-videos.ts`（`npm run repair:videos`）——扫 HTML 里的 video.twimg.com URL，下载→COS→改写，命名 `<base>_fixvid<k>.mp4`。
- **大视频加速**：单连接被代理限速（~230KB/s），1GB 视频用 16 段 Range 并行下载约 4 分钟（curl `-r start-end` 并发 + cat 合并，video.twimg.com 支持 accept-ranges）。
- **视频清晰度**：FxTwitter 的 `media.videos[].url` 已是最高码率 MP4 档（实测 1080p@10Mbps 阶梯最高）；Twitter 不提供原始文件。更高质量只可能藏在 HLS（m3u8）的更高 rendition 里，需 ffmpeg——暂未做。

## 文件

- `src/services/cos.ts`（新增）
- `src/services/renderer.ts`（tryUploadMediaToCos + 图片/视频四个分支 + downloadFile 断点续传）
- `scripts/migrate-media-to-cos.ts`（新增）
- `scripts/repair-twitter-videos.ts`（新增）
- 服务器 `.env`：COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION/COS_BASE_URL/COS_TAG_VIDEO/COS_TAG_IMAGE
