import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// Ideas (§28): the stash of things Thomas reads or finds funny — links, memes, screenshots, forwarded
// messages, half-thoughts — captured by DMing Minami in Slack (~/Minami/src/ideas.js) or dropped on
// /ideas. The bot owns capture and the reading/tagging of each item; this module only READS the store,
// ranks it, and applies the page's small edits (🔥, comment, remove). One JSON file per item:
//   ~/.minami/ideas/items/<date>/<id>.json      media/<id>-<n>.<ext>
// Same layout and atomic-rename writes as the bot, so either side may write while the other reads.

export type IdeaLink = { url: string; ok?: boolean; title?: string; description?: string; site?: string; image?: string; via?: string };
export type IdeaFile = { name?: string; mime?: string; path?: string; bytes?: number; skipped?: string };
export type Idea = {
  id: string; at: string; date: string; source: "slack" | "dashboard";
  slack?: { team: string; channel: string; ts: string };
  text?: string; note?: string; shared?: string; links: IdeaLink[]; files: IdeaFile[];
  status: "enriching" | "ready" | "failed"; error?: string;
  kind?: string; title?: string; gist?: string; tags?: string[]; why?: string; lang?: string;
  comments: { at: string; text: string }[];
  /** He marked it 🔥 on the page. */
  starred?: string;
  removed?: { at: string; why: string };
};
export type Heat = "hot" | "warm" | "cold";
export type RankedIdea = Idea & { score: number; heat: Heat; echo: number; cameBack?: boolean };
export type Theme = { tag: string; count: number; recent: number; trend: "up" | "flat" | "down" };

export const DIR = process.env.MINAMI_IDEAS_DIR || path.join(os.homedir(), ".minami/ideas");
const ITEMS = path.join(DIR, "items");
export const MEDIA = path.join(DIR, "media");
const INBOX = path.join(DIR, "inbox");
// The bot's checkout: the drop box saves through its code, so Slack and the page tag items the same way.
const BOT = process.env.MINAMI_BOT_DIR || path.join(os.homedir(), "Minami");
const NODE = fs.existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;
const DAY = 86400e3;

function readAll(): Idea[] {
  if (!fs.existsSync(ITEMS)) return [];
  const out: Idea[] = [];
  for (const d of fs.readdirSync(ITEMS)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    for (const f of fs.readdirSync(path.join(ITEMS, d))) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(ITEMS, d, f), "utf8"))); } catch { /* mid-write or corrupt: skip, next poll gets it */ }
    }
  }
  return out;
}

function fileOf(it: Idea) { return path.join(ITEMS, it.date, `${it.id}.json`); }
function write(it: Idea) {
  const f = fileOf(it), tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(it, null, 1));
  fs.renameSync(tmp, f);
}
function find(id: string): Idea {
  const it = readAll().find((x) => x.id === id);
  if (!it) throw new Error("that item is gone — reload");
  return it;
}

/** Hot / warm / cold, and why. Deliberately a few readable terms, not a model:
 *   recency  — fades with a 3-day half-life
 *   echo     — other items in the last 14 days sharing a tag: a theme building up across days
 *   touch    — he starred it (🔥) or commented on it
 *   fit      — the tagger found a concrete use in one of his projects (`why`)
 *  Cold = nothing pulls it up: older than ~2 weeks, untouched, no echo. A cold item that a NEW item
 *  (last 2 days) echoes "came back" and is lifted to warm — the thing he saved a month ago that is
 *  suddenly relevant again is the point of keeping cold items at all. */
