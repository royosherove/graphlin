#!/bin/sh
# Keep import/runtime/launcher errors out of the host conversation as well.
exec 2>/dev/null
base=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || exit 0
entry="$base/collector.mjs"
[ -r "$entry" ] || exit 0
runtime=${GRAPHLIN_NODE:-node}
command -v "$runtime" >/dev/null 2>&1 || exit 0
exec 3<&0
"$runtime" "$entry" "${1:-claude}" <&3 >/dev/null 2>&1 &
collector_pid=$!
# The watchdog also bounds a broken executable before the JS deadline starts.
(
  sleep 1
  kill -TERM "$collector_pid" 2>/dev/null || exit 0
  sleep 0.2
  kill -KILL "$collector_pid" 2>/dev/null
) >/dev/null 2>&1 &
watchdog_pid=$!
wait "$collector_pid" 2>/dev/null
kill -KILL "$watchdog_pid" 2>/dev/null
wait "$watchdog_pid" 2>/dev/null
exit 0
