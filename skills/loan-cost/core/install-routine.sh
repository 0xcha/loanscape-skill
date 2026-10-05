#!/bin/sh
# Schedule the morning brief.  ./install-routine.sh [--at HH:MM] [--remove] [--dry-run]
# macOS: a launchd agent in ~/Library/LaunchAgents (survives reboots, runs when you're logged in).
# Linux: one crontab line, tagged with MARK below. Nothing here needs an LLM or a token; it runs core/morning.sh.
# The job runs a copy of core/ under $LOANSCAPE_HOME/bin, because the plugin folder this script lives in is versioned and the old
# version is pruned on update, which would leave the job pointing at nothing. Every install refreshes the copy.
# Safety: only lines ending in MARK are ever added or removed; every other crontab line is kept as it is. The current crontab
# (or plist) is backed up to $LOANSCAPE_HOME (default ~/.loanscape) before any change. --dry-run prints the change and writes nothing.
# Running it twice is the same as running it once.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AT="08:00"; REMOVE=0; DRY=0
usage() { echo "usage: $0 [--at HH:MM] [--remove] [--dry-run]"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --at) [ $# -ge 2 ] || usage; AT="$2"; shift;;
    --remove) REMOVE=1;;
    --dry-run) DRY=1;;
    *) echo "unknown option: $1"; usage;;
  esac
  shift
done
case "$AT" in [0-9]:[0-9][0-9]|[0-9][0-9]:[0-9][0-9]) ;; *) echo "bad time $AT (use HH:MM)"; exit 2;; esac
H=$(expr "${AT%%:*}" + 0); M=$(expr "${AT#*:}" + 0) # decimal, so 08 and 09 work in any /bin/sh (no bash-only 10#)
if [ "$H" -gt 23 ] || [ "$M" -gt 59 ]; then echo "bad time $AT (use HH:MM)"; exit 2; fi
LABEL="net.lotuslabs.loanscape.brief"
MARK="# loanscape-morning-brief"; MARK_RE=" $MARK\$" # ours = ends in the marker, so a line that merely mentions it is not ours
STATE="${LOANSCAPE_HOME:-$HOME/.loanscape}"
STAMP="$(date '+%Y%m%d-%H%M%S')"
BIN="$STATE/bin/core"; RUN="$BIN/morning.sh"
refresh_copy() { [ $DRY = 1 ] && return 0; mkdir -p "$STATE/bin" && rm -rf "$BIN.new" && cp -R "$HERE" "$BIN.new" && rm -rf "$BIN" && mv "$BIN.new" "$BIN" || { echo "Couldn't copy the scripts to $BIN, so nothing changed."; exit 1; }; }
[ $REMOVE = 1 ] || refresh_copy

if [ "$(uname)" = "Darwin" ]; then
  DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"; PLIST="$DIR/$LABEL.plist"
  plist() { cat <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$RUN</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$H</integer><key>Minute</key><integer>$M</integer></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>$HOME</string><key>LOANSCAPE_HOME</key><string>$STATE</string></dict>
  <key>StandardOutPath</key><string>$HOME/.loanscape/launchd.out</string>
  <key>StandardErrorPath</key><string>$HOME/.loanscape/launchd.err</string>
  <key>RunAtLoad</key><false/>
</dict></plist>
PL
  }
  backup() { [ -f "$PLIST" ] || return 0; mkdir -p "$STATE" && cp "$PLIST" "$STATE/$LABEL.plist.bak-$STAMP" || { echo "Couldn't back up $PLIST, so nothing changed."; exit 1; }; echo "Backed up the old agent to $STATE/$LABEL.plist.bak-$STAMP"; }
  if [ $REMOVE = 1 ]; then
    if [ ! -f "$PLIST" ]; then echo "No morning brief is scheduled; nothing changed."; exit 0; fi
    if [ $DRY = 1 ]; then echo "Would unload and remove $PLIST (dry run, nothing changed)."; exit 0; fi
    backup; launchctl unload "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "Removed the morning brief."; exit 0
  fi
  if [ -f "$PLIST" ] && [ "$(plist)" = "$(cat "$PLIST")" ]; then echo "The morning brief is already scheduled for $AT; the scripts it runs were refreshed, nothing else changed."; exit 0; fi
  if [ $DRY = 1 ]; then echo "Would install $PLIST (dry run, nothing changed):"; plist; exit 0; fi
  backup; mkdir -p "$DIR"; plist > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST" && echo "Morning brief scheduled for $AT every day. Log: ~/.loanscape/brief.log. Remove with: $0 --remove"
  exit $?
