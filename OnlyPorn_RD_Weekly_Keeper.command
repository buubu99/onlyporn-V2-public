#!/bin/zsh

setopt ERR_EXIT NO_UNSET PIPE_FAIL
umask 077

API="https://api.real-debrid.com/rest/1.0"
API_DELAY=1
MAX_ATTEMPTS=4
PAGE_LIMIT=5000
RESERVE_ACTIVE_SLOTS=10
STATE_DIR="${ONLYPORN_RD_STATE_DIR:-$HOME/Library/Application Support/OnlyPorn/RD-Weekly-Keeper}"

CHECK_ONLY=0
ASSUME_YES=0
FRESH=0
REPAIR_MISSING=1
AUDIT_REPORT=""
AIOSTREAM_CONFIG=""

usage() {
  echo "Usage: $0 [--check] [--yes] [--fresh] [--no-repair] [--report PATH] [--config PATH]"
}

while (( $# > 0 )); do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    --fresh) FRESH=1 ;;
    --no-repair) REPAIR_MISSING=0 ;;
    --report)
      (( $# >= 2 )) || { echo "ERROR: --report requires a path" >&2; exit 64; }
      AUDIT_REPORT="$2"
      shift
      ;;
    --config)
      (( $# >= 2 )) || { echo "ERROR: --config requires a path" >&2; exit 64; }
      AIOSTREAM_CONFIG="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

for command_name in curl jq shasum base64; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "ERROR: Required command is missing: $command_name" >&2
    [[ "$command_name" == "jq" ]] && echo "Install it with: brew install jq" >&2
    exit 1
  }
done

if [[ -z "$AUDIT_REPORT" ]]; then
  report_candidates=(
    /Users/Buubuu/Downloads/Sukebei-Monthly-RD/*/final_*original_vs_current*.json(N.om)
  )
  AUDIT_REPORT="${report_candidates[1]-}"
fi
if [[ -z "$AIOSTREAM_CONFIG" ]]; then
  config_candidates=(/Users/Buubuu/Downloads/aiostreams-config-*.json(N.om))
  AIOSTREAM_CONFIG="${config_candidates[1]-}"
fi

[[ -n "$AUDIT_REPORT" && -f "$AUDIT_REPORT" ]] || {
  echo "ERROR: No final OnlyPorn RD audit report was found." >&2
  exit 1
}
[[ -n "$AIOSTREAM_CONFIG" && -f "$AIOSTREAM_CONFIG" ]] || {
  echo "ERROR: No AIOStreams configuration JSON was found." >&2
  exit 1
}

RD_TOKEN="${RD_TOKEN-}"
if [[ -z "$RD_TOKEN" ]]; then
  RD_TOKEN="$(jq -er '
    first(
      .services[]?
      | select((.id // "" | ascii_downcase) == "realdebrid")
      | .credentials.apiKey
      | select(type == "string" and length >= 16)
    )
  ' "$AIOSTREAM_CONFIG" 2>/dev/null || true)"
fi
[[ ${#RD_TOKEN} -ge 16 ]] || {
  echo "ERROR: A Real-Debrid credential was not found in the AIOStreams config." >&2
  echo "The token was not printed or stored." >&2
  exit 1
}

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
LOCK_DIR="$STATE_DIR/run.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID=""
  [[ -r "$LOCK_DIR/pid" ]] && read -r LOCK_PID < "$LOCK_DIR/pid"
  if [[ "$LOCK_PID" == <-> ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "ERROR: Another weekly keeper process is already running (PID $LOCK_PID)." >&2
    exit 1
  fi
  [[ -z "$LOCK_PID" ]] || rm -f "$LOCK_DIR/pid"
  if ! rmdir "$LOCK_DIR" 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "ERROR: The weekly keeper lock could not be reclaimed safely: $LOCK_DIR" >&2
    exit 1
  fi
  echo "Recovered a stale weekly keeper lock from an earlier interrupted run."
fi
print -r -- "$$" > "$LOCK_DIR/pid"
stale_tmp_dirs=("$STATE_DIR"/tmp.*(N/))
for stale_tmp_dir in "${stale_tmp_dirs[@]}"; do
  [[ "$stale_tmp_dir" == "$STATE_DIR"/tmp.* ]] || {
    echo "ERROR: Refusing unsafe temporary cleanup path: $stale_tmp_dir" >&2
    exit 1
  }
  rm -rf -- "$stale_tmp_dir"
done
TMP_DIR="$(mktemp -d "$STATE_DIR/tmp.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

TARGETS_FILE="$TMP_DIR/targets.tsv"
CURRENT_FILE="$TMP_DIR/current.jsonl"
INDEX_FILE="$TMP_DIR/current-index.tsv"
API_BODY="$TMP_DIR/api.json"
INFO_FILE="$TMP_DIR/info.json"

REPORT_SHA="$(shasum -a 256 "$AUDIT_REPORT" | awk '{print $1}')"
REPORT_CODES="$(jq -er '
  [(.records // [])[]
   | select(.final_state == "COMPLETE" and .status == "downloaded")
   | select((.current_hash // "") | test("^[A-Fa-f0-9]{40}$"))]
  | length
' "$AUDIT_REPORT")"
[[ "$REPORT_CODES" -gt 0 ]] || {
  echo "ERROR: The audit report contains no verified downloaded hashes." >&2
  exit 1
}

jq -er '
  [(.records // [])[]
   | select(.final_state == "COMPLETE" and .status == "downloaded")
   | select((.current_hash // "") | test("^[A-Fa-f0-9]{40}$"))
   | {code: ((.code // "") | ascii_upcase), hash: (.current_hash | ascii_upcase)}]
  | sort_by(.hash)
  | group_by(.hash)[]
  | [([.[].code] | unique | join(",")), .[0].hash]
  | @tsv
' "$AUDIT_REPORT" > "$TARGETS_FILE"
TARGET_HASHES="$(wc -l < "$TARGETS_FILE" | tr -d ' ')"

WEEK_KEY="$(date -u +%G-W%V)"
RUN_KEY="${WEEK_KEY}-${REPORT_SHA[1,12]}"
CHECKPOINT="$STATE_DIR/completed-$RUN_KEY.txt"
HISTORY="$STATE_DIR/history.jsonl"
LAST_SUMMARY="$STATE_DIR/last-summary.json"
touch "$CHECKPOINT" "$HISTORY"
chmod 600 "$CHECKPOINT" "$HISTORY"
(( FRESH == 1 )) && : > "$CHECKPOINT"

echo
echo "OnlyPorn Real-Debrid Weekly Keeper"
echo "Report:       ${AUDIT_REPORT:t}"
echo "Config:       ${AIOSTREAM_CONFIG:t}"
echo "Verified:     $REPORT_CODES code mappings"
echo "Unique hash:  $TARGET_HASHES"
echo "Week:         $WEEK_KEY"
echo "API pacing:   <= 60 authenticated requests/minute"
echo "Repair mode:  $([[ $REPAIR_MISSING == 1 ]] && echo missing-only || echo disabled)"
echo "The RD token and generated direct links are never logged."

if (( CHECK_ONLY == 1 )); then
  echo "CHECK PASSED: report, credential location, dependencies and targets are valid."
  exit 0
fi

if (( ASSUME_YES == 0 )); then
  echo
  echo "Disconnect any VPN before continuing."
  echo "Only the audited OnlyPorn hashes will be inspected and freshness-probed."
  (( REPAIR_MISSING == 1 )) &&
    echo "A missing audited hash may be re-added and its matching video selected."
  printf "Continue? [y/N] "
  read -r answer
  [[ "$answer" == [Yy]* ]] || {
    echo "Cancelled. No RD request was made."
    exit 0
  }
fi

LAST_API_ERROR=""
api_request() {
  local method="$1"
  local endpoint="$2"
  local outfile="$3"
  shift 3
  local attempt=1 http="" rc=0 wait_seconds=0
  LAST_API_ERROR=""
  while (( attempt <= MAX_ATTEMPTS )); do
    set +e
    http="$(curl -sS --connect-timeout 15 --max-time 45 \
      -X "$method" -o "$outfile" -w "%{http_code}" \
      -H "Authorization: Bearer $RD_TOKEN" "$@" "$API/$endpoint")"
    rc=$?
    set -e
    if (( rc != 0 )); then
      LAST_API_ERROR="network error (curl $rc)"
      wait_seconds=$((attempt * 10))
    elif [[ "$http" == 2?? ]]; then
      sleep "$API_DELAY"
      return 0
    elif [[ "$http" == "401" || "$http" == "403" ]]; then
      LAST_API_ERROR="$(jq -r '.error // "authentication/permission failure"' "$outfile" 2>/dev/null || echo authentication-failure)"
      echo "ERROR: RD refused authentication or this IP: HTTP $http — $LAST_API_ERROR" >&2
      exit 1
    elif [[ "$http" == "429" ]]; then
      LAST_API_ERROR="RD rate limit"
      wait_seconds=65
    elif [[ "$http" == 5?? ]]; then
      LAST_API_ERROR="$(jq -r '.error // "temporary RD server error"' "$outfile" 2>/dev/null || echo temporary-server-error)"
      wait_seconds=$((attempt * 15))
    else
      LAST_API_ERROR="$(jq -r '.error // "RD request failed"' "$outfile" 2>/dev/null || echo request-failed)"
      sleep "$API_DELAY"
      return 1
    fi
    echo "RD retry $attempt/$MAX_ATTEMPTS in ${wait_seconds}s: $LAST_API_ERROR" >&2
    sleep "$wait_seconds"
    attempt=$((attempt + 1))
  done
  return 1
}

record_event() {
  jq -cn \
    --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg week "$WEEK_KEY" --arg report_sha "$REPORT_SHA" \
    --arg code "$1" --arg hash "$2" --arg result "$3" --arg detail "${4-}" \
    '{time:$time,week:$week,reportSha256:$report_sha,code:$code,hash:$hash,result:$result,detail:$detail}' \
    >> "$HISTORY"
}
mark_completed() {
  grep -Fqx "$1" "$CHECKPOINT" 2>/dev/null || print -r -- "$1" >> "$CHECKPOINT"
}
decode_row() {
  if ! print -rn -- "$1" | base64 -D 2>/dev/null; then
    print -rn -- "$1" | base64 -d
  fi
}

touch_original_link() {
  local original_link="$1"
  local response="$TMP_DIR/unrestrict.json"
  local download="" meta="" rc=0 http="" bytes=""
  api_request POST "unrestrict/link" "$response" \
    --data-urlencode "link=$original_link" --data-urlencode "remote=0" || return 1
  download="$(jq -r '.download // empty' "$response" 2>/dev/null || true)"
  [[ -n "$download" ]] || {
    LAST_API_ERROR="RD returned no generated download link"
    return 1
  }
  set +e
  meta="$(curl -sS -L --range 0-0 --max-filesize 1024 \
    --connect-timeout 15 --max-time 30 -o /dev/null \
    -w "%{http_code} %{size_download}" "$download" 2>/dev/null)"
  rc=$?
  set -e
  unset download
  http="${meta%% *}"
  bytes="${meta##* }"
  if (( rc == 0 )) &&
     [[ "$http" == "200" || "$http" == "206" ]] &&
     awk "BEGIN {exit !(${bytes:-999999} <= 1024)}"; then
    return 0
  fi
  LAST_API_ERROR="one-byte probe failed (HTTP ${http:-000}, curl $rc)"
  return 1
}

choose_video_files() {
  jq -r --arg code "$1" '
    def norm: ascii_upcase | gsub("[^A-Z0-9]"; "");
    ($code | split(",")[0] | norm) as $wanted
    | [(.files // [])[]
       | select((.path // "" | ascii_downcase) | test("\\.(mp4|mkv|avi|mov|m4v|wmv|webm|ts)$"))
       | {id:.id,bytes:(.bytes // 0),exact:(((.path // "") | norm) | contains($wanted))}] as $videos
    | ([$videos[] | select(.exact)] | sort_by(-.bytes)) as $exact
    | (if ($exact|length)>0 then $exact else ($videos|sort_by(-.bytes)|.[0:1]) end)
    | .[0:3] | map(.id) | join(",")
  ' "$2"
}

REPAIR_LINK=""
repair_missing_hash() {
  local codes="$1" hash="$2"
  local active_file="$TMP_DIR/active.json" add_file="$TMP_DIR/add.json"
  local select_file="$TMP_DIR/select.json"
  local active=0 limit=0 torrent_id="" ids="" torrent_status="" link="" poll=1
  REPAIR_LINK=""
  api_request GET "torrents/activeCount" "$active_file" || return 1
  active="$(jq -r '.nb // 0' "$active_file")"
  limit="$(jq -r '.limit // 0' "$active_file")"
  if (( limit > 0 && active >= limit - RESERVE_ACTIVE_SLOTS )); then
    LAST_API_ERROR="repair deferred: active reserve reached ($active/$limit)"
    return 2
  fi
  api_request POST "torrents/addMagnet" "$add_file" \
    --data-urlencode "magnet=magnet:?xt=urn:btih:$hash" || return 1
  torrent_id="$(jq -r '.id // empty' "$add_file" 2>/dev/null || true)"
  [[ -n "$torrent_id" ]] || {
    LAST_API_ERROR="RD returned no torrent ID"
    return 1
  }
  for poll in {1..6}; do
    if api_request GET "torrents/info/$torrent_id" "$INFO_FILE"; then
      ids="$(choose_video_files "$codes" "$INFO_FILE")"
      [[ -n "$ids" ]] && break
    fi
    sleep 5
  done
  [[ -n "$ids" ]] || {
    LAST_API_ERROR="torrent metadata contains no selectable video"
    return 2
  }
  api_request POST "torrents/selectFiles/$torrent_id" "$select_file" \
    --data-urlencode "files=$ids" || return 1
  for poll in {1..5}; do
    sleep 12
    api_request GET "torrents/info/$torrent_id" "$INFO_FILE" || continue
    torrent_status="$(jq -r '.status // "unknown"' "$INFO_FILE")"
    if [[ "$torrent_status" == "downloaded" ]]; then
      link="$(jq -r '.links[0] // empty' "$INFO_FILE")"
      if [[ -n "$link" ]]; then
        REPAIR_LINK="$link"
        return 0
      fi
    fi
    if [[ "$torrent_status" == "dead" || "$torrent_status" == "error" ||
          "$torrent_status" == "magnet_error" || "$torrent_status" == "virus" ]]; then
      LAST_API_ERROR="re-added torrent became $torrent_status"
      return 1
    fi
  done
  LAST_API_ERROR="repair submitted; RD status is ${torrent_status:-pending}"
  return 2
}

echo
echo "Authenticating and reading the complete RD torrent library..."
api_request GET "user" "$API_BODY"
[[ "$(jq -r '.type // "unknown"' "$API_BODY")" == "premium" ]] || {
  echo "ERROR: RD account is not currently premium." >&2
  exit 1
}

: > "$CURRENT_FILE"
page=1
while true; do
  page_file="$TMP_DIR/page-$page.json"
  echo "  RD page $page"
  api_request GET "torrents?page=$page&limit=$PAGE_LIMIT" "$page_file"
  count="$(jq -er 'if type=="array" then length else error("not array") end' "$page_file")"
  (( count == 0 )) && break
  jq -c '.[]' "$page_file" >> "$CURRENT_FILE"
  (( count < PAGE_LIMIT )) && break
  page=$((page + 1))
done
CURRENT_COUNT="$(wc -l < "$CURRENT_FILE" | tr -d ' ')"

jq -rsc '
  group_by((.hash // "") | ascii_upcase)[]
  | sort_by(if (.status=="downloaded" and ((.links//[])|length)>0) then 0 else 1 end)
  | .[0]
  | [((.hash // "") | ascii_upcase), (. | @base64)]
  | @tsv
' "$CURRENT_FILE" > "$INDEX_FILE"

typeset -A RD_ROWS
while IFS=$'\t' read -r indexed_hash encoded_row; do
  [[ -n "$indexed_hash" && -n "$encoded_row" ]] || continue
  RD_ROWS[$indexed_hash]="$encoded_row"
done < "$INDEX_FILE"

echo "Current RD entries: $CURRENT_COUNT"
echo "Beginning exact audited-hash maintenance..."
echo

touched=0
already_done=0
missing=0
repaired=0
scheduled=0
unhealthy=0
failed=0
position=0

while IFS=$'\t' read -r codes hash; do
  [[ -n "$hash" ]] || continue
  position=$((position + 1))
  if grep -Fqx "$hash" "$CHECKPOINT" 2>/dev/null; then
    already_done=$((already_done + 1))
    continue
  fi
  encoded="${RD_ROWS[$hash]-}"
  if [[ -n "$encoded" ]]; then
    row="$(decode_row "$encoded")"
    torrent_status="$(print -r -- "$row" | jq -r '.status // "unknown"')"
    link="$(print -r -- "$row" | jq -r '.links[0] // empty')"
    name="$(print -r -- "$row" | jq -r '.filename // "unknown"')"
    if [[ "$torrent_status" == "downloaded" && -n "$link" ]]; then
      if touch_original_link "$link"; then
        touched=$((touched + 1))
        mark_completed "$hash"
        record_event "$codes" "$hash" "TOUCH_OK" "$name"
        echo "[$position/$TARGET_HASHES] OK $codes"
      else
        failed=$((failed + 1))
        record_event "$codes" "$hash" "TOUCH_FAILED" "$LAST_API_ERROR"
        echo "[$position/$TARGET_HASHES] FAILED $codes — $LAST_API_ERROR"
      fi
    else
      unhealthy=$((unhealthy + 1))
      record_event "$codes" "$hash" "PRESENT_NOT_READY" "$torrent_status"
      echo "[$position/$TARGET_HASHES] NOT READY $codes — $torrent_status"
    fi
    unset row link
    continue
  fi

  missing=$((missing + 1))
  if (( REPAIR_MISSING == 0 )); then
    record_event "$codes" "$hash" "MISSING_REPAIR_DISABLED" ""
    echo "[$position/$TARGET_HASHES] MISSING $codes — repair disabled"
    continue
  fi
  set +e
  repair_missing_hash "$codes" "$hash"
  repair_rc=$?
  set -e
  if (( repair_rc == 0 )); then
    repaired=$((repaired + 1))
    if touch_original_link "$REPAIR_LINK"; then
      touched=$((touched + 1))
      mark_completed "$hash"
      record_event "$codes" "$hash" "REPAIRED_AND_TOUCHED" ""
      echo "[$position/$TARGET_HASHES] REPAIRED $codes"
    else
      failed=$((failed + 1))
      record_event "$codes" "$hash" "REPAIR_TOUCH_FAILED" "$LAST_API_ERROR"
      echo "[$position/$TARGET_HASHES] REPAIRED BUT TOUCH FAILED $codes"
    fi
  elif (( repair_rc == 2 )); then
    scheduled=$((scheduled + 1))
    record_event "$codes" "$hash" "REPAIR_PENDING" "$LAST_API_ERROR"
    echo "[$position/$TARGET_HASHES] PENDING $codes — $LAST_API_ERROR"
  else
    failed=$((failed + 1))
    record_event "$codes" "$hash" "REPAIR_FAILED" "$LAST_API_ERROR"
    echo "[$position/$TARGET_HASHES] REPAIR FAILED $codes — $LAST_API_ERROR"
  fi
done < "$TARGETS_FILE"

completed_total="$(sort -u "$CHECKPOINT" | wc -l | tr -d ' ')"
jq -n \
  --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg week "$WEEK_KEY" --arg report "$AUDIT_REPORT" --arg reportSha256 "$REPORT_SHA" \
  --argjson verifiedCodes "$REPORT_CODES" --argjson targetHashes "$TARGET_HASHES" \
  --argjson rdEntries "$CURRENT_COUNT" --argjson touched "$touched" \
  --argjson alreadyDone "$already_done" --argjson completedThisWeek "$completed_total" \
  --argjson missing "$missing" --argjson repaired "$repaired" \
  --argjson repairPending "$scheduled" --argjson unhealthy "$unhealthy" \
  --argjson failed "$failed" \
  '{finishedAt:$finishedAt,week:$week,report:$report,reportSha256:$reportSha256,
    verifiedCodes:$verifiedCodes,targetHashes:$targetHashes,rdEntries:$rdEntries,
    touched:$touched,alreadyDone:$alreadyDone,completedThisWeek:$completedThisWeek,
    missing:$missing,repaired:$repaired,repairPending:$repairPending,
    unhealthy:$unhealthy,failed:$failed}' > "$TMP_DIR/summary.json"
mv "$TMP_DIR/summary.json" "$LAST_SUMMARY"
chmod 600 "$LAST_SUMMARY"

echo
echo "=================================================="
echo "WEEKLY KEEPER FINISHED"
echo "=================================================="
echo "Audited codes:          $REPORT_CODES"
echo "Unique target hashes:   $TARGET_HASHES"
echo "Freshness probes OK:    $touched"
echo "Already done this week: $already_done"
echo "Missing from RD:        $missing"
echo "Repaired now:           $repaired"
echo "Repair still pending:   $scheduled"
echo "Present but not ready:  $unhealthy"
echo "Failures to retry:      $failed"
echo "Summary: $LAST_SUMMARY"
echo "History: $HISTORY"
echo
echo "A successful probe confirms current playability, but RD documents no"
echo "permanent cache-retention guarantee. Run this once per week."

if (( failed > 0 || scheduled > 0 || unhealthy > 0 )); then
  echo "Run the same command again later this week; successful hashes are skipped."
  exit 2
fi
