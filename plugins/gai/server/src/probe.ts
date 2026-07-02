#!/usr/bin/env bun
// Debug probe: connect to a headless Brave over CDP, override UA to strip the
// HeadlessChrome token, load Google AI Mode, and report whether the AI answer
// renders. Used to test if UA spoofing unlocks AI Mode in headless.
//   GAI_DEBUG_PORT=9223 bun server/src/probe.ts "query"
import { chromium } from "playwright-core";

const REAL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const port = process.env.GAI_DEBUG_PORT ?? "9223";
const query = process.argv[2] ?? "what is bun runtime";

const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();

const cdp = await ctx.newCDPSession(page);
await cdp.send("Network.setUserAgentOverride", { userAgent: REAL_UA });

const url = `https://www.google.com/search?udm=50&hl=en&gl=us&q=${encodeURIComponent(query)}`;
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
} catch (e) {
  console.log("GOTO ERR", String(e).slice(0, 160));
}
await new Promise((r) => setTimeout(r, 3000));

const navUA = await page.evaluate(() => navigator.userAgent).catch(() => "?");
const hasAnswer = await page
  .evaluate(() => !!document.querySelector('div[jsname="KFl8ub"]'))
  .catch(() => null);
const hasCopy = await page
  .evaluate(() => !!document.querySelector('button[aria-label="Copy text"]'))
  .catch(() => null);
const bodyText = (
  await page.evaluate(() => document.body?.innerText || "").catch(() => "")
).slice(0, 800);

console.log(JSON.stringify({ navUA, hasAnswer, hasCopy }, null, 2));
console.log("=== BODY ===\n" + bodyText);

await page.close().catch(() => {});
process.exit(0);
