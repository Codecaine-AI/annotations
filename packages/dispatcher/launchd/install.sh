#!/bin/sh
# Installs the dispatcher as a launchd user agent (label ai.codecaine.dispatcher)
# with this checkout's real paths, then loads and starts it. Safe to rerun.
set -eu

LABEL="ai.codecaine.dispatcher"
PACKAGE="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${DISPATCHER_CONFIG:-$HOME/.config/codecaine-dispatcher/config.json}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUN="$(command -v bun)"

if [ ! -f "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  cp "$PACKAGE/config.example.json" "$CONFIG"
  echo "Wrote $CONFIG from config.example.json. Check docsProject and t3Project, then rerun this script." >&2
  exit 1
fi

LOG="$("$BUN" -e 'const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(c.logPath ?? "")' "$CONFIG")"
LOG="${LOG:-$HOME/.local/state/codecaine-dispatcher/dispatcher.log}"
mkdir -p "$(dirname "$LOG")" "$(dirname "$PLIST")"

# The t3 CLI and bun must be on the agent's PATH; launchd gives none.
AGENT_PATH="$HOME/.t3/bin:$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin"

sed \
  -e "s|__BUN__|$BUN|g" \
  -e "s|__PACKAGE__|$PACKAGE|g" \
  -e "s|__CONFIG__|$CONFIG|g" \
  -e "s|__LOG__|$LOG|g" \
  -e "s|__PATH__|$AGENT_PATH|g" \
  "$PACKAGE/launchd/$LABEL.plist" > "$PLIST"

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "Loaded $LABEL from $PLIST"
echo "Config: $CONFIG"
echo "Log:    $LOG"
