#!/bin/sh
# Stops the dispatcher agent and removes its plist. Leaves config and log in place.
set -eu

LABEL="ai.codecaine.dispatcher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL"
