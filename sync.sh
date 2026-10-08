#!/bin/sh
# plugins/lotus is the source of truth. The five folders under skills/ are self-contained copies for agents that read SKILL.md
# directly (Codex, Cursor), each with its own core/. This copies the source into them, or with --check fails if any copy has drifted.
#   ./sync.sh          copy plugins/lotus/core and each SKILL.md into skills/<name>/
#   ./sync.sh --check  exit 1 and list the differences if a copy is out of date (for CI or a pre-commit hook)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="$HERE/plugins/lotus"; RC=0
for d in "$SRC"/skills/*/; do
  n="$(basename "$d")"; dst="$HERE/skills/$n"
  if [ "${1:-}" = "--check" ]; then
    diff -rq -x .claude "$SRC/core" "$dst/core" || RC=1
    diff -q "$SRC/skills/$n/SKILL.md" "$dst/SKILL.md" || RC=1
  else
    mkdir -p "$dst"; rm -rf "$dst/core"; cp -R "$SRC/core" "$dst/core"; cp "$SRC/skills/$n/SKILL.md" "$dst/SKILL.md"
  fi
done
[ "${1:-}" = "--check" ] && { [ $RC = 0 ] && echo "skills/ copies match plugins/lotus" || echo "skills/ copies are out of date: run ./sync.sh"; }
exit $RC
