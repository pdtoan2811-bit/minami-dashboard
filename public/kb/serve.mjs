#!/usr/bin/env node
// Minami Bento — Knowledge Base, standalone.
//
// Serves public/kb/ as its own little app so the docs are readable when the dashboard isn't
// running. That matters more than it sounds: `bin/serve.sh` tears :3000 down on every deploy and
// refuses to restart while a turn is in flight, so the KB — the thing you most want to read while
// something is broken — would otherwise be unavailable exactly when you need it.
//
//   node public/kb/serve.mjs          # → http://localhost:4400
//   npm run kb                        # same thing
//   KB_PORT=4500 node public/kb/serve.mjs
//   node public/kb/serve.mjs --no-open
//
// No build, no deps — just Node. Resolves its own root from import.meta.url, so cwd doesn't matter
// and you can launch it by double-clicking the .command file from anywhere.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, dirname, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// Deliberately KB_PORT, never bare PORT. `PORT` is already spoken for in this repo — bin/serve.sh
// sets it for the Next server and it is commonly exported in the shell. Reading it here bound this
// server to 127.0.0.1:3000 *alongside* the dashboard's IPv6 wildcard (macOS permits that pairing),
// so requests to localhost:3000 split between two servers at random. Verified 2026-07-29.
const BASE_PORT = Number(process.env.KB_PORT) || 4400;
const OPEN = !process.argv.includes("--no-open");

// The dashboard's own port — probed (not assumed) so the hub can tell you whether the pages that
// need a running Next server are actually reachable right now.
const APP_PORT = Number(process.env.MINAMI_APP_PORT) || 3000;

if (BASE_PORT === APP_PORT) {
  console.error(`\n  ✖ KB_PORT (${BASE_PORT}) is the dashboard's port. Pick another — sharing it\n` +
                `    silently splits traffic between two servers rather than failing cleanly.\n`);
  process.exit(2);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
};

// Probe BOTH stacks: servers bind "localhost" inconsistently (some → ::1, some → 127.0.0.1), so
// checking a single family gives false negatives.
function probe(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeout);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}
const portOpen = (port) =>
  Promise.all([probe("127.0.0.1", port), probe("::1", port)]).then((r) => r.some(Boolean));

// Resolve a request path to a real file inside HERE, or null. Rejects anything that escapes the
// directory — this serves from a fixed root, so `../` must never resolve outside it.
async function resolveFile(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const abs = normalize(join(HERE, rel));
  if (abs !== HERE && !abs.startsWith(HERE + "/")) return null; // traversal attempt
  try {
    const s = await stat(abs);
    if (s.isDirectory()) return resolveFile(pathname.replace(/\/?$/, "/"));
    return abs;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${server.__port}`);

    // What the hub needs to know that a static file can't tell it: is the dashboard up, so are the
    // app-served pages (the module map) reachable, and on what origin.
    if (url.pathname === "/api/state") {
      const running = await portOpen(APP_PORT);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({
        standalone: true,
        kbPort: server.__port,
        app: { port: APP_PORT, running, url: `http://localhost:${APP_PORT}` },
      }));
    }

    const file = await resolveFile(url.pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Not found.\n\nThe knowledge base serves public/kb/ only.\nTry /  →  the hub.");
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      // These are local docs edited in place — never let a browser cache hide a fresh edit.
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("KB server error: " + (e?.message || e));
  }
});

// If the port is taken, walk up rather than dying — the whole point of this server is to be
// available when other things are in a bad state, so it shouldn't be fragile about a stale process.
function listen(port, attempt = 0) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attempt < 10) return listen(port + 1, attempt + 1);
    console.error(`\n  ✖ could not bind :${port} — ${e.message}\n`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", async () => {
    server.__port = port;
    const url = `http://localhost:${port}`;
    const dim = (s) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s) => `\x1b[1m${s}\x1b[0m`;
    const app = await portOpen(APP_PORT);
    console.log(`\n  🌸 ${bold("Minami Bento — Knowledge Base")}`);
    console.log(`  ▸ ${url}`);
    console.log(dim(`  serving ${HERE}`));
    console.log(dim(`  dashboard on :${APP_PORT} — ${app ? "running (module map available)" : "not running (module map will show offline)"}`));
    console.log(dim("  ctrl-c to stop\n"));
    if (OPEN) {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try { spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref(); } catch { /* headless is fine */ }
    }
  });
}
listen(BASE_PORT);
