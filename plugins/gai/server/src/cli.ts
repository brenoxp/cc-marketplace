#!/usr/bin/env bun

import { disconnectBrowser, executeSearch } from "./search.js";
import {
  loadRequest,
  makeRequestId,
  saveRequest,
  type CachedRequest,
} from "./cache.js";
import { execSync } from "child_process";

type OutputFormat = "md" | "text" | "json";

function openInMdViewer(markdown: string, query: string): void {
  const tmpDir = process.env.TMPDIR || "/tmp";
  const slug = query
    .split("\n")[0]
    .slice(0, 50)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+$/, "");
  const tmpFile = `${tmpDir}/gais-${slug}.md`;
  const { writeFileSync } = require("fs");
  writeFileSync(tmpFile, markdown, "utf-8");
  execSync(`hs -c "require('modules.md_viewer').open('${tmpFile}')"`, {
    stdio: "ignore",
  });
}

function usage() {
  console.log(`Usage: gai [-t text|md|json] [-v] <query>

Options:
  -t <fmt>    Output format: text (default), md (markdown via copy button, piped through glow), or json
  -v          Open results in Hammerspoon md_viewer
  -k          Keep Google AI tab open (don't close after search)
  --id <hash> Replay a saved request by id (no browser, served from disk)
  -h          Show this help

Every response ends with a request id (e.g. [id: a1b2c3d4]). Pass it back with
--id to re-print the exact same result without hitting the browser again.

Pipe:
  Accepts piped stdin as context. Query becomes the question about the content.
  If no query arg given with piped input, defaults to "Explain the following".

Examples:
  gai "latest bun runtime features"
  gai -t md "query"          # or use gaimd shortcut
  gai -t json "query" | jq
  gai "query" | jq '.answer' # auto-JSON when piped
  cat file.js | gai "explain this"
  git diff | gai "review these changes"
  cat file | gai`);
  process.exit(0);
}

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;

// Strip Google AI citation cruft from captured markdown: the bottom numbered
// reference list, standalone source-title link lines, inline [1, 2] markers,
// and inline hyperlinks (unwrapped to plain text).
function stripReferences(markdown: string): string {
  const lines = markdown.split("\n").filter((line) => {
    const trimmed = line.trim();
    // Bottom numbered reference list: "[1] [https://...](...)"
    if (/^\[\d+\]\s+\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed)) return false;
    // Standalone line made up only of markdown links (source-title rows)
    const withoutLinks = trimmed.replace(MARKDOWN_LINK, "").trim();
    if (trimmed.length > 0 && withoutLinks.length === 0) return false;
    return true;
  });

  let out = lines.join("\n");
  // Inline citation markers: [1], [1, 2, 3]
  out = out.replace(/\s*\[\d+(?:,\s*\d+)*\]/g, "");
  // Unwrap remaining inline hyperlinks to their text
  out = out.replace(MARKDOWN_LINK, "$1");
  // Collapse whitespace left behind
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function pipeToGlow(content: string): void {
  execSync("glow", { input: content, stdio: ["pipe", "inherit", "inherit"] });
}


const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage();
if (args.length === 0 && process.stdin.isTTY) usage();

let fmt: OutputFormat = "text";
let fmtExplicit = false;
let viewInMdViewer = false;
let replayId = "";
const queryParts: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-t" && i + 1 < args.length) {
    fmt = args[++i] as OutputFormat;
    fmtExplicit = true;
  } else if (args[i] === "--id" && i + 1 < args.length) {
    replayId = args[++i];
  } else if (args[i] === "-k") {
    process.env.GAIS_KEEP_TAB = "1";
  } else if (args[i] === "-v") {
    viewInMdViewer = true;
  } else {
    queryParts.push(args[i]);
  }
}

// Render a request under the requested output format. The cache holds the raw
// markdown capture, so any format (including a different -t on --id replay)
// derives from the same source. References are stripped everywhere except the
// md_viewer, where the source links stay clickable.
function emit(
  req: CachedRequest,
  fmt: OutputFormat,
  fmtExplicit: boolean,
  viewInMdViewer: boolean,
): void {
  const { query, url, id, answer: raw } = req;
  const clean = stripReferences(raw);
  const piped = !process.stdout.isTTY;

  if (fmt === "json" || (piped && !fmtExplicit)) {
    console.log(JSON.stringify({ query, answer: clean, id }, null, 2));
  } else if (viewInMdViewer) {
    const withUrl = url ? `[Source](${url})\n\n---\n\n${raw}` : raw;
    openInMdViewer(withUrl, query);
    console.log(`[id: ${id}]`);
  } else if (fmt === "md" && !piped) {
    pipeToGlow(clean);
    console.log(`\n[id: ${id}]`);
  } else {
    // piped raw, or plain text mode
    console.log(clean);
    console.log(`\n[id: ${id}]`);
  }
}

// Replay path: serve a saved request from disk under the live flags, no browser.
if (replayId) {
  const cached = loadRequest(replayId);
  if (!cached) {
    console.error(`Error: no saved request with id "${replayId}"`);
    process.exit(1);
  }
  emit(cached, fmt, fmtExplicit, viewInMdViewer);
  process.exit(0);
}

// Read piped stdin if available
let stdinContent = "";
if (!process.stdin.isTTY) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  stdinContent = Buffer.concat(chunks).toString("utf-8").trim();
}

const queryText = queryParts.join(" ");
if (!queryText && !stdinContent) {
  console.error("Error: no query provided");
  process.exit(1);
}

const query = stdinContent
  ? `${queryText || "Explain the following"}\n\n---\n\n${stdinContent}`
  : queryText;

try {
  const { answer, url } = await executeSearch(query);
  const req: CachedRequest = {
    id: makeRequestId(query, answer),
    query,
    answer,
    url: url ?? "",
    timestamp: new Date().toISOString(),
  };
  saveRequest(req);
  emit(req, fmt, fmtExplicit, viewInMdViewer);
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
} finally {
  await disconnectBrowser();
}
