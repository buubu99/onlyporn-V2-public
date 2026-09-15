#!/usr/bin/env bash
set -Eeuo pipefail

METATUBE_PORT="${METATUBE_PORT:-18080}"
PUBLIC_PORT="${PORT:-10000}"
INTERNAL_PORT="${INTERNAL_ONLYPORN_PORT:-10001}"
RUNTIME_ROOT="${ONLYPORN_RUNTIME_DIR:-/tmp/onlyporn-runtime}"
METATUBE_DIR="$RUNTIME_ROOT/metatube"
CACHE_DIR="${ONLYPORN_PERSISTENT_CACHE_DIR:-$RUNTIME_ROOT/cache}"
LOG_DIR="${ONLYPORN_PROCESS_LOG_DIR:-$RUNTIME_ROOT/logs}"
TMP_DIR="$RUNTIME_ROOT/tmp"
METATUBE_DB="${METATUBE_DB:-$METATUBE_DIR/metatube.db}"
MIN_FREE_MB="${ONLYPORN_EPHEMERAL_MIN_FREE_MB:-2048}"
PROXY_SECRET="${TPB4K_METATUBE_PROXY_SECRET:-}"

case "$RUNTIME_ROOT" in
  /tmp/*) ;;
  *) echo "Runtime root must stay on Render's ephemeral /tmp filesystem: $RUNTIME_ROOT" >&2; exit 20 ;;
esac
case "$METATUBE_DB" in
  "$RUNTIME_ROOT"/*) ;;
  *) echo "MetaTube DSN must be a file under $RUNTIME_ROOT: $METATUBE_DB" >&2; exit 21 ;;
esac

install -d -m 0700 "$RUNTIME_ROOT" "$METATUBE_DIR" "$CACHE_DIR" "$LOG_DIR" "$TMP_DIR"
FS_TYPE="$(stat -f -c '%T' "$RUNTIME_ROOT" 2>/dev/null || echo unknown)"
case "$FS_TYPE" in
  tmpfs|ramfs)
    echo "Refusing RAM-backed MetaTube SQLite storage: $RUNTIME_ROOT is $FS_TYPE" >&2
    exit 22
    ;;
  ext2|ext3|ext4|ext2/ext3|xfs|btrfs|overlay|overlayfs)
    ;;
  *)
    echo "Refusing unknown runtime filesystem type: $FS_TYPE" >&2
    exit 23
    ;;
esac
AVAILABLE_KB="$(df -Pk "$RUNTIME_ROOT" | awk 'NR==2 {print $4}')"
REQUIRED_KB="$((MIN_FREE_MB * 1024))"
[[ "$AVAILABLE_KB" =~ ^[0-9]+$ ]] || { echo "Could not determine ephemeral free space" >&2; exit 24; }
(( AVAILABLE_KB >= REQUIRED_KB )) || {
  echo "Ephemeral storage is too low: ${AVAILABLE_KB} KiB available, ${REQUIRED_KB} KiB required" >&2
  exit 25
}
(( ${#PROXY_SECRET} >= 32 )) || {
  echo "TPB4K_METATUBE_PROXY_SECRET must contain at least 32 characters" >&2
  exit 26
}

# Force MetaTube into file-backed SQLite mode. These values are intentionally
# not inherited from an old Render environment that could select memory mode.
export DSN="$METATUBE_DB"
export DB_AUTO_MIGRATE=true
export DB_MAX_OPEN_CONNS=1
export DB_MAX_IDLE_CONNS=1
export DB_PREPARED_STMT=false
export ONLYPORN_PERSISTENT_CACHE_DIR="$CACHE_DIR"
export ONLYPORN_CACHE_DIR="$CACHE_DIR"
export ONLYPORN_DISABLE_PERSISTENT_CACHE=false
export ONLYPORN_PROCESS_LOG_DIR="$LOG_DIR"
export TMPDIR="$TMP_DIR"

printf 'OnlyPorn runtime storage: root=%s fstype=%s freeMiB=%s db=%s cache=%s logs=%s\n' \
  "$RUNTIME_ROOT" "$FS_TYPE" "$((AVAILABLE_KB / 1024))" "$METATUBE_DB" "$CACHE_DIR" "$LOG_DIR"

METATUBE_PID=""
NODE_PID=""
PROXY_PID=""

shutdown() {
  set +e
  [[ -n "$PROXY_PID" ]] && kill -TERM "$PROXY_PID" 2>/dev/null
  [[ -n "$NODE_PID" ]] && kill -TERM "$NODE_PID" 2>/dev/null
  [[ -n "$METATUBE_PID" ]] && kill -TERM "$METATUBE_PID" 2>/dev/null
  wait 2>/dev/null
}
trap shutdown INT TERM EXIT

cd /app

# Bind Render's public PORT before any dependency startup. Until Node is ready,
# the proxy returns 502 and /onlyporn/ready remains unhealthy, so the previous
# live instance continues serving traffic while this candidate initializes.
PUBLIC_PORT="$PUBLIC_PORT" INTERNAL_ONLYPORN_PORT="$INTERNAL_PORT" \
  node /app/scripts/public-gate-proxy.js &
PROXY_PID=$!
sleep 1
kill -0 "$PROXY_PID" 2>/dev/null || { echo "Public gate proxy failed to bind" >&2; exit 27; }

/usr/local/bin/metatube-server \
  -dsn "$METATUBE_DB" \
  -port "$METATUBE_PORT" &
METATUBE_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${METATUBE_PORT}/v1/providers" >/dev/null; then
    break
  fi
  if ! kill -0 "$METATUBE_PID" 2>/dev/null; then
    exit 31
  fi
  sleep 1
done
curl -fsS --max-time 5 "http://127.0.0.1:${METATUBE_PORT}/v1/providers" >/dev/null || exit 32

# Auto-migration must have created a genuine file-backed SQLite database.
for _ in $(seq 1 30); do
  [[ -s "$METATUBE_DB" ]] && break
  sleep 1
done
[[ -s "$METATUBE_DB" ]] || { echo "MetaTube SQLite file was not created" >&2; exit 35; }
[[ "$(od -An -tx1 -N16 "$METATUBE_DB" 2>/dev/null | tr -d ' \n')" == "53514c69746520666f726d6174203300" ]] || {
  echo "MetaTube database is not a SQLite file: $METATUBE_DB" >&2
  exit 36
}

# Keep application output attached to the container. Docker owns bounded log
# rotation, avoiding stale tail forwarders and sparse files caused by truncating
# a pathname while long-lived writers still hold an older file offset.
PORT="$INTERNAL_PORT" node /app/server.js &
NODE_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${INTERNAL_PORT}/manifest.json" >/dev/null; then
    break
  fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    exit 33
  fi
  sleep 1
done
curl -fsS --max-time 5 "http://127.0.0.1:${INTERNAL_PORT}/manifest.json" >/dev/null || exit 34

if [[ "${ONLYPORN_PUBLIC_GATE_BYPASS:-false}" != "true" ]]; then
  echo "OnlyPorn public port is bound; /onlyporn/ready remains the deployment gate."
fi

while true; do
  kill -0 "$METATUBE_PID" 2>/dev/null || exit 41
  kill -0 "$NODE_PID" 2>/dev/null || exit 42
  kill -0 "$PROXY_PID" 2>/dev/null || exit 43
  sleep 2
done
