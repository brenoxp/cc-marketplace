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

// Single-watchdog lock, per port. Lock holds "pid:pgid": the live reaper's PID
// and the browser pgid it watches. On startup:
//   - owner alive AND watching the SAME browser pgid -> real duplicate, exit.
//   - owner alive but watching a DIFFERENT (stale) pgid -> it points at a dead
//     browser and would never reap the current one; kill it and steal the lock.
//   - owner dead / lock garbage -> steal.
if (existsSync(LOCK_FILE)) {
  const [ownerRaw, ownerPgidRaw] = readFileSync(LOCK_FILE, "utf8")
    .trim()
    .split(":");
  const owner = Number(ownerRaw);
  const ownerPgid = Number(ownerPgidRaw);
  if (owner && isAlive(owner)) {
    if (ownerPgid === browserPgid) process.exit(0); // true duplicate
    try {
      process.kill(owner, "SIGTERM"); // stale reaper on a dead browser
    } catch {
      // already gone
    }
  }
}
writeFileSync(LOCK_FILE, `${process.pid}:${browserPgid}`, "utf8");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// This is a gai-dedicated browser, so any non-blank page is a gai search tab.
// A healthy search opens a tab, gets its answer in ~5s, and self-closes (search.ts
// page.close()). A tab that survives a full poll cycle (POLL_MS, 15s >> 5s) is an
// ORPHAN: left behind when a gai run was SIGTERM-killed mid-search (timeout, ^C)
// before its page.close() ran. Orphans used to be counted as activity, which reset
// the idle timer forever and made the browser immortal. Now we CLOSE any real page
// that was already present on the previous poll (proven orphan) and count only
// pages seen for the first time (possible in-flight search) as active.
let prevOrphanIds = new Set<string>();

function isRealPage(t: { type: string; url: string }): boolean {
  return (
    t.type === "page" &&
    t.url !== "about:blank" &&
    !t.url.startsWith("devtools://") &&
    !t.url.startsWith("chrome://")
  );
}

async function closeTarget(id: string): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/json/close/${id}`, {
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // best effort; next poll retries
  }
}

// Returns count of pages treated as ACTIVE (in-flight searches), or null if the
// port is unreachable. Side effect: closes orphaned tabs seen two polls running.
async function activePages(): Promise<number | null> {
  try {
    const res = await fetch(`http://localhost:${port}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const targets = (await res.json()) as Array<{
      id: string;
      type: string;
      url: string;
    }>;
    const real = targets.filter(isRealPage);
    const seenLastPoll = prevOrphanIds; // ids present on the previous poll

    // A real page present on this poll AND the previous one is a proven orphan
    // (a live search would have finished and self-closed within one poll). Close
    // it and don't count it. A page seen for the FIRST time may be an in-flight
    // search, so it counts as active this round.
    let closed = 0;
    let active = 0;
    for (const t of real) {
      if (seenLastPoll.has(t.id)) {
        await closeTarget(t.id);
        closed++;
      } else {
        active++;
      }
    }
    if (closed > 0) logLine(`closed ${closed} orphan tab(s)`);

    // Carry this poll's ids forward: a tab still here next poll is an orphan.
    prevOrphanIds = new Set(real.map((t) => t.id));

    return active;
  } catch {
    return null; // port unreachable
  }
}

// Remove the lock only if WE still own it. A stale reaper being SIGTERM-stolen
// must not delete the new owner's freshly written lock (that would let a later
// duplicate stack). Compare the pid field, ignore the pgid.
function cleanupLock(): void {
  try {
    const owner = Number(readFileSync(LOCK_FILE, "utf8").trim().split(":")[0]);
    if (owner === process.pid) rmSync(LOCK_FILE, { force: true });
  } catch {
    // no lock / unreadable: nothing to clean
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
