#!/bin/zsh

setopt ERR_EXIT NO_UNSET PIPE_FAIL

SCRIPT_DIR="${0:A:h}"
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -dimsu node "$SCRIPT_DIR/scripts/opn-rd-weekly-analyzer.js" "$@"
fi
exec node "$SCRIPT_DIR/scripts/opn-rd-weekly-analyzer.js" "$@"