export function rank(items: Idea[], now = Date.now()): RankedIdea[] {
  const live = items.filter((x) => !x.removed);
  const recentTags = (since: number, except: string) => {
    const m = new Map<string, number>();
    for (const x of live) if (x.id !== except && Date.parse(x.at) >= since) for (const t of x.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const fresh = recentTags(now - 2 * DAY, "");
  return live.map((x) => {
    const age = (now - Date.parse(x.at)) / DAY;
    const recency = Math.pow(0.5, age / 3);
    const window = recentTags(now - 14 * DAY, x.id);
    const echo = (x.tags ?? []).reduce((n, t) => n + (window.get(t) ?? 0), 0);
    const touch = (x.starred ? 1 : 0) + Math.min(0.6, 0.3 * (x.comments?.length ?? 0));
    const fit = x.why ? 0.2 : 0;
    let score = recency + Math.min(1, echo / 4) * 0.8 + touch + fit;
    const cameBack = age > 14 && !touch && (x.tags ?? []).some((t) => fresh.has(t));
    if (cameBack) score = Math.max(score, 0.5);
    const heat: Heat = x.starred || score >= 0.9 ? "hot" : score >= 0.35 ? "warm" : "cold";
    return { ...x, score: Math.round(score * 100) / 100, heat, echo, cameBack: cameBack || undefined };
  }).sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
}

/** Tags seen at least twice in the last 30 days, with a direction: the last 3 days vs. the 27 before. */
export function themes(items: Idea[], now = Date.now()): Theme[] {
  const m = new Map<string, { count: number; recent: number }>();
  for (const x of items) {
    if (x.removed || Date.parse(x.at) < now - 30 * DAY) continue;
    const recent = Date.parse(x.at) >= now - 3 * DAY;
    for (const t of x.tags ?? []) { const e = m.get(t) ?? { count: 0, recent: 0 }; e.count++; if (recent) e.recent++; m.set(t, e); }
  }
  return [...m.entries()].filter(([, e]) => e.count >= 2).map(([tag, e]) => {
    const before = (e.count - e.recent) / 27, lately = e.recent / 3;
    return { tag, ...e, trend: (lately > before * 1.5 && e.recent >= 2 ? "up" : e.recent === 0 && e.count >= 3 ? "down" : "flat") as Theme["trend"] };
  }).sort((a, b) => b.recent - a.recent || b.count - a.count).slice(0, 12);
}

export function list() {
  const all = readAll();
  return { items: rank(all), themes: themes(all), removed: all.filter((x) => x.removed).length };
}

export type IdeaAction =
  | { op: "star"; id: string; on: boolean }
  | { op: "comment"; id: string; text: string }
  | { op: "remove"; id: string }
  | { op: "retry"; id: string };

export function apply(a: IdeaAction): Idea {
  const it = find(a.id);
  switch (a.op) {
    case "star": if (a.on) it.starred = new Date().toISOString(); else delete it.starred; break;
    case "comment": { const t = a.text.trim(); if (!t) return it; (it.comments ||= []).push({ at: new Date().toISOString(), text: t }); break; }
    case "remove": it.removed = { at: new Date().toISOString(), why: "removed on the page" }; break;
    case "retry": it.status = "enriching"; write(it); runBot(["--retry", it.id]); return it;
  }
  write(it);
  return it;
}

/** The drop box: files land in the inbox, then the bot's own code reads and tags them, detached (a deploy
 *  restarts this server; the 10–60 s read must survive that, as Today's research run does). */
export function add(text: string, files: { name: string; mime: string; data: Buffer }[]): { id: string } {
  if (!text.trim() && !files.length) throw new Error("nothing to save");
  if (!fs.existsSync(path.join(BOT, "bin/ideas-add.mjs"))) throw new Error(`Minami's code isn't at ${BOT} (set MINAMI_BOT_DIR)`);
  const id = crypto.randomBytes(5).toString("hex");
  const dir = path.join(INBOX, id);
  fs.mkdirSync(dir, { recursive: true });
  const saved = files.map((f, n) => {
    const p = path.join(dir, `${n}-${path.basename(f.name).replace(/[^\w.-]+/g, "_")}`);
    fs.writeFileSync(p, f.data);
    return { path: p, name: f.name, mime: f.mime };
  });
  const req = path.join(dir, "request.json");
  fs.writeFileSync(req, JSON.stringify({ id, text, files: saved }));
  runBot([req]);
  return { id };
}

function runBot(args: string[]) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = fs.openSync(path.join(os.homedir(), ".minami/ideas-add.log"), "a");
  spawn(NODE, [path.join(BOT, "bin/ideas-add.mjs"), ...args], { cwd: BOT, detached: true, stdio: ["ignore", out, out] }).unref();
}

/** A saved file, only from the media dir (the id and index come from the URL). */
export function mediaPath(id: string, n: number): string | null {
  if (!/^[0-9a-f]{6,16}$/.test(id) || !Number.isInteger(n) || n < 0) return null;
  const it = readAll().find((x) => x.id === id);
  const p = it?.files?.[n]?.path;
  if (!p) return null;
  const abs = path.resolve(p);
  return abs.startsWith(path.resolve(MEDIA) + path.sep) && fs.existsSync(abs) ? abs : null;
}
