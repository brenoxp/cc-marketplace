import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import type { SearchResults, ToolResult } from "./types.js";
import {
  autoLaunchBrowser,
  getDebugUrl,
  isDebugReachable,
  loadConfig,
} from "./config.js";

const DEBUG = process.env.CHROME_MCP_DEBUG === "1";
function dbg(...args: unknown[]) {
  if (DEBUG) console.error("[gai]", ...args);
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

  const cfg = loadConfig();

  if (cfg.mode === "launch") {
    dbg(`launching chromium (headless=${cfg.headless})`);
    cachedBrowser = await chromium.launch({
      headless: cfg.headless,
      args: ["--no-sandbox"],
    });
    cachedContext = await cachedBrowser.newContext();
    return cachedBrowser;
  }

  const debugUrl = getDebugUrl(cfg);
  if (!(await isDebugReachable(cfg))) {
    if (cfg.browserPath) {
      dbg(`CDP down, auto-launching ${cfg.browserPath}`);
      await autoLaunchBrowser(cfg);
    } else {
      throw new Error(
        `Cannot reach Chrome debug at ${debugUrl} and no browserPath configured. ` +
          `Run /gai:gai-config or start the browser with --remote-debugging-port=${cfg.debugPort}.`,
      );
    }
  }
  dbg(`connecting to ${debugUrl}`);
  cachedBrowser = await chromium.connectOverCDP(debugUrl);
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
  const box = await copyBtn.boundingBox();
  if (!box) throw new Error("Copy button has no bounding box");

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const handle = await page.waitForFunction(
    () => (window as any).__capturedClipboard,
    null,
    { timeout: 5000 },
  );
  const answer = ((await handle.jsonValue()) as string).trim();

  if (DEBUG) dbg(`captured clipboard len=${answer.length}`);

  return { answer, url: page.url() };
}

export async function executeSearch(query: string): Promise<ToolResult> {
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
      proto.write = async function (items: ClipboardItem[]) {
        for (const item of items) {
          for (const type of item.types) {
            if (type === "text/plain" || type === "text/html") {
              const blob = await item.getType(type);
              const text = await blob.text();
              if (text && type === "text/plain") w.__capturedClipboard = text;
              if (text && type === "text/html" && !w.__capturedClipboard)
                w.__capturedClipboard = text;
            }
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

  try {
    const url = `https://www.google.com/search?udm=50&hl=en&gl=us&q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    await waitForResponseComplete(page);
    let results: SearchResults;
    try {
      results = await extractResultsMarkdown(page);
    } catch (e) {
      dbg("markdown capture failed, falling back to plain text", e);
      results = await extractResults(page);
    }

    if (!process.env.GAIS_KEEP_TAB) {
      await page.close();
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { answer: results.answer, url: results.url },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error) {
    await page.close();
    throw error;
  }
}
