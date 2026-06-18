import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type BrowserMode = "connect" | "launch";

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

  const envMode =
    process.env.GAI_BROWSER_MODE === "launch"
      ? "launch"
      : process.env.GAI_BROWSER_MODE === "connect"
        ? "connect"
        : undefined;

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
    mode: envMode ?? fromFile.mode ?? DEFAULTS.mode,
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
        `Run /gai:gai-config to configure, or start the browser manually with ` +
        `--remote-debugging-port=${cfg.debugPort}.`,
    );
  }
  if (!existsSync(cfg.browserPath)) {
    throw new Error(
      `Auto-launch failed: browserPath does not exist: ${cfg.browserPath}`,
    );
  }
  if (!existsSync(cfg.userDataDir)) {
    mkdirSync(cfg.userDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${cfg.debugPort}`,
    `--user-data-dir=${cfg.userDataDir}`,
  ];

  const child = spawn(cfg.browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll CDP until it answers (max ~8s)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isDebugReachable(cfg)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Auto-launched ${cfg.browserPath} but CDP did not respond on port ${cfg.debugPort} within 8s.`,
  );
}
