#!/usr/bin/env node
/*
 * Minami metrics API — collects Claude Code usage events from every machine (local Mac +
 * the Minami cloud host) and serves live aggregates to the dashboard. Zero deps: Node http + JSONL.
 * Self-hosted on the Hetzner box, exposed via Tailscale Funnel (free *.ts.net HTTPS, no domain).
 *
 * Env (see ~/.minami-metrics.env, git-ignored):
 *   PORT           default 8787
 *   BIND           interface to listen on, default 127.0.0.1 (loopback only).
 *                  Tailscale Funnel proxies to 127.0.0.1:8787, so loopback is all that is ever
 *                  needed. Do NOT set 0.0.0.0 — that publishes the API to the raw internet on a
 *                  box with no firewall, leaving READ_KEY/INGEST_TOKEN as the only wall.
 *   METRICS_DIR    where events.jsonl lives (default ~/.minami-metrics)
 *   INGEST_TOKEN   REQUIRED bearer token for POST /ingest (write auth — real)
 *   READ_KEY       optional key for GET /stats & /stream (?k=...) — obscurity, gate the deploy for real privacy
 *
 * Endpoints:
 *   POST /ingest  { source, session, cwd?, model, label?, reply?, inputTokens, outputTokens, cacheReadTokens?, tool?, ts? }
 *   GET  /stats   -> aggregated JSON (per source / per model / totals / recent)
 *   GET  /projects -> latest checkpoint per cwd (the "what are we doing here" cross-device digest —
 *                     derived from the same event stream, no separate storage; naturally self-pruning
 *                     since it's always just "most recent event per cwd", not an accumulating log)
 *   GET  /stream  -> SSE, pushes each new event as it lands (true real-time, no polling)
 *   GET  /health  -> { ok: true }
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = Number(process.env.PORT || 8787);
const BIND = process.env.BIND || "127.0.0.1";
const DIR = process.env.METRICS_DIR || path.join(os.homedir(), ".minami-metrics");
const EVENTS = path.join(DIR, "events.jsonl");
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const READ_KEY = process.env.READ_KEY || "";

fs.mkdirSync(DIR, { recursive: true });

// Unlike the Next app (which got a global instrumentation.ts handler in the last stability pass), this
// standalone script had NO process-level safety net at all — any uncaught throw takes the whole process
// down. systemd restarts it (Restart=always), but every connected dashboard's SSE stream drops and any
// in-flight /ingest from another machine is lost. Log-and-continue for rejections (nothing here holds
// state that a stray rejection would leave corrupted); exit on a genuine uncaught exception so systemd
// gets a clean restart rather than continuing in a possibly-inconsistent state.
process.on("unhandledRejection", (e) => { console.error("[metrics] unhandled rejection:", e); });
process.on("uncaughtException", (e) => { console.error("[metrics] uncaught exception:", e); process.exit(1); });

// Prices per MTok — mirror lib/routing.ts. Cache reads are billed at 0.1x input.
const PRICES = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
};
function priceFor(model) {
  if (!model) return { in: 5, out: 25 };
  const key = Object.keys(PRICES).find((k) => model.includes(k));
  return key ? PRICES[key] : { in: 5, out: 25 };
}
function costOf(e) {
  const p = priceFor(e.model);
  return (
    ((e.inputTokens || 0) + (e.cacheReadTokens || 0) * 0.1) / 1e6 * p.in +
    (e.outputTokens || 0) / 1e6 * p.out
  );
}
// What the same turn WOULD cost on Opus — the baseline savings are measured against.
// Track the current default tier (Opus 5), same as lib/routing.ts. Identical $5/$25 to Opus 4.8
// today, so this changes no number — it just stops the baseline drifting if the prices diverge.
const OPUS = PRICES["claude-opus-5"];
function opusOf(e) {
  return ((e.inputTokens || 0) + (e.cacheReadTokens || 0) * 0.1) / 1e6 * OPUS.in + (e.outputTokens || 0) / 1e6 * OPUS.out;
}

const sseClients = new Set();
function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { /* client gone */ }
  }
}

