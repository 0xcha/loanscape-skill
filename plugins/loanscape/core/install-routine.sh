#!/bin/sh
# Schedule the morning brief.  ./install-routine.sh [--at HH:MM] [--remove] [--dry-run]
# macOS: a launchd agent in ~/Library/LaunchAgents (survives reboots, runs when you're logged in).
# Linux: prints the crontab line to add. Nothing here needs an LLM or a token; it runs core/morning.sh.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AT="08:00"; REMOVE=0; DRY=0
while [ $# -gt 0 ]; do case "$1" in --at) AT="$2"; shift;; --remove) REMOVE=1;; --dry-run) DRY=1;; esac; shift; done
H="${AT%%:*}"; M="${AT##*:}"; case "$H$M" in *[!0-9]*) echo "bad time $AT (use HH:MM)"; exit 2;; esac
LABEL="net.lotuslabs.loanscape.brief"
if [ "$(uname)" = "Darwin" ]; then
  DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"; PLIST="$DIR/$LABEL.plist"
  if [ $REMOVE = 1 ]; then launchctl unload "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "Removed the morning brief."; exit 0; fi
  if [ $DRY = 1 ]; then TARGET="$PLIST"; PLIST="$(mktemp "${TMPDIR:-/tmp}/loanscape-plist.XXXXXX")"; else mkdir -p "$DIR"; fi
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$HERE/morning.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$((10#$H))</integer><key>Minute</key><integer>$((10#$M))</integer></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>$HOME</string></dict>
  <key>StandardOutPath</key><string>$HOME/.loanscape/launchd.out</string>
  <key>StandardErrorPath</key><string>$HOME/.loanscape/launchd.err</string>
  <key>RunAtLoad</key><false/>
</dict></plist>
PL
  if [ $DRY = 1 ]; then echo "Would install $TARGET (dry run):"; cat "$PLIST"; rm -f "$PLIST"; exit 0; fi
  launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST" && echo "Morning brief scheduled for $AT every day. Log: ~/.loanscape/brief.log. Remove with: $0 --remove"
else
  LINE="$((10#$M)) $((10#$H)) * * * /bin/sh $HERE/morning.sh >/dev/null 2>&1"
  if [ $REMOVE = 1 ]; then crontab -l 2>/dev/null | grep -v "morning.sh" | crontab -; echo "Removed the morning brief."; exit 0; fi
  if [ $DRY = 1 ]; then echo "Would add to crontab: $LINE"; exit 0; fi
  ( crontab -l 2>/dev/null | grep -v "morning.sh"; echo "$LINE" ) | crontab - && echo "Morning brief scheduled for $AT every day via cron. Log: ~/.loanscape/brief.log"
fi
