#!/bin/sh
set -e

BASE="/home/ubuntu/tweet-disgest"
IMAGE="tweet-disgest_app"
NET="tweet-disgest_default"
NGINX="tweet-nginx"
UPSTREAM="$BASE/upstream.conf"
DATA="$BASE/data"

# Ensure network
docker network create "$NET" 2>/dev/null || true

# Ensure nginx (idempotent)
if ! docker ps --format '{{.Names}}' | grep -q "$NGINX"; then
    echo "[deploy] Starting nginx..."
    docker rm -f "$NGINX" 2>/dev/null || true
    docker run -d --name "$NGINX" --network "$NET" -p 3000:3000 --restart unless-stopped \
        -v "$BASE/nginx.conf:/etc/nginx/nginx.conf:ro" \
        -v "$BASE/upstream.conf:/etc/nginx/upstream.conf:ro" \
        nginx:alpine
    sleep 1
fi

# Detect active
if docker ps --format '{{.Names}}' | grep -q 'app-blue'; then
    ACTIVE="blue"; NEXT="green"
elif docker ps --format '{{.Names}}' | grep -q 'app-green'; then
    ACTIVE="green"; NEXT="blue"
else
    ACTIVE="none"; NEXT="blue"
fi
echo "[deploy] $ACTIVE → $NEXT"

# --- Build base image (skip if package.json unchanged) ---
BASE_IMAGE="tweet-base"
BASE_HASH=$(md5sum "$BASE/package.json" "$BASE/package-lock.json" 2>/dev/null | md5sum | cut -d' ' -f1)
BASE_TAG_FILE="/tmp/tweet-base-hash"
NEED_BASE_BUILD=true
if [ -f "$BASE_TAG_FILE" ] && [ "$(cat "$BASE_TAG_FILE")" = "$BASE_HASH" ]; then
    if docker image inspect "$BASE_IMAGE:latest" >/dev/null 2>&1; then
        NEED_BASE_BUILD=false
        echo "[deploy] Base image up to date"
    fi
fi
if [ "$NEED_BASE_BUILD" = "true" ]; then
    echo "[deploy] Building base image..."
    docker build --no-cache -f "$BASE/Dockerfile.base" -t "$BASE_IMAGE:latest" "$BASE"
    echo "$BASE_HASH" > "$BASE_TAG_FILE"
fi

# --- Build business image (fast: only COPY + tsc) ---
echo "[deploy] Building..."
docker build --no-cache -t "$IMAGE:$NEXT" "$BASE"

# Start new
echo "[deploy] Starting app-$NEXT..."
docker rm -f "app-$NEXT" 2>/dev/null || true
# Secrets live in $BASE/.env (LLM_API_KEY etc). Required for Q&A.
ENV_FILE="$BASE/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "[deploy] WARN: missing $ENV_FILE — LLM Q&A will fail until LLM_API_KEY is set"
fi
ENV_FILE_ARG=""
if [ -f "$ENV_FILE" ]; then
    ENV_FILE_ARG="--env-file $ENV_FILE"
fi
# shellcheck disable=SC2086
docker run -d --name "app-$NEXT" --network "$NET" \
    -v "$DATA:/app/data" \
    --add-host host.docker.internal:host-gateway \
    $ENV_FILE_ARG \
    -e PORT=3000 -e USE_PROXY=1 \
    -e HTTPS_PROXY=http://host.docker.internal:7890 \
    -e HTTP_PROXY=http://host.docker.internal:7890 \
    --restart unless-stopped \
    "$IMAGE:$NEXT"

# Health check
echo "[deploy] Health check..."
OK=false
for i in $(seq 1 20); do
    CODE=$(docker exec "app-$NEXT" node -e "
        require('http').get('http://localhost:3000/api/health', function(r) {
            process.exit(r.statusCode === 200 ? 0 : 1);
        }).on('error', function() { process.exit(1); });
    " 2>/dev/null && echo "200" || echo "000")
    if [ "$CODE" = "200" ]; then OK=true; echo "[deploy] Health OK"; break; fi
    sleep 1
done
if [ "$OK" != "true" ]; then
    echo "[deploy] FAIL: health check failed"; docker rm -f "app-$NEXT"; exit 1
fi

# Switch — nginx reload is instant, zero connection loss
echo "[deploy] Switching..."
echo "upstream app_backend {
    server app-$NEXT:3000;
}" > "$UPSTREAM"
docker kill -s HUP "$NGINX"

# Verify
echo "[deploy] Verify..."
for i in $(seq 1 5); do
    CODE=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/api/health 2>/dev/null || echo "000")
    if [ "$CODE" = "200" ]; then echo "[deploy] Verified"; break; fi
    sleep 1
done

# Stop old
if [ "$ACTIVE" != "none" ]; then
    echo "[deploy] Stopping app-$ACTIVE..."
    docker rm -f "app-$ACTIVE"
fi

echo "[deploy] Done — live on app-$NEXT"