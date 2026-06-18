#!/usr/bin/env bash
# Self-heal the gai CLI on session start.
#
# The gai/gaimd commands are symlinked from ~/.local/bin into the plugin's
# version-pinned cache dir (.../gai/<version>/bin). When the plugin updates,
# that dir changes (and the old one may be deleted), leaving the symlink stale
# or dangling, and the new version ships no server deps. This hook repoints the
# symlinks at the currently-loaded plugin and installs deps if missing.
#
# Only ever touches symlinks the user already opted into (created by gai-config).
# Never creates them, never prompts, silent on success.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || exit 0

bin_dir="$PLUGIN_ROOT/bin"
local_bin="$HOME/.local/bin"

# Skip entirely if the user never installed the CLI on PATH.
[ -L "$local_bin/gai" ] || [ -L "$local_bin/gaimd" ] || exit 0

needs_repoint=0
for name in gai gaimd; do
  link="$local_bin/$name"
  [ -L "$link" ] || continue
  if [ "$(readlink "$link")" != "$bin_dir/$name" ]; then
    needs_repoint=1
  fi
done

[ "$needs_repoint" -eq 1 ] || exit 0

# A repoint means the plugin version changed: install deps for the new version
# (the freshly-unpacked cache dir has no node_modules) before swinging the links.
if [ ! -d "$PLUGIN_ROOT/server/node_modules" ] && command -v bun >/dev/null 2>&1; then
  (cd "$PLUGIN_ROOT/server" && bun install >/dev/null 2>&1) || true
fi

for name in gai gaimd; do
  link="$local_bin/$name"
  [ -L "$link" ] || continue
  ln -sfn "$bin_dir/$name" "$link"
done

exit 0
