#!/usr/bin/env bash
set -euo pipefail

log_root="${SYMPHONY_LOG_ROOT:-/var/lib/symphony/log}"
log_file="$log_root/symphony.log"
workflow_file="${SYMPHONY_WORKFLOW_FILE:-WORKFLOW.md}"

validate_workflow_path() {
  local candidate="$1"

  case "$candidate" in
    ""|/*|..|../*|*/../*|*/..)
      printf '%s\n' "workflow path must be non-empty, relative, and stay below /opt/symphony: $candidate" >&2
      exit 64
      ;;
  esac
}

validate_workflow_path "$workflow_file"

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

args=("$@")
workflow_index=-1
skip_next=0
for index in "${!args[@]}"; do
  if (( skip_next > 0 )); then
    skip_next=0
    continue
  fi

  case "${args[$index]}" in
    --logs-root|--port)
      skip_next=1
      ;;
    --logs-root=*|--port=*|--*)
      ;;
    *)
      workflow_index=$index
      ;;
  esac
done

if (( workflow_index < 0 )); then
  args+=("$workflow_file")
  workflow_index=$((${#args[@]} - 1))
elif [[ "${args[$workflow_index]}" == "__SYMPHONY_WORKFLOW_FILE__" ]]; then
  args[$workflow_index]="$workflow_file"
fi

validate_workflow_path "${args[$workflow_index]}"

bun run src/cli.ts "${args[@]}" >>"$log_file" 2>&1 &
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
