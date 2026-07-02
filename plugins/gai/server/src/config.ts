import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Try to atomically claim the per-port launch lock. Returns true if we own it
// (caller must launch + release), false if a live launcher already holds it
// (caller should wait for CDP instead of spawning a second browser). A stale
// lock from a dead launcher is stolen.
function acquireLaunchLock(lockFile: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx = O_CREAT | O_EXCL: fails atomically if the file already exists.
      writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(lockFile, "utf8").trim());
      } catch {
        // lock vanished between our failed create and this read; retry.
        continue;
      }
      if (owner && isPidAlive(owner)) return false;
      // Stale lock (launcher died mid-launch): steal it and retry the claim.
      try {
        rmSync(lockFile, { force: true });
      } catch {
        // ignore
      }
    }
  }
  return false;
}

// Playwright attaches over CDP to a browser we launch/own on the debug port.
// Headless vs visible is the browser's own launch flag, not a separate mode:
// a visible window is the escape hatch for Google walls the user must clear
// by hand (login, captcha), a headless one is the default invisible path.
export type BrowserMode = "connect";

export interface GaiConfig {
  mode: BrowserMode;
  browserPath?: string;
  debugPort: number;
  userDataDir: string;
  headless: boolean;
}

const CONFIG_DIR = join(homedir(), ".claude", ".gai");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_PROFILE_DIR = join(CONFIG_DIR, "profile");
// Headless uses its own logged-in profile dir. Two Brave instances can't share
// one profile (Singleton lock), so headless and visible get separate dirs;
// both must be logged into Google to clear the udm=50 bot-wall.
const HEADLESS_PROFILE_DIR = join(CONFIG_DIR, "brave-headless-profile");

const DEFAULTS: GaiConfig = {
  mode: "connect",
  debugPort: 9222,
  userDataDir: DEFAULT_PROFILE_DIR,
  headless: true,
};

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): GaiConfig {
  let fromFile: Partial<GaiConfig> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch {
      // ignore malformed, fall back to defaults + env
    }
  }

  const envPort = process.env.GAI_DEBUG_PORT
    ? Number(process.env.GAI_DEBUG_PORT)
    : undefined;

  // Legacy: BRAVE_DEBUG_URL may carry a different port
  const legacyUrl = process.env.BRAVE_DEBUG_URL;
  let legacyPort: number | undefined;
  if (legacyUrl) {
    try {
      legacyPort = Number(new URL(legacyUrl).port) || undefined;
    } catch {
      // ignore
    }
  }

  return {
    mode: "connect",
    browserPath: process.env.GAI_BROWSER_PATH ?? fromFile.browserPath,
    debugPort: envPort ?? legacyPort ?? fromFile.debugPort ?? DEFAULTS.debugPort,
    userDataDir:
      process.env.GAI_USER_DATA_DIR ??
      fromFile.userDataDir ??
      DEFAULTS.userDataDir,
    headless:
      process.env.GAI_HEADLESS !== undefined
        ? process.env.GAI_HEADLESS !== "false"
        : (fromFile.headless ?? DEFAULTS.headless),
  };
}

export function saveConfig(cfg: GaiConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function getDebugUrl(cfg: GaiConfig): string {
  return `http://localhost:${cfg.debugPort}`;
}

export async function isDebugReachable(cfg: GaiConfig): Promise<boolean> {
  try {
    const res = await fetch(`${getDebugUrl(cfg)}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn the configured browser detached with the debug port + persistent
 * profile dir. Returns when CDP responds, or throws on timeout.
 */
export async function autoLaunchBrowser(cfg: GaiConfig): Promise<void> {
  if (!cfg.browserPath) {
    throw new Error(
      `Auto-launch failed: no browserPath set in ${CONFIG_FILE}. ` +
        `Run /gai:config-gai to configure, or start the browser manually with ` +
        `--remote-debugging-port=${cfg.debugPort}.`,
    );
  }
  if (!existsSync(cfg.browserPath)) {
    throw new Error(
      `Auto-launch failed: browserPath does not exist: ${cfg.browserPath}`,
    );
  }
  // Cross-process launch lock: two gai invocations firing while the browser is
  // down would both try to spawn Brave + clear the Singleton lock on the same
  // port and collide. The loser waits for the winner's CDP to come up instead.
  const lockFile = join(tmpdir(), `gai-launch-${cfg.debugPort}.lock`);
  if (!acquireLaunchLock(lockFile)) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await isDebugReachable(cfg)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(
      `Another gai process is launching the browser on port ${cfg.debugPort} ` +
        `but CDP did not come up within 10s.`,
    );
  }

  try {
    await launchAndWait(cfg, cfg.browserPath);
  } finally {
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // ignore
    }
  }
}

async function launchAndWait(
  cfg: GaiConfig,
  browserPath: string,
): Promise<void> {
  // Headless auto-launch must reuse the logged-in headless profile, else it
  // boots cookieless and hits the "unusual traffic" bot-wall. Visible mode uses
  // the configured userDataDir (its own logged-in profile for the escape hatch).
  const profileDir = cfg.headless ? HEADLESS_PROFILE_DIR : cfg.userDataDir;
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
  }
  // Clear stale Singleton* locks from a crashed/killed prior instance, else
  // Brave refuses to reopen the profile and CDP never comes up.
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      rmSync(join(profileDir, lock), { force: true });
    } catch {
      // ignore
    }
  }

  const args = [
    `--remote-debugging-port=${cfg.debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  // Honor headless: the default invisible path. A visible window is only for
  // the escape hatch (GAI_HEADLESS=false), when the user must clear a wall by hand.
  if (cfg.headless) args.push("--headless=new");

  // detached makes the child its own process-group leader, so child.pid is the
  // pgid the reaper kills to take down the whole browser tree.
  const child = spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const browserPgid = child.pid;

  // Poll CDP until it answers (max ~8s)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isDebugReachable(cfg)) {
      if (browserPgid) spawnIdleReaper(cfg.debugPort, browserPgid);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Auto-launched ${browserPath} but CDP did not respond on port ${cfg.debugPort} within 8s.`,
  );
}

// Start the idle watchdog that keeps the auto-launched browser warm, then kills
// it after GAI_IDLE_REAP_MS of no open search tab. Detached so it outlives this
// one-shot CLI process; its own PID-file lock prevents duplicates per port.
function spawnIdleReaper(debugPort: number, browserPgid: number): void {
  const reaper = join(import.meta.dir, "idle-reaper.ts");
  const child = spawn(
    "bun",
    [reaper, String(debugPort), String(browserPgid)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}
