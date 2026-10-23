/**
 * Attention items: one resolve + comment + auto-check store for every "this needs you" flag on the dashboard (§34).
 *
 * Thomas, 2026-10-23, on the Runners tab's "11 videos won't go out on their own": "need a resolve + comment UX like in
 * today to do list … or auto check if things are still not resolve … things like that across the dashboard should need
 * some UX like that — since things have moved but the indicators stale". A flag read from someone else's state file
 * (tiktok-studio's day state, a runner's last exit) keeps saying the same thing after the world moved on — a hold fixed
 * and re-rendered still reads "Held" until the next make — and nothing let him say "handled" or "this one's dropped".
 *
 * The contract, for any panel that flags things:
 *  - The panel calls `track(scope, flags)` on every read with what is flagged NOW: a stable `key`, a `sig` (what the
 *    problem is — its state and reason), and optional `settled` evidence for keys that are no longer flagged.
 *  - Flagged and not resolved → open. Resolved by Thomas with the same sig → stays resolved (he said it's handled).
 *    Resolved but the sig CHANGED → reopens, marked `changed` (the problem is a different one now).
 *  - Was open, and the source no longer flags it → resolved by `auto`, with the evidence the panel gave ("scheduled
 *    16:00", "posted", "the day was archived"), the Today AUTO tick for flags.
 *  - Resolved entries stay listed for 3 days (the "Resolved" fold), then drop out of the file.
 *
 * One JSON file, ~/.minami/attention.json, rewritten only when something changed. Keys are namespaced by scope
 * (`video:2026-10-22 Thu:EN2`), so panels never collide.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = process.env.MINAMI_ATTENTION_FILE || path.join(process.env.MINAMI_HOME || path.join(os.homedir(), ".minami"), "attention.json");
const KEEP_MS = 3 * 24 * 3600e3;

export type AttnComment = { at: string; text: string; to?: "chat" };
export type AttnResolved = { at: string; by: "you" | "auto"; how?: string; note?: string; evidence?: string; sig?: string };
type Meta = Record<string, string>;
type Entry = { scope: string; sig?: string; meta?: Meta; since?: string; changed?: boolean; resolved?: AttnResolved; comments?: AttnComment[]; chat?: string };
type Store = Record<string, Entry>;

/** `meta`: what the fold needs to name it once the source has stopped listing it (a title, a tag). */
export type Flag = { key: string; sig: string; meta?: Meta };
export type AttnView = { key: string; meta?: Meta; status: "open" | "resolved"; since?: string; changed?: boolean; resolved?: AttnResolved; comments: AttnComment[]; chat?: string };

function load(): Store {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")) as Store; } catch { return {}; }
}
function save(s: Store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(s, null, 1));
  fs.renameSync(FILE + ".tmp", FILE);
}
const view = (key: string, e: Entry): AttnView => ({ key, meta: e.meta, status: e.resolved ? "resolved" : "open", since: e.since, changed: e.changed, resolved: e.resolved, comments: e.comments ?? [], chat: e.chat });

/**
 * Reconcile what a panel flags now with what was recorded. Returns a view for every flagged key, plus `settled`: the
 * scope's resolved entries that are no longer flagged (for the fold), newest first.
 */
export function track(scope: string, flags: Flag[], settled: (key: string) => string | undefined = () => undefined): { flagged: Record<string, AttnView>; settled: AttnView[] } {
  const s = load(), now = new Date().toISOString(), live = new Set(flags.map((f) => f.key));
  let dirty = false;
  for (const f of flags) {
    const e = s[f.key];
    if (!e) { s[f.key] = { scope, sig: f.sig, meta: f.meta, since: now }; dirty = true; continue; }
    if (f.meta && JSON.stringify(f.meta) !== JSON.stringify(e.meta)) { e.meta = f.meta; dirty = true; }
    if (e.resolved && (e.resolved.by === "auto" || e.resolved.sig !== f.sig)) {
      // a different problem now, or one the source had stopped flagging is flagged again: open, and say so
      e.changed = true; e.since = now; delete e.resolved; dirty = true;
    }
    if (e.sig !== f.sig) { e.sig = f.sig; dirty = true; }
  }
  for (const [key, e] of Object.entries(s)) {
    if (e.scope !== scope || live.has(key)) continue;
    if (!e.resolved) { e.resolved = { at: now, by: "auto", evidence: settled(key) ?? "no longer flagged", sig: e.sig }; delete e.changed; dirty = true; }
    else if (Date.now() - Date.parse(e.resolved.at) > KEEP_MS) { delete s[key]; dirty = true; }
  }
  if (dirty) save(s);
  const flagged: Record<string, AttnView> = {};
  for (const f of flags) flagged[f.key] = view(f.key, s[f.key]);
  const done = Object.entries(s).filter(([k, e]) => e.scope === scope && !live.has(k) && e.resolved).map(([k, e]) => view(k, e))
    .sort((a, b) => Date.parse(b.resolved!.at) - Date.parse(a.resolved!.at));
  return { flagged, settled: done };
}

/** Thomas's own moves on a flag. Returns the entry as it now stands. */
export function act(b: { op: "resolve" | "reopen" | "comment" | "chat"; key: string; how?: string; note?: string; text?: string; sessionId?: string }): AttnView {
  const s = load(), now = new Date().toISOString();
  const e = s[b.key];
  if (!e) throw new Error(`nothing flagged as ${b.key}`);
  if (b.op === "resolve") {
    e.resolved = { at: now, by: "you", how: b.how?.slice(0, 40), note: b.note?.trim().slice(0, 500) || undefined, sig: e.sig };
    delete e.changed;
  } else if (b.op === "reopen") {
    delete e.resolved; e.since = now;
  } else if (b.op === "comment") {
    const text = b.text?.trim().slice(0, 1000);
    if (!text) throw new Error("empty comment");
    (e.comments ??= []).push({ at: now, text });
  } else if (b.op === "chat") {
    e.chat = b.sessionId;
    if (b.text?.trim()) (e.comments ??= []).push({ at: now, text: b.text.trim().slice(0, 1000), to: "chat" });
  }
  save(s);
  return view(b.key, e);
}
