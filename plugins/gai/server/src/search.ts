import {
  chromium as chromiumCore,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import type { SearchResults } from "./types.js";
import { execFileSync } from "node:child_process";
import {
  autoLaunchBrowser,
  getConfigDir,
  getDebugUrl,
  isDebugReachable,
  loadConfig,
} from "./config.js";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const DEBUG = process.env.CHROME_MCP_DEBUG === "1";
const LOG_FILE = join(getConfigDir(), "gai-debug.log");

function toLine(args: unknown[]): string {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  return `${new Date().toISOString()} ${msg}\n`;
}

// Append to the debug log. Best-effort: never throws into the search path.
function appendLog(line: string): void {
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    appendFileSync(LOG_FILE, line, { flag: "a" });
  } catch {
    // ignore
  }
}

// Verbose trace. Console output and file writes happen only under DEBUG so
// normal successful runs leave no trace on disk.
function dbg(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error("[gai]", ...args);
  appendLog(toLine(args));
}

// Failure trace. Always written to the log file (even with DEBUG off) so a user
// who hits a bot-wall or empty result has something to inspect without a rerun.
function logFailure(...args: unknown[]): void {
  appendLog(toLine(["[fail]", ...args]));
  if (DEBUG) console.error("[gai]", ...args);
}

// Physical window frame for the automated browser: full desktop size (so
// Google serves the desktop AI-Mode layout, small windows break the render)
// but far off-screen so it never covers the user's screen. Applied via
// Hammerspoon: CDP Browser.setWindowBounds is unreliable over connect.
const OFFSCREEN_FRAME = { x: -4000, y: 0, w: 1440, h: 2200 };

// Move every Brave window owned by the automation instance off-screen at the
// desktop frame. macOS + Hammerspoon only; no-op on failure. The instance is
// dedicated to gai, so all its windows are ours; the DevTools window (opened
// by the CDP connection) is skipped by title. Not matched on the search title:
// Google sets that via JS after domcontentloaded, so it isn't reliable yet.
function moveWindowOffscreen(): void {
  if (process.platform !== "darwin") return;
  const { x, y, w, h } = OFFSCREEN_FRAME;
  const lua = `local n=0 for _,win in ipairs(hs.window.allWindows()) do local a=win:application() if a and a:name():find('Brave') and not win:title():find('DevTools') then win:setFrame({x=${x},y=${y},w=${w},h=${h}}) n=n+1 end end return 'moved '..n`;
  try {
    const out = execFileSync("hs", ["-c", lua], {
      encoding: "utf8",
      timeout: 3000,
    });
    dbg("moveWindowOffscreen:", out.trim());
  } catch (e) {
    dbg("moveWindowOffscreen failed", e);
  }
}

// Snapshot the macOS app that currently owns the keyboard, so focus can be
// handed back after the automated browser window steals it. Returns null on
// non-darwin or if the query fails (revert becomes a no-op).
function captureFrontmostApp(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync(
      "osascript",
      [
        "-e",
        "tell application \"System Events\" to name of first process whose frontmost is true",
      ],
      { encoding: "utf8", timeout: 2000 },
    ).trim();
  } catch (e) {
    dbg("captureFrontmostApp failed", e);
    return null;
  }
}

function restoreFrontmostApp(appName: string | null): void {
  if (!appName) return;
  try {
    execFileSync(
      "osascript",
      ["-e", `tell application "${appName}" to activate`],
      { encoding: "utf8", timeout: 2000 },
    );
  } catch (e) {
    dbg("restoreFrontmostApp failed", e);
  }
}

// Selectors (verified 2026-05 on udm=50 / hl=en):
// - `div[jsname="KFl8ub"]` = the AI answer text container.
// - `button[aria-label="Copy text"]` = streaming-done signal; clicked to
//   trigger clipboard.write(), intercepted via prototype patch to capture markdown.
const AI_ANSWER_SELECTOR = 'div[jsname="KFl8ub"]';
const COPY_BUTTON_SELECTOR = 'button[aria-label="Copy text"]';

let cachedBrowser: Browser | null = null;
let cachedContext: BrowserContext | null = null;

export async function getBrowser(): Promise<Browser> {
  if (cachedBrowser?.isConnected()) return cachedBrowser;
  if (cachedContext) return cachedContext.browser() as Browser;

  const cfg = loadConfig();

  const debugUrl = getDebugUrl(cfg);
  if (!(await isDebugReachable(cfg))) {
    if (cfg.browserPath) {
      dbg(`CDP down, auto-launching ${cfg.browserPath}`);
      await autoLaunchBrowser(cfg);
    } else {
      throw new Error(
        `Cannot reach Chrome debug at ${debugUrl} and no browserPath configured. ` +
          `Run /gai:config-gai or start the browser with --remote-debugging-port=${cfg.debugPort}.`,
      );
    }
  }
  dbg(`connecting to ${debugUrl}`);
  cachedBrowser = await chromiumCore.connectOverCDP(debugUrl);
  cachedContext =
    cachedBrowser.contexts()[0] ?? (await cachedBrowser.newContext());
  return cachedBrowser;
}