fi

# Linux: cron. The path is quoted in the line; cron treats % as a newline, and a quote, $, ` or \ would break the quoting.
case "$STATE" in *[%\"\$\`\\]*) echo "Can't schedule from $STATE: the path has a character cron can't take (% \" \$ \` \\). Set LOANSCAPE_HOME to a plain path and run this again."; exit 1;; esac
LINE="$M $H * * * LOANSCAPE_HOME=\"$STATE\" /bin/sh \"$RUN\" >/dev/null 2>&1 $MARK"
# Read the crontab. "No crontab yet" is an empty one; any other failure stops here, so a crontab we couldn't read is never overwritten.
if CUR="$(crontab -l 2>/dev/null)"; then :; else
  ERR="$(crontab -l 2>&1 >/dev/null)"
  case "$ERR" in *"no crontab"*) CUR="";; *) echo "Couldn't read your crontab${ERR:+ ($ERR)}, so nothing changed."; exit 1;; esac
fi
OURS="$(printf '%s\n' "$CUR" | grep -e "$MARK_RE")"
KEEP="$(printf '%s\n' "$CUR" | grep -v -e "$MARK_RE")"
# Lines from versions before the marker are left alone (we can't tell them from your own lines for sure); say so once.
OLD="$(printf '%s\n' "$KEEP" | grep -E '^[0-9]+ [0-9]+ \* \* \* /bin/sh .*/core/morning\.sh >/dev/null 2>&1$')"
old_note() { [ -n "$OLD" ] && printf 'Left alone, from an older install without the marker (remove it with crontab -e if you want only one brief):\n%s\n' "$OLD"; return 0; }
if [ $REMOVE = 1 ]; then
  [ -n "$OURS" ] || { echo "No morning brief is scheduled in your crontab; nothing changed."; old_note; exit 0; }
  NEW="$KEEP"; DID="Removed the morning brief."; WOULD="Would remove from your crontab (dry run, nothing changed):"; SHOW="$OURS"
else
  [ "$OURS" = "$LINE" ] && { echo "The morning brief is already scheduled for $AT; the scripts it runs were refreshed, nothing else changed."; old_note; exit 0; }
  if [ -n "$KEEP" ]; then NEW="$KEEP
$LINE"; else NEW="$LINE"; fi
  DID="Morning brief scheduled for $AT every day via cron. Log: ~/.loanscape/brief.log. Remove with: $0 --remove"
  if [ -n "$OURS" ]; then WOULD="Would replace the Loanscape line in your crontab with this (dry run, nothing changed):"; else WOULD="Would add this to your crontab (dry run, nothing changed):"; fi; SHOW="$LINE"
fi
if [ $DRY = 1 ]; then echo "$WOULD"; echo "$SHOW"; old_note; exit 0; fi
if [ -n "$CUR" ]; then
  mkdir -p "$STATE" && crontab -l > "$STATE/crontab.bak-$STAMP" || { echo "Couldn't back up your crontab to $STATE, so nothing changed."; exit 1; }
fi
if [ -n "$NEW" ]; then printf '%s\n' "$NEW"; fi | crontab - || { echo "crontab refused the change; your crontab is as it was."; exit 1; }
# Check it took: our line is there after an install and gone after a remove.
N=$(crontab -l 2>/dev/null | grep -c -e "$MARK_RE"); [ $REMOVE = 1 ] && WANT=0 || WANT=1
[ "$N" = "$WANT" ] || { echo "The crontab didn't end up as expected (found $N Loanscape lines). Your previous one is at $STATE/crontab.bak-$STAMP."; exit 1; }
echo "$DID"
[ -n "$CUR" ] && echo "Your previous crontab is saved at $STATE/crontab.bak-$STAMP (restore with: crontab \"$STATE/crontab.bak-$STAMP\")."
old_note
