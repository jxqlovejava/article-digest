#!/bin/sh
# Restore LLM_API_KEY into tweet-disgest/.env and recreate live app container.
# Uses DEEPSEEK_API_KEY from ~/.hermes/.env when present.
set -e

BASE="/home/ubuntu/tweet-disgest"
HERMES_ENV="/home/ubuntu/.hermes/.env"
ENV_FILE="$BASE/.env"
NET="tweet-disgest_default"
NGINX="tweet-nginx"
UPSTREAM="$BASE/upstream.conf"
DATA="$BASE/data"

if [ ! -f "$HERMES_ENV" ]; then
  echo "Missing $HERMES_ENV"
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
hermes = Path("/home/ubuntu/.hermes/.env").read_text()
key = None
base = "https://api.deepseek.com"
for raw in hermes.splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[7:]
    if "=" not in line:
        continue
    k, v = line.split("=", 1)
    k, v = k.strip(), v.strip().strip("\"'")
    if k == "DEEPSEEK_API_KEY":
        key = v
    if k == "DEEPSEEK_BASE_URL":
        b = v.rstrip("/")
        if b.endswith("/v1"):
            b = b[:-3]
        if b:
            base = b
if not key:
    raise SystemExit("no DEEPSEEK_API_KEY found in hermes .env")
env_path = Path("/home/ubuntu/tweet-disgest/.env")

# Preserve existing non-LLM secrets (e.g. X_AUTH_TOKEN / X_CT0 / X_USER_ID)
# instead of wiping the whole file on every LLM key restore.
existing: dict[str, str] = {}
if env_path.exists():
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        existing[k.strip()] = v.strip().strip("\"'")

existing.update({
    "LLM_API_KEY": key,
    "LLM_BASE_URL": base,
    "LLM_MODEL": "deepseek-v4-flash",
    "LLM_MODEL_PRO": "deepseek-v4-pro",
})

env_path.write_text(
    "# tweet-disgest runtime secrets — never commit\n"
    + "".join(f"{k}={v}\n" for k, v in existing.items())
)
env_path.chmod(0o600)
print(f"wrote {env_path} entries={len(existing)} key_len={len(key)} base={base}")
PY

# Detect active color
if docker ps --format '{{.Names}}' | grep -q 'app-blue'; then
  ACTIVE="blue"
elif docker ps --format '{{.Names}}' | grep -q 'app-green'; then
  ACTIVE="green"
else
  ACTIVE="blue"
fi

IMAGE=$(docker inspect "app-$ACTIVE" --format '{{.Config.Image}}' 2>/dev/null || echo "tweet-disgest_app:blue")
echo "[restore] recreating app-$ACTIVE from $IMAGE with --env-file"

docker rm -f "app-$ACTIVE" 2>/dev/null || true
docker run -d --name "app-$ACTIVE" --network "$NET" \
  -v "$DATA:/app/data" \
  --add-host host.docker.internal:host-gateway \
  --env-file "$ENV_FILE" \
  -e PORT=3000 -e USE_PROXY=1 \
  -e HTTPS_PROXY=http://host.docker.internal:7890 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  --restart unless-stopped \
  "$IMAGE"

printf 'upstream app_backend {\n    server app-%s:3000;\n}\n' "$ACTIVE" > "$UPSTREAM"
docker kill -s HUP "$NGINX" 2>/dev/null || true

OK=false
for i in $(seq 1 20); do
  if docker exec "app-$ACTIVE" node -e "require('http').get('http://localhost:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    OK=true
    break
  fi
  sleep 1
done
if [ "$OK" != "true" ]; then
  echo "[restore] FAIL health"
  exit 1
fi

docker exec "app-$ACTIVE" node -e 'const k=process.env.LLM_API_KEY||""; console.log("LLM_API_KEY set:", !!k, "len:", k.length)'
curl -sf -o /dev/null -w "health:%{http_code}\n" http://localhost:3000/api/health
echo "[restore] Done — app-$ACTIVE has LLM env"
