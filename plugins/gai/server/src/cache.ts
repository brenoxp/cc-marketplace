import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";

const CACHE_DIR = join(getConfigDir(), "cache");

export interface CachedRequest {
  id: string;
  query: string;
  answer: string; // raw markdown capture; all output formats derive from this
  url: string;
  timestamp: string;
}

// Short content hash used as the request id appended to every response.
// Re-rolls on disk collision so a 4-char id never overwrites another request;
// widens to 8 chars only if 4 chars stay contended after many attempts.
export function makeRequestId(query: string, answer: string): string {
  const now = Date.now();
  const hash = (len: number, salt: number) =>
    createHash("sha256")
      .update(`${query}\n${answer}\n${now}\n${salt}`)
      .digest("hex")
      .slice(0, len);
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = hash(4, attempt);
    if (!existsSync(join(CACHE_DIR, `${id}.json`))) return id;
  }
  return hash(8, now);
}

export function saveRequest(req: CachedRequest): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    join(CACHE_DIR, `${req.id}.json`),
    JSON.stringify(req, null, 2) + "\n",
    "utf8",
  );
}

export function loadRequest(id: string): CachedRequest | null {
  const file = join(CACHE_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CachedRequest;
  } catch {
    return null;
  }
}
