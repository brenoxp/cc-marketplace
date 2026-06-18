---
name: gai:gai-config
description: Configure the gai CLI browser mode and wire gai into your global CLAUDE.md. Use on "set up gai", "configure gai", "install gai", "gai browser".
---

This is an INTERACTIVE walkthrough. Do NOT pick a mode for the user. Ask, explain tradeoffs, then act.

## Step 0: explain in plain language what this is and what setup will do
Before anything else, tell the user in simple prose, then wait for them to acknowledge before proceeding:

> What `gai` is: a small command-line program installed on your computer. It is NOT a Claude Code command or skill, and it is NOT a chatbot. You run it from any terminal as `gai "your question"`.
>
> What it does: it opens a real web browser in the background, runs your question through Google's AI Mode (the AI answer panel Google shows above normal search results), grabs the synthesized answer, and prints it back to your terminal as text or JSON.
>
> Why a browser: Google AI Mode has no public API, so the only way to reach it is to drive an actual browser. That is why this setup needs to know which browser to use, and checks that the browser can actually start.
>
> What this setup will do, step by step:
> 1. Install the CLI's dependencies (with `bun`).
> 2. Let you choose how the browser is reached (use a browser already on your machine, or download a headless one).
> 3. Check that the chosen browser is installed and can actually be launched.
> 4. Optionally put the `gai`/`gaimd` commands on your PATH so you can run them from any terminal.
> 5. Optionally add a short usage note to your global `~/.claude/CLAUDE.md` so future Claude sessions know `gai` exists.
> 6. Run one live test search to confirm it all works.

Only continue once the user is ready.

## Step 1: detect host
Run `uname -s` and check for browsers (`ls /Applications | rg -i 'brave|chrome'` on mac). Use this only to suggest a default, not to skip the question.

## Step 2: install CLI dependencies
The CLI runs the TypeScript under `${CLAUDE_PLUGIN_ROOT}/server` with `bun`, so its
dependencies must be installed once:

```
cd "${CLAUDE_PLUGIN_ROOT}/server" && bun install
```

This also applies the bundled playwright-core patch. Requires `bun` on PATH.

## Step 3: explain the two browser modes
Before asking, tell the user in plain prose what they're choosing between:

- Mode A — Connect to an existing browser (CDP), auto-launched on demand
  - gai stores a `browserPath` (e.g. Brave or Chrome) and a persistent profile dir under `~/.claude/.gai/profile`. On every call, gai probes the debug port; if the browser isn't running, it spawns it detached with `--remote-debugging-port=<port> --user-data-dir=<profile>`, then attaches.
  - Pros: uses a real, persistent browser profile (log into Google once, no captchas after that). No need to remember to start the browser — gai launches it when needed.
  - Cons: the browser stays around in the background once launched (you can quit it any time, gai will relaunch).

- Mode B — Headless playwright chromium
  - gai launches its own chromium each call (headless by default), no persistent profile.
  - Pros: zero setup, works on a headless server.
  - Cons: Google frequently serves a captcha to headless traffic — searches can fail. Downloads ~150MB of chromium.

## Step 4: ask
Use AskUserQuestion with both options. Recommend mode A on mac with Brave/Chrome installed, mode B on a headless Linux box. Make the recommendation explicit ("Recommended" label) but still ask.

## Step 5: configure based on choice

Config lives at `~/.claude/.gai/config.json`. Schema:
```json
{
  "mode": "connect" | "launch",
  "browserPath": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "debugPort": 9222,
  "userDataDir": "$HOME/.claude/.gai/profile",
  "headless": true
}
```

`mkdir -p ~/.claude/.gai` then write the JSON. Use `$HOME` expansion via the shell (`echo "$HOME/.claude/.gai/profile"`) so the path is absolute, not literal `~`.

### Mode A
- Detect the browser path. Mac defaults:
  - Brave: `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`
  - Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- If both exist, ask which one. Otherwise pick the one present.
- Confirm the chosen `browserPath` actually exists on disk (`test -x "$BROWSER_PATH"`). If it does not, the browser is not installed — tell the user and offer to pick the other browser or switch to mode B. Do NOT write a config pointing at a missing binary.
- Set `mode: "connect"`, `browserPath: <chosen>`, `debugPort: 9222`, `userDataDir: <HOME>/.claude/.gai/profile`.
- Profile dir is persistent (NOT under `/tmp`). On first search the user will need to log into Google once in that profile to avoid captchas.

