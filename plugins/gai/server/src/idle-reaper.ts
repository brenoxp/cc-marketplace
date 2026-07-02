#!/usr/bin/env bun
// Idle watchdog for an auto-launched headless Brave. Keeps the browser warm for
// fast repeat searches, then kills it once it has had no open search tab for
// GAI_IDLE_REAP_MS (default 5 min). Spawned detached by autoLaunchBrowser right
// after the browser's CDP comes up.
//
// Usage: bun idle-reaper.ts <debugPort> <browserPgid>
// A PID-file lock (per port) keeps a second gai run from stacking watchdogs.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "./config.js";

const port = Number(process.argv[2]);
const browserPgid = Number(process.argv[3]);
if (!port || !browserPgid) process.exit(1);

const DEBUG = process.env.CHROME_MCP_DEBUG === "1";
const IDLE_MS = Number(process.env.GAI_IDLE_REAP_MS) || 5 * 60 * 1000;
const POLL_MS = 15_000;
const LOCK_FILE = join(tmpdir(), `gai-reaper-${port}.pid`);

// Single-watchdog lock: if a live reaper already owns this port, exit.
if (existsSync(LOCK_FILE)) {
  const owner = Number(readFileSync(LOCK_FILE, "utf8").trim());
  if (owner && isAlive(owner)) process.exit(0);
}
writeFileSync(LOCK_FILE, String(process.pid), "utf8");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Count non-blank page targets. A gai search opens a real tab then closes it,
// so "no real pages" means the browser is idle.
async function activePages(): Promise<number | null> {
  try {
    const res = await fetch(`http://localhost:${port}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const targets = (await res.json()) as Array<{ type: string; url: string }>;
    return targets.filter(
      (t) =>
        t.type === "page" &&
        t.url !== "about:blank" &&
        !t.url.startsWith("devtools://") &&
        !t.url.startsWith("chrome://"),
    ).length;
  } catch {
    return null; // port unreachable
  }
}

function cleanupLock(): void {
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    // ignore
  }
}

// Reaper lifecycle is verbose trace: file-logged only under DEBUG, so idle
// warm-browser cycles leave no trace on a normal user's disk.
function logLine(msg: string): void {
  if (!DEBUG) return;
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    const logFile = join(getConfigDir(), "gai-debug.log");
    const ts = new Date().toISOString();
    appendFileSync(logFile, `${ts} [reaper] ${msg}\n`, { flag: "a" });
  } catch {
    // ignore
  }
}

let lastActive = Date.now();
logLine(`watchdog start port=${port} pgid=${browserPgid} idleMs=${IDLE_MS}`);

const timer = setInterval(async () => {
  const pages = await activePages();

  // Port gone (browser died / manually killed): nothing to reap, exit clean.
  if (pages === null) {
    logLine("port unreachable, exiting");
    clearInterval(timer);
    cleanupLock();
    process.exit(0);
  }

  if (pages > 0) {
    lastActive = Date.now();
    return;
  }

  if (Date.now() - lastActive >= IDLE_MS) {
    logLine(`idle ${IDLE_MS}ms, killing browser pgid=${browserPgid}`);
    try {
      process.kill(-browserPgid, "SIGTERM");
    } catch (e) {
      logLine(`kill failed: ${String(e)}`);
    }
    clearInterval(timer);
    cleanupLock();
    process.exit(0);
  }
}, POLL_MS);

// Reap the lock if we're ever signalled.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    cleanupLock();
    process.exit(0);
  });
}
