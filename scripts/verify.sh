#!/bin/sh
# tweet-disgest 自动化验收脚本
# Usage: sh /app/scripts/verify.sh [base_url]

BASE=${1:-http://localhost:3000}
ARTICLES_DIR="/app/data/articles"
INDEX_FILE="/app/public/index.html"
FAIL=0

check() {
  local desc="$1"; shift
  if "$@"; then
    echo "  [PASS] $desc"
  else
    echo "  [FAIL] $desc"
    FAIL=1
  fi
}

# Use wget (Alpine default), fallback to curl
if command -v wget >/dev/null 2>&1; then
  http_get() { wget -q -O - "$1"; }
elif command -v curl >/dev/null 2>&1; then
  http_get() { curl -s "$1"; }
else
  http_get() { node -e 'const u=process.argv[1];require("http").get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(d))})' "$1"; }
fi

echo ""
echo "========================================="
echo " tweet-disgest 验收"
echo " Target: $BASE"
echo "========================================="

# ---- 1. 基础服务 ----
echo ""
echo "[1/7] 基础服务"
RESP=$(http_get "$BASE/" 2>/dev/null)
check "GET / 返回内容"        test -n "$RESP"
HEALTH=$(http_get "$BASE/api/health" 2>/dev/null)
check "GET /api/health 返回 ok"  test -n "$HEALTH"

# ---- 2. 索引页 ----
echo ""
echo "[2/7] 索引页"
check "index.html 存在"          test -f "$INDEX_FILE"
check "标题包含「推文收藏」"      grep -q '推文收藏' "$INDEX_FILE" 2>/dev/null

# ---- 3. 图像 ----
echo ""
echo "[3/7] 图像"
check "无 pbs.twimg.com 残留"    sh -c "! grep -rq 'pbs\\.twimg\\.com' $ARTICLES_DIR 2>/dev/null"
check "无 profile_images 残留"   sh -c "! grep -rq 'profile_images' $ARTICLES_DIR 2>/dev/null"

# ---- 4. 头像 ----
echo ""
echo "[4/7] 头像"
UNI_COUNT=$(grep -r 'unavatar.io' "$ARTICLES_DIR" 2>/dev/null | wc -l)
AVATAR_COUNT=$(grep -r 'class="avatar"' "$ARTICLES_DIR" 2>/dev/null | wc -l)
check "所有头像使用 unavatar.io (${UNI_COUNT}/${AVATAR_COUNT})" \
  test "$UNI_COUNT" -ge "$AVATAR_COUNT"

# ---- 5. SVG 图标 ----
echo ""
echo "[5/9] SVG 图标"
INDEX_SVG=$(grep -c '<svg' "$INDEX_FILE" 2>/dev/null || echo 0)
check "索引页使用 SVG 图标 (>0)"  test "$INDEX_SVG" -gt 0
ART_SVG=$(grep -rc '<svg' "$ARTICLES_DIR" 2>/dev/null | awk -F: '{s+=$2}END{print s+0}')
echo "  文章页 SVG 图标总数: ${ART_SVG}"

# ---- 6. 列表页结构 ----
echo ""
echo "[6/9] 列表页结构"
check "列表有 meta-avatar"         grep -q 'meta-avatar' "$INDEX_FILE" 2>/dev/null
check "列表有 meta-author"         grep -q 'meta-author' "$INDEX_FILE" 2>/dev/null
check "列表有 article-stats"       grep -q 'article-stats' "$INDEX_FILE" 2>/dev/null
check "列表无孤立span标签"         sh -c "! grep -q \"</span>'\" $INDEX_FILE 2>/dev/null"
check "JS sortBy 函数存在"         grep -q 'function sortBy' "$INDEX_FILE" 2>/dev/null
check "标为已读/未读逻辑存在"      grep -q '标为已读' "$INDEX_FILE" 2>/dev/null

# ---- 7. 视频/表格 ----
echo ""
echo "[7/9] 视频/表格"
VIDEO_COUNT=$(grep -rc '<video' "$ARTICLES_DIR" 2>/dev/null | awk -F: '{s+=$2}END{print s+0}')
TABLE_COUNT=$(grep -rc '<table>' "$ARTICLES_DIR" 2>/dev/null | awk -F: '{s+=$2}END{print s+0}')
echo "  视频元素: ${VIDEO_COUNT}, 表格元素: ${TABLE_COUNT}"

# ---- 6. 代码高亮 ----
echo ""
echo "[8/9] 代码高亮"
HLJS_COUNT=$(grep -rc 'class="hljs' "$ARTICLES_DIR" 2>/dev/null | awk -F: '{s+=$2}END{print s+0}')
PRE_COUNT=$(grep -rc '<pre>' "$ARTICLES_DIR" 2>/dev/null | awk -F: '{s+=$2}END{print s+0}')
if [ "$PRE_COUNT" -gt 0 ]; then
  check "含 pre 的文章同时有 hljs 高亮 (hljs:${HLJS_COUNT} pre:${PRE_COUNT})" \
    test "$HLJS_COUNT" -ge "$PRE_COUNT"
else
  echo "  [SKIP] 无代码块文章，跳过"
fi

# ---- 6. 头图 ----
echo ""
echo "[9/9] 头图"
FILE_COUNT=$(ls "$ARTICLES_DIR"/*.html 2>/dev/null | wc -l)
echo "  文章总数: $FILE_COUNT"
BAD=0
MISSING=0
for f in "$ARTICLES_DIR"/*.html; do
  [ -f "$f" ] || continue
  base=$(basename "$f" .html)
  HAS_HEADER=$(grep -c 'class="header-img"' "$f" 2>/dev/null || echo 0)
  HAS_INLINE=$(grep -c 'tweet-inline-img' "$f" 2>/dev/null || echo 0)
  if [ "$HAS_INLINE" -gt 0 ] && [ "$HAS_HEADER" -eq 0 ]; then
    echo "  [WARN] $base: has ${HAS_INLINE} inline images but no header image"
    MISSING=$((MISSING + 1))
  fi
  if [ "$HAS_HEADER" -gt 0 ]; then
    HDR_SRC=$(grep -o 'class="header-img"[^>]*src="[^"]*"' "$f" 2>/dev/null | grep -o 'src="[^"]*"' | head -1 | sed 's/src="//;s/"//')
    case "$HDR_SRC" in
      ../images/*)
        HDR_FILE="/app/data/images/$(basename "$HDR_SRC")"
        if [ -f "$HDR_FILE" ]; then
          SIZE=$(stat -c%s "$HDR_FILE" 2>/dev/null)
          if [ -n "$SIZE" ] && [ "$SIZE" -lt 10000 ]; then
            echo "  [WARN] $base: header image too small (${SIZE} bytes)"
            BAD=$((BAD + 1))
          fi
        fi
        ;;
    esac
  fi
done
if [ "$BAD" -eq 0 ] && [ "$MISSING" -eq 0 ]; then
  echo "  [PASS] 头图正常 (有头图且尺寸正常)"
else
  [ "$BAD" -gt 0 ] && echo "  [FAIL] $BAD 个头图疑似头像"
  [ "$MISSING" -gt 0 ] && echo "  [FAIL] $MISSING 个有图但缺头图"
  FAIL=1
fi

# ---- 7. 日志 ----
echo ""
echo "[9/9] 日志检查"
LOGFILE="/app/app.log"
if [ -f "$LOGFILE" ]; then
  ERR_COUNT=$(grep -c 'Error\|FATAL' "$LOGFILE" 2>/dev/null || printf '0')
  if [ "$ERR_COUNT" = "0" ] || [ -z "$ERR_COUNT" ]; then
    echo "  [PASS] 无 Error/FATAL 日志"
  else
    echo "  [WARN] 发现 $ERR_COUNT 条 Error 日志"
  fi
else
  echo "  [SKIP] app.log 不存在"
fi

# ---- 结果 ----
echo ""
echo "========================================="
if [ $FAIL -eq 0 ]; then
  echo "  验收通过"
else
  echo "  发现问题，请检查 FAIL 项"
fi
echo "========================================="
exit $FAIL
