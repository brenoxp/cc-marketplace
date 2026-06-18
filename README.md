# cc-marketplace

A [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin marketplace.

## Plugins

### gai — Google AI Mode search

`gai` is a command-line tool (and Claude Code plugin) that queries Google's
**AI Mode** — the conversational answer panel Google shows above normal search
results — and returns the synthesized answer as text, markdown, or JSON.

Google AI Mode has no public API, so `gai` drives a real Chromium browser via
[Playwright](https://playwright.dev) and captures the answer the same way the
page's own "Copy" button does. The result: up-to-date, synthesized answers with
sources, from the terminal or from inside a Claude Code session.

#### How it works

1. Opens `https://www.google.com/search?udm=50&q=<query>` (`udm=50` = AI Mode) in a Chromium page.
2. Waits for the streamed answer to finish (signalled by the page's Copy button becoming enabled).
3. Captures the answer markdown by intercepting the page's clipboard write, strips citation cruft, and prints it.
4. Caches each result on disk under a short id so it can be replayed without hitting the browser again.

Two browser modes (chosen during setup):

- **Connect** (recommended on a desktop): attaches to a real Brave/Chrome via the
  DevTools protocol, using a persistent profile under `~/.claude/.gai/profile`.
  Log into Google once and captchas stop. gai auto-launches the browser on demand.
- **Launch** (headless): spins up its own headless chromium per call. Zero setup,
  but Google often serves captchas to headless traffic.

#### Requirements

- [bun](https://bun.sh) (runs the TypeScript CLI)
- For connect mode: Brave or Google Chrome
- For headless mode: `bunx playwright install chromium`
- Optional: [`glow`](https://github.com/charmbracelet/glow) for rendered markdown output (`gaimd`); falls back to raw markdown if absent.

#### Install (as a Claude Code plugin)

```
/plugin marketplace add brenoxp/cc-marketplace
/plugin install gai@cc-marketplace
/gai:gai-config
```

`/gai:gai-config` is an interactive setup: it installs CLI dependencies, lets you
pick a browser mode, validates the browser can actually start, optionally symlinks
the `gai`/`gaimd` commands into `~/.local/bin`, and (optionally) adds a usage note
to your global `~/.claude/CLAUDE.md` so future sessions know to reach for `gai`.
Run `/gai:gai-remove` to undo any of this later.

#### Install (CLI only, without Claude Code)

```
git clone https://github.com/brenoxp/cc-marketplace
cd cc-marketplace/plugins/gai/server
bun install
ln -sfn "$PWD/../bin/gai"   ~/.local/bin/gai
ln -sfn "$PWD/../bin/gaimd" ~/.local/bin/gaimd
```

Then write `~/.claude/.gai/config.json` (see the connect/launch schema below)
or set `GAI_BROWSER_MODE=launch` to use headless mode with no config file.

#### Usage

```
gai "latest bun runtime features"      # plain text in a terminal, JSON when piped
gaimd "explain CRDTs"                   # markdown (rendered via glow if installed)
gai -t json "query" | jq '.answer'
cat file.ts | gai "explain this"        # pipe content in as context
git diff | gai "review these changes"
gai --id a1b2c3d4                        # replay a cached result, no browser
```

Every response ends with a request id (e.g. `[id: a1b2c3d4]`); pass it back with
`--id` to re-print the exact same result without hitting the browser again.

#### Configuration

`~/.claude/.gai/config.json`:

```json
{
  "mode": "connect",
  "browserPath": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "debugPort": 9222,
  "userDataDir": "$HOME/.claude/.gai/profile",
  "headless": true
}
```

Environment overrides (take precedence over the file): `GAI_BROWSER_MODE`
(`connect`|`launch`), `GAI_BROWSER_PATH`, `GAI_DEBUG_PORT`, `GAI_USER_DATA_DIR`,
`GAI_HEADLESS`.

## Repository layout

```
.claude-plugin/marketplace.json   marketplace manifest
plugins/gai/                       the gai plugin
  bin/                             gai, gaimd launchers
  commands/gai-config.md           /gai:gai-config slash command
  commands/gai-remove.md           /gai:gai-remove slash command
  skills/gai-config/               interactive setup walkthrough
  skills/gai-remove/               interactive cleanup walkthrough
  docs/gai-usage.md                usage note installed into the user's CLAUDE.md
  server/                          TypeScript CLI (bun + playwright-core)
```
