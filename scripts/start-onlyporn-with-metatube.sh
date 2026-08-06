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
LOG_MAX_BYTES="${ONLYPORN_LOG_MAX_BYTES:-10485760}"
LOG_KEEP_BYTES="${ONLYPORN_LOG_KEEP_BYTES:-5242880}"
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
TAIL_PID=""
LOG_GUARD_PID=""

shutdown() {
  set +e
  [[ -n "$PROXY_PID" ]] && kill -TERM "$PROXY_PID" 2>/dev/null
  [[ -n "$NODE_PID" ]] && kill -TERM "$NODE_PID" 2>/dev/null
  [[ -n "$METATUBE_PID" ]] && kill -TERM "$METATUBE_PID" 2>/dev/null
  [[ -n "$TAIL_PID" ]] && kill -TERM "$TAIL_PID" 2>/dev/null
  [[ -n "$LOG_GUARD_PID" ]] && kill -TERM "$LOG_GUARD_PID" 2>/dev/null
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
  -port "$METATUBE_PORT" \
  > "$LOG_DIR/metatube.log" 2>&1 &
METATUBE_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${METATUBE_PORT}/v1/providers" >/dev/null; then
    break
  fi
  if ! kill -0 "$METATUBE_PID" 2>/dev/null; then
    cat "$LOG_DIR/metatube.log" >&2 || true
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

PORT="$INTERNAL_PORT" node /app/server.js > "$LOG_DIR/onlyporn.log" 2>&1 &
NODE_PID=$!
touch "$LOG_DIR/onlyporn.log"
tail -n +1 -F "$LOG_DIR/onlyporn.log" &
TAIL_PID=$!

# Keep diagnostic files useful without allowing them to consume the ephemeral
# filesystem over a long Starter-service lifetime. Render still receives the
# live stdout stream; these files are only bounded local diagnostics.
(
  while sleep 300; do
    for log_file in "$LOG_DIR/metatube.log" "$LOG_DIR/onlyporn.log"; do
      [[ -f "$log_file" ]] || continue
      size="$(wc -c < "$log_file" 2>/dev/null || echo 0)"
      if [[ "$size" =~ ^[0-9]+$ ]] && (( size > LOG_MAX_BYTES )); then
        temporary="$log_file.trim.$$"
        tail -c "$LOG_KEEP_BYTES" "$log_file" > "$temporary" 2>/dev/null || continue
        cat "$temporary" > "$log_file"
        rm -f "$temporary"
      fi
    done
  done
) &
LOG_GUARD_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${INTERNAL_PORT}/manifest.json" >/dev/null; then
    break
  fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    cat "$LOG_DIR/onlyporn.log" >&2 || true
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
  kill -0 "$LOG_GUARD_PID" 2>/dev/null || exit 44
  sleep 2
done