function readEvents() {
  try {
    return fs
      .readFileSync(EVENTS, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function aggregate() {
  const evs = readEvents();
  const bySource = {}, byModel = {};
  let totalIn = 0, totalOut = 0, cost = 0, opusCost = 0;
  for (const e of evs) {
    const c = costOf(e);
    cost += c;
    opusCost += opusOf(e);
    totalIn += e.inputTokens || 0;
    totalOut += e.outputTokens || 0;
    const s = (bySource[e.source] ||= { source: e.source, events: 0, inTok: 0, outTok: 0, cost: 0, lastTs: 0 });
    s.events++; s.inTok += e.inputTokens || 0; s.outTok += e.outputTokens || 0; s.cost += c;
    s.lastTs = Math.max(s.lastTs, e.ts || 0);
    const m = (byModel[e.model || "unknown"] ||= { model: e.model || "unknown", events: 0, tok: 0, cost: 0 });
    m.events++; m.tok += (e.inputTokens || 0) + (e.outputTokens || 0); m.cost += c;
  }
  return {
    totals: { events: evs.length, inTok: totalIn, outTok: totalOut, cost, opusCost },
    bySource: Object.values(bySource).sort((a, b) => b.cost - a.cost),
    byModel: Object.values(byModel).sort((a, b) => b.cost - a.cost),
    recent: evs.slice(-25).reverse(),
    updated: Date.now(),
  };
}

function send(res, code, body, extra) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  if (url.pathname === "/health") return send(res, 200, { ok: true });

  if (url.pathname === "/ingest" && req.method === "POST") {
    const auth = req.headers.authorization || "";
    if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) return send(res, 401, { error: "unauthorized" });
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let e;
      try { e = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
      // JSON.parse("null") succeeds (returns null, no exception) — the catch above never fires for it,
      // and `e.ts = ...` on null/undefined throws a TypeError with nothing catching it, killing the
      // whole process (confirmed: this file had no uncaughtException handler before the fix above).
      // A concrete trigger: any client bug that serializes a null payload to /ingest.
      if (!e || typeof e !== "object") return send(res, 400, { error: "bad json" });
      e.ts = e.ts || Date.now();
      e.source = String(e.source || "unknown").slice(0, 40);
      try { fs.appendFileSync(EVENTS, JSON.stringify(e) + "\n"); } catch { /* disk */ }
      broadcast(e);
      send(res, 200, { ok: true });
    });
    return;
  }

  // Read endpoints — optional obscurity key (EventSource can't set headers, so via ?k=).
  if (READ_KEY && url.searchParams.get("k") !== READ_KEY) return send(res, 401, { error: "unauthorized" });

  if (url.pathname === "/stats") return send(res, 200, aggregate());

  // Latest per-project checkpoint — the cross-device "resume point" digest. Walks events once,
  // keeps only the most recent event per cwd. Events without a cwd (older clients, pre-digest)
  // are skipped rather than bucketed under "unknown" — a label-less checkpoint isn't useful.
  if (url.pathname === "/projects") {
    const byCwd = {};
    for (const e of readEvents()) {
      if (!e.cwd) continue;
      const cur = byCwd[e.cwd];
      if (!cur || (e.ts || 0) >= (cur.ts || 0)) {
        byCwd[e.cwd] = {
          cwd: e.cwd,
          project: e.cwd.split("/").filter(Boolean).pop() || e.cwd,
          label: e.label || "",
          reply: e.reply || "",
          model: e.model || "",
          source: e.source || "",
          ts: e.ts || 0,
        };
      }
    }
    const projects = Object.values(byCwd).sort((a, b) => b.ts - a.ts);
    return send(res, 200, { projects, updated: Date.now() });
  }

  if (url.pathname === "/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify({ hello: true })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 25000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // Per-day usage buckets for the last N days (for the calendar/cohort heatmap).
  // tz = client's getTimezoneOffset() in minutes, so days bucket in the viewer's local time.
  if (url.pathname === "/timeseries") {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
    const tz = Number(url.searchParams.get("tz")) || 0;
    const localKey = (ts) => new Date((ts || 0) - tz * 60000).toISOString().slice(0, 10);
    const now = Date.now();
    const cutoff = now - days * 86400000;
    const byDay = {};
    for (const e of readEvents()) {
      if ((e.ts || 0) < cutoff) continue;
      const k = localKey(e.ts);
      const b = (byDay[k] ||= { date: k, turns: 0, tokens: 0, cost: 0 });
      b.turns++; b.tokens += (e.inputTokens || 0) + (e.outputTokens || 0); b.cost += costOf(e);
    }
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const k = localKey(now - i * 86400000);
      out.push(byDay[k] || { date: k, turns: 0, tokens: 0, cost: 0 });
    }
    return send(res, 200, { days: out });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, BIND, () => console.log(`minami-metrics listening on ${BIND}:${PORT} (dir=${DIR})`));
