#!/usr/bin/env bash
set -euo pipefail

log_root="${SYMPHONY_LOG_ROOT:-/var/lib/symphony/log}"
log_file="$log_root/symphony.log"
mkdir -p "$log_root"

app_pid=0
tail_pid=0

stop_children() {
  if (( app_pid > 0 )) && kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid" 2>/dev/null || true
  fi
  if (( tail_pid > 0 )) && kill -0 "$tail_pid" 2>/dev/null; then
    kill -TERM "$tail_pid" 2>/dev/null || true
  fi
}

trap stop_children TERM INT

bun run src/cli.ts "$@" >>"$log_file" 2>&1 &
app_pid=$!
tail -n 0 -F "$log_file" &
tail_pid=$!

set +e
wait "$app_pid"
status=$?
set -e

if (( tail_pid > 0 )) && kill -0 "$tail_pid" 2>/dev/null; then
  kill -TERM "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
fi
trap - TERM INT
exit "$status"
