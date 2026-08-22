#!/bin/zsh

setopt ERR_EXIT NO_UNSET PIPE_FAIL

SCRIPT_DIR="${0:A:h}"
exec node "$SCRIPT_DIR/scripts/opn-rd-weekly-analyzer.js" "$@"