async function getContext(): Promise<BrowserContext> {
  await getBrowser();
  if (!cachedContext) {
    throw new Error("Browser context not initialized");
  }
  return cachedContext;
}

export function clearBrowser(): void {
  cachedBrowser = null;
  cachedContext = null;
}

export async function disconnectBrowser(): Promise<void> {
  if (cachedBrowser) {
    const browser = cachedBrowser;
    cachedBrowser = null;
    cachedContext = null;
    await browser.close();
  }
}

export async function waitForResponseComplete(page: Page): Promise<void> {
  // First, wait for the answer container to render.
  await page
    .waitForSelector(AI_ANSWER_SELECTOR, { timeout: 30000 })
    .catch(() => {});

  // Streaming is finished when the Copy button appears. Poll for it instead
  // of polling content length (avoids false-stable during long pauses).
  const maxWait = 45000;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    const done = await page
      .evaluate((sel) => !!document.querySelector(sel), COPY_BUTTON_SELECTOR)
      .catch(() => false);
    if (done) {
      // Give a beat for the last token to commit to the DOM.
      await new Promise((r) => setTimeout(r, 400));
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function extractResults(page: Page): Promise<SearchResults> {
  return await page.evaluate((answerSel) => {
    const el = document.querySelector(answerSel) as HTMLElement | null;
    if (!el) return { answer: "", url: window.location.href };
    let answer = el.innerText || "";
    answer = answer.replace(/[​‌‍﻿]/g, "");
    answer = answer.replace(/^\s*\+\d+\s*$/gm, "");
    answer = answer.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    return { answer: answer.trim(), url: window.location.href };
  }, AI_ANSWER_SELECTOR);
}

export async function extractResultsMarkdown(
  page: Page,
): Promise<SearchResults> {
  // Wait for copy button to exist and become enabled (Google disables it while streaming)
  await page.waitForFunction(
    (sel) => {
      const btn = document.querySelector(sel) as HTMLButtonElement;
      return btn && !btn.disabled;
    },
    COPY_BUTTON_SELECTOR,
    { timeout: 10000 },
  );

  const copyBtn = page.locator(COPY_BUTTON_SELECTOR).first();
  await copyBtn.scrollIntoViewIfNeeded();
  // Element click dispatches via CDP against the logical viewport, so it works
  // when the emulated render area is larger than the physical window (a raw
  // mouse.click at OS coords could land outside the small window).
  await copyBtn.click();

  const handle = await page.waitForFunction(
    () => (window as any).__capturedClipboard,
    null,
    { timeout: 5000 },
  );
  const answer = ((await handle.jsonValue()) as string).trim();

  if (DEBUG) dbg(`captured clipboard len=${answer.length}`);

  return { answer, url: page.url() };
}

export async function executeSearch(query: string): Promise<SearchResults> {
  const cfg = loadConfig();
  // Capture focus before touching the browser: connecting/launching it may
  // already raise a window. Restored after the search completes.
  const priorFrontmost = cfg.headless ? null : captureFrontmostApp();

  const context = await getContext();

  // Inject clipboard intercept before any page scripts run. Must be on the
  // context BEFORE newPage() in Playwright. Always armed: we capture the
  // markdown response as the single raw form and derive all output formats
  // from it (the Copy button is also the streaming-done signal).
  {
    await context.addInitScript(() => {
      const w = window as any;
      w.__capturedClipboard = "";
      const proto = Clipboard.prototype;

      const origWriteText = proto.writeText;
      proto.writeText = async function (text: string) {
        w.__capturedClipboard = text;
        return origWriteText.call(this, text).catch(() => {});
      };

      const origWrite = proto.write;
      // The "Copy text" button writes a ClipboardItem carrying both text/plain
      // (clean markdown) and text/html (a nested data-sfc DOM). Always prefer
      // text/plain. Only fall back to text/html when plain is absent, and strip
      // it to visible text so raw HTML never leaks into the answer.
      proto.write = async function (items: ClipboardItem[]) {
        for (const item of items) {
          const flavors: Record<string, string> = {};
          for (const type of item.types) {
            if (type === "text/plain" || type === "text/html") {
              flavors[type] = await (await item.getType(type)).text();
            }
          }
          const plain = flavors["text/plain"];
          const html = flavors["text/html"];
          if (plain && plain.trim()) {
            w.__capturedClipboard = plain;
          } else if (html && html.trim()) {
            const doc = new DOMParser().parseFromString(html, "text/html");
            w.__capturedClipboard = doc.body.innerText || doc.body.textContent || "";
          }
        }
        return origWrite.call(this, items).catch(() => {});
      };

      const origExec = document.execCommand.bind(document);
      document.execCommand = function (cmd: string, ...rest: any[]) {
        if (cmd === "copy") {
          const sel = window.getSelection()?.toString() || "";
          if (sel) w.__capturedClipboard = sel;
        }
        return origExec(cmd, ...rest);
      } as typeof document.execCommand;
    });
  }

  const page = await context.newPage();
  dbg(`executeSearch start mode=${cfg.mode} headless=${cfg.headless} query=${query}`);

  // Strip the HeadlessChrome UA token: Google gates AI Mode (udm=50) as "not
  // available on your device" when it sees a headless UA. Overriding to a real
  // Chrome UA unlocks the AI answer. No-op for an already-real UA (visible Brave).
  try {
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send("Network.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });
    dbg("UA override applied");
  } catch (e) {
    dbg(`UA override failed: ${String(e)}`);
  }

  try {
    const url = `https://www.google.com/search?udm=50&hl=en&gl=us&q=${encodeURIComponent(query)}`;
    dbg(`goto ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    dbg("goto done");

    // Detect Google's bot-wall early so we bail fast instead of polling 76s for
    // an AI answer that will never render.
    const botWall = await page
      .evaluate(() => {
        const t = document.body?.innerText || "";
        if (/unusual traffic|not a robot|About this page/i.test(t))
          return "unusual-traffic";
        if (document.querySelector("form#captcha-form, iframe[src*='recaptcha']"))
          return "recaptcha";
        if (/consent|Before you continue/i.test(document.title)) return "consent";
        return null;
      })
      .catch(() => null);
    if (botWall) {
      const shot = join(getConfigDir(), "gai-botwall.png");
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      logFailure(
        `BOT-WALL detected: ${botWall} title=${await page.title()} screenshot=${shot}`,
      );
      // Headless can't be solved by the user (no visible window). Bail with an
      // actionable message: rerun visible so the wall (login/captcha/consent)
      // can be cleared by hand, which also re-seeds the profile cookies.
      if (cfg.headless) {
        await page.close().catch(() => {});
        restoreFrontmostApp(priorFrontmost);
        throw new Error(
          `Google served a "${botWall}" wall in headless mode. Rerun with a ` +
            `visible window to solve it by hand:\n` +
            `  GAI_HEADLESS=false gai "<query>"\n` +
            `(screenshot: ${shot})`,
        );
      }
      // Visible window: leave the wall up so the user can solve it in place;
      // the run continues and waits for the AI answer once it clears.
    }

    // Push the window off-screen (title is now the Google Search page), then
    // hand focus back the moment the query is in flight; the rest of the run
    // (waiting for the answer, the Copy click) uses CDP and doesn't re-raise
    // the window, so the user gets their app back immediately.
    if (!cfg.headless) moveWindowOffscreen();
    restoreFrontmostApp(priorFrontmost);

    dbg("waiting for response complete");
    await waitForResponseComplete(page);
    dbg("response complete, extracting");
    let results: SearchResults;
    try {
      results = await extractResultsMarkdown(page);
      dbg(`markdown extract ok len=${results.answer.length}`);
    } catch (e) {
      dbg("markdown capture failed, falling back to plain text", e);
      results = await extractResults(page);
      dbg(`plaintext extract len=${results.answer.length}`);
      if (results.answer.length === 0) {
        try {
          const shot = join(getConfigDir(), "gai-fail.png");
          await page.screenshot({ path: shot, fullPage: true });
          const bodyText = await page
            .evaluate(() => document.body.innerText.slice(0, 500))
            .catch(() => "");
          logFailure(
            `empty result: screenshot=${shot} bodyText=${JSON.stringify(bodyText)}`,
          );
        } catch (dumpErr) {
          logFailure(`dump failed: ${String(dumpErr)}`);
        }
      }
    }

    if (!process.env.GAIS_KEEP_TAB) {
      await page.close();
    }
    restoreFrontmostApp(priorFrontmost);

    return { answer: results.answer, url: results.url };
  } catch (error) {
    logFailure(
      `executeSearch error: ${error instanceof Error ? error.stack : String(error)}`,
    );
    await page.close().catch(() => {});
    restoreFrontmostApp(priorFrontmost);
    throw error;
  }
}
