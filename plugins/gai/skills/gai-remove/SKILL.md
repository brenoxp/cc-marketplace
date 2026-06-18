---
name: gai:gai-remove
description: Undo a gai installation — remove CLI symlinks, config/profile/cache, and the CLAUDE.md wiring. Use on "remove gai", "uninstall gai", "clean up gai".
---

This is an INTERACTIVE cleanup. It reverses everything `/gai:gai-config` set up.
Show the user what exists, ask what to remove, then remove only what they confirm.
NEVER delete anything blindly.

## Step 0: explain
Tell the user in plain prose: this removes the things gai's setup created on this
machine (the `gai`/`gaimd` commands on your PATH, gai's config and browser profile,
and the usage note wired into your global CLAUDE.md). It does NOT uninstall the
Claude Code plugin itself — that is a separate step shown at the end.

## Step 1: detect what exists
Probe each artifact and report which are present, so the user only removes real things:

```
ls -l ~/.local/bin/gai ~/.local/bin/gaimd 2>/dev/null
ls -ld ~/.claude/.gai 2>/dev/null
ls -l ~/.claude/gai-usage.md 2>/dev/null
grep -nF '@~/.claude/gai-usage.md' ~/.claude/CLAUDE.md 2>/dev/null
```

The config dir `~/.claude/.gai` contains `config.json`, the on-disk result `cache/`,
and (connect mode) the persistent browser `profile/` with your Google login.

## Step 2: ask what to remove
Use AskUserQuestion (multiSelect) listing only the artifacts that exist:
1. CLI symlinks (`~/.local/bin/gai`, `~/.local/bin/gaimd`)
2. Config + cache (`~/.claude/.gai/config.json`, `~/.claude/.gai/cache/`)
3. Browser profile (`~/.claude/.gai/profile/`) — WARN: this is your persistent Google login; removing it means logging in again next time.
4. CLAUDE.md wiring (the `@~/.claude/gai-usage.md` import line + the `~/.claude/gai-usage.md` file)

Default recommendation: remove 1, 2, and 4; keep 3 unless the user wants a full wipe.

## Step 3: remove the confirmed items

### CLI symlinks
Only remove if they actually point into this plugin (don't nuke an unrelated `gai`):
```
for f in ~/.local/bin/gai ~/.local/bin/gaimd; do
  [ -L "$f" ] && case "$(readlink "$f")" in *"/plugins/gai/bin/"*) rm -f "$f";; esac
done
```

### Config + cache
```
rm -f ~/.claude/.gai/config.json
rm -rf ~/.claude/.gai/cache
```

### Browser profile (only if chosen)
```
rm -rf ~/.claude/.gai/profile
```

After removing config/cache/profile, drop the dir if now empty:
```
rmdir ~/.claude/.gai 2>/dev/null || true
```

### CLAUDE.md wiring
Remove the import line idempotently (leaves the rest of the file untouched), then the doc:
```
[ -f ~/.claude/CLAUDE.md ] && grep -vxF '@~/.claude/gai-usage.md' ~/.claude/CLAUDE.md > ~/.claude/CLAUDE.md.tmp && mv ~/.claude/CLAUDE.md.tmp ~/.claude/CLAUDE.md
rm -f ~/.claude/gai-usage.md
```

## Step 4: report and point at plugin uninstall
Summarize exactly what was removed and what was kept. Then tell the user that to
remove the Claude Code plugin itself (and its marketplace entry), they run:

```
/plugin uninstall gai@cc-marketplace
```

CLAUDE.md hot-reloads, so the usage note is gone immediately; no restart needed.
