#!/usr/bin/env bash
# One-time migration of the gai config dir from the legacy ~/.claude/.gai_mcp
# (named when gai shipped as an MCP server) to ~/.claude/.gai.
#
# Moves config.json, the logged-in browsing/headless profiles, and the request
# cache so an upgrading user keeps their Google session instead of cold-starting
# into the bot-wall. Runs on session start; idempotent and silent on success.

OLD_DIR="$HOME/.claude/.gai_mcp"
NEW_DIR="$HOME/.claude/.gai"

# Nothing to migrate if the legacy dir is gone (fresh install or already moved).
[ -d "$OLD_DIR" ] || exit 0

# New dir already populated: the user has moved on, leave both as-is rather than
# clobbering a live config. (A bare/empty NEW_DIR is fine to fill.)
if [ -e "$NEW_DIR/config.json" ]; then
  exit 0
fi

# Fresh target: rename wholesale (fast, atomic, preserves everything).
if [ ! -d "$NEW_DIR" ]; then
  mv "$OLD_DIR" "$NEW_DIR" 2>/dev/null || exit 0
  exit 0
fi

# Target exists but has no config: merge the legacy contents in, then drop the
# emptied legacy dir. -n avoids overwriting anything already present.
cp -Rn "$OLD_DIR"/. "$NEW_DIR"/ 2>/dev/null || exit 0
rm -rf "$OLD_DIR" 2>/dev/null || true

exit 0
