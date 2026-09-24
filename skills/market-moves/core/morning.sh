#!/bin/sh
# The morning brief, no LLM involved: runs brief.mjs for the remembered wallet, appends to a log, and pops a notification
# with the first line (macOS via osascript; Linux via notify-send if present). Installed on a schedule by install-routine.sh.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${LOANSCAPE_HOME:-$HOME/.loanscape}"
LOG="$HOME_DIR/brief.log"
mkdir -p "$HOME_DIR"
NODE="$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)"
[ -n "$NODE" ] || { echo "node not found" >> "$LOG"; exit 1; }
OUT="$("$NODE" "$HERE/brief.mjs" 2>/dev/null)"
[ "$OUT" = "NEED_WALLET" ] && OUT="No wallet remembered yet. Run /loanscape <wallet> once in Claude Code."
[ -n "$OUT" ] || OUT="Loanscape couldn't run this morning, so your positions weren't checked. Run /loanscape to try again."
{ echo "== $(date '+%Y-%m-%d %H:%M')"; echo "$OUT"; echo; } >> "$LOG"
FIRST="$(printf '%s\n' "$OUT" | head -1 | sed 's/"/\\"/g')"
if command -v osascript >/dev/null 2>&1; then osascript -e "display notification \"$FIRST\" with title \"Loanscape\" subtitle \"Morning brief\"" >/dev/null 2>&1
elif command -v notify-send >/dev/null 2>&1; then notify-send "Loanscape" "$FIRST"; fi
printf '%s\n' "$OUT"
