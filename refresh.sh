#!/bin/bash
# refresh.sh -- one command for the Tel Aviv GBFS dossier.
#
#   ensure the poller is running  ->  rebuild the static site  ->  done
#
# Every generated file is written atomically by build.py (tmp file + rename), so
# a browser or a web server never sees a half-written page. Files that did not
# change keep their old bytes, which means an rsync/`git push` of site/ only
# moves what actually changed.
#
# Usage:
#   ./refresh.sh                 # single pass (start poller if needed, rebuild)
#   ./refresh.sh --no-poller     # rebuild only (offline / batch use)
#   ./refresh.sh --loop 600      # keep refreshing every 600 s
#   POLL_INTERVAL=15 ./refresh.sh
#
# Nothing outside this directory is read or written.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON:-python3}"
PIDF="$ROOT/data/poller.pid"
LOGD="$ROOT/data"
mkdir -p "$LOGD"

POLL_INTERVAL="${POLL_INTERVAL:-15}"
LOOP=0
NO_POLLER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --loop) LOOP="${2:-600}"; shift 2 ;;
    --no-poller) NO_POLLER=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ensure_poller() {
  [ "$NO_POLLER" = "1" ] && return 0
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
    return 0
  fi
  echo "$(date -u +%FT%TZ) starting poller (interval ${POLL_INTERVAL}s)" >> "$LOGD/refresh.log"
  # poller.py already appends every line to data/poller.log itself, so send the
  # duplicated stderr/stdout stream to a separate file.
  nohup setsid "$PY" "$ROOT/poller.py" --interval "$POLL_INTERVAL" \
      >> "$LOGD/poller.stderr.log" 2>&1 < /dev/null &
  sleep 1
}

run_once() {
  ensure_poller
  echo "$(date -u +%FT%TZ) build start" >> "$LOGD/refresh.log"
  if "$PY" "$ROOT/build.py" >> "$LOGD/refresh.log" 2>&1; then
    echo "$(date -u +%FT%TZ) build ok" >> "$LOGD/refresh.log"
  else
    echo "$(date -u +%FT%TZ) build FAILED (see $LOGD/refresh.log)" >> "$LOGD/refresh.log"
  fi
}

run_once
if [ "$LOOP" != "0" ]; then
  while true; do sleep "$LOOP"; run_once; done
fi