### Mode B
- Run `cd "${CLAUDE_PLUGIN_ROOT}/server" && bunx playwright install chromium` (playwright-core doesn't auto-fetch browsers).
- Set `mode: "launch"`, `headless: true` (or `false` if user has a display).
- Warn explicitly: Google often serves captcha to headless requests. If searches fail, fall back to mode A.

## Step 6: validate the browser can actually start
Always run this validation (not optional). The point is to prove the chosen browser launches BEFORE the user relies on gai.

### Mode A
Spawn the browser detached with the debug flag and the persistent profile, then confirm the DevTools endpoint responds:
```
"$BROWSER_PATH" --remote-debugging-port=$PORT --user-data-dir="$HOME/.claude/.gai/profile" >/dev/null 2>&1 &
disown
```
Poll `curl -s http://localhost:$PORT/json/version` for a few seconds.
- If it responds: validation passed. Tell the user the browser started. Then offer (AskUserQuestion) to log into Google in the opened window now so the persistent profile avoids captchas later (recommended). That login persists across reboots since the profile lives under `~/.claude/`.
- If it never responds: validation FAILED. Show the error, and offer to re-pick the browser, switch to mode B, or re-run setup. Do not proceed to Step 7 with a browser that won't start.

### Mode B
Confirm chromium is installed and can launch headless with a quick smoke test:
```
cd "${CLAUDE_PLUGIN_ROOT}/server" && bun -e 'import {chromium} from "playwright-core"; const b = await chromium.launch({headless:true}); await b.close(); console.log("ok");'
```
- If it prints `ok`: validation passed.
- If it errors (chromium missing/won't launch): re-run `bunx playwright install chromium`, then retry once. If still failing, show the error and suggest mode A.

## Step 7: install the CLI on PATH
The plugin ships `gai` and `gaimd` at `${CLAUDE_PLUGIN_ROOT}/bin`. Symlink them into a
directory on `$PATH` so they run from any terminal.

Use AskUserQuestion: "Install the `gai`/`gaimd` CLI to `~/.local/bin`?" (Recommended on dev machines, skip on minimal/server installs.)

If yes:
- `mkdir -p ~/.local/bin`
- Check it's on `$PATH` (`echo $PATH | tr ':' '\n' | grep -Fx "$HOME/.local/bin"`). If not, warn the user to add it to their shell profile.
- `ln -sfn "${CLAUDE_PLUGIN_ROOT}/bin/gai" ~/.local/bin/gai && ln -sfn "${CLAUDE_PLUGIN_ROOT}/bin/gaimd" ~/.local/bin/gaimd`
- Verify: `which gai`.

These symlinks point into the plugin's version-pinned cache dir, which moves on every
plugin update. A bundled `SessionStart` hook (`scripts/sync-cli.sh`) auto-repoints them
to the current version (and installs the new version's deps) whenever they go stale, so
the user never has to re-run setup after an update.

If no: skip silently.

## Step 8: wire gai into the global CLAUDE.md
So every future Claude Code session knows gai exists and when to use it, install the
usage doc and reference it from the user's global memory file.

Ask first (AskUserQuestion): "Add a gai usage note to your global `~/.claude/CLAUDE.md` so agents know to use it?" (Recommended yes.)

If yes:
- Copy the shipped doc to a stable path (survives plugin updates):
  `cp "${CLAUDE_PLUGIN_ROOT}/docs/gai-usage.md" ~/.claude/gai-usage.md`
- Idempotently add an `@`-import to `~/.claude/CLAUDE.md` (create the file if missing).
  Only append if the line is not already present:
  ```
  touch ~/.claude/CLAUDE.md
  grep -qxF '@~/.claude/gai-usage.md' ~/.claude/CLAUDE.md \
    || printf '\n@~/.claude/gai-usage.md\n' >> ~/.claude/CLAUDE.md
  ```
- Tell the user CLAUDE.md hot-reloads; no restart needed.

If no: skip. The CLI still works; sessions just won't be reminded to use it.

## Step 9: verify
Run a live search to confirm the browser path works:

```
gai "what year is it"
```

A working setup prints JSON with an `answer` field. If it fails, show the error and offer to switch modes or re-run setup.

To undo any of this later, run `/gai:gai-remove`.
