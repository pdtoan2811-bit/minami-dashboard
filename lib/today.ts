import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// The Today page's store (§26). One JSON file per day in ~/.minami/today, written first by the vault's
// morning heartbeat (~/secondBrain/bin/morning-heartbeat.mjs, 07:30 via launchd) and then edited here
// as Thomas ticks to-dos, adds his own, answers open questions and logs notes. The heartbeat owns the
// SHAPE (it reads yesterday's file to plan today), so this module only mutates fields it defines.

type HandoffMark = { how: "do" | "decide" | "ask"; sessionId: string; at: string; to?: string };
export type TodayTodo = { id: string; title?: string; text: string; handoff?: HandoffMark; manual?: boolean; done_by?: "auto"; done_evidence?: string; why?: string; focus?: string; folder?: string; est_min?: number; cmd?: string; done: boolean; source: "heartbeat" | "you" | "carried"; done_at?: string };
export type TodayLoop = { id: string; header?: string; handoff?: HandoffMark; recommended?: number; question: string; context?: string; focus?: string; folder?: string; multiSelect?: boolean;
  options: { label: string; description?: string }[]; resolved: null | { answer: string | string[]; at: string } };
export type TodayDay = { date: string; status: "running" | "ready" | "facts-only" | "none"; built_at: string | null; started_at?: string; usd: number | null; error?: string | null; carried?: boolean;
  dropped?: string[]; // ids he dropped — the heartbeat won't re-suggest them on a Rebuild
  headline: string; focus: { id: string; name: string; status: string }[]; todos: TodayTodo[]; loops: TodayLoop[];
  research: { title: string; url: string; takeaway: string; focus?: string }[]; log: { at: string; kind: string; text: string }[] };

// MINAMI_TODAY_DIR is a test seam (the heartbeat honours it too): point a dev server at a scratch dir.
const DIR = process.env.MINAMI_TODAY_DIR || path.join(os.homedir(), ".minami/today");
const HEARTBEAT = path.join(os.homedir(), "secondBrain/bin/morning-heartbeat.mjs");

export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");
const file = (date: string) => path.join(DIR, `${date}.json`);
const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date);

export function readDay(date: string): TodayDay {
  if (!valid(date)) throw new Error("bad date");
  let raw: string;
  try { raw = fs.readFileSync(file(date), "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { date, status: "none", built_at: null, usd: null, headline: "", focus: [], todos: [], loops: [], research: [], log: [] };
    throw e;
  }
  // A file that exists but won't parse must not read as an empty day: the next tick would write that
  // empty day over it. Throwing turns into a 400 and nothing is written.
  try { return JSON.parse(raw); }
  catch { throw new Error(`day file ${date} is unreadable — fix or remove it`); }
}

export function listDays(): string[] {
  try { return fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse(); }
  catch { return []; }
}

function write(day: TodayDay) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file(day.date)}.${process.pid}.${Date.now()}.tmp`; // unique: the heartbeat writes the same file
  fs.writeFileSync(tmp, JSON.stringify(day, null, 1));
  fs.renameSync(tmp, file(day.date)); // atomic: the heartbeat may be reading it
}

const now = () => new Date().toISOString();
const log = (day: TodayDay, kind: string, text: string) => day.log.push({ at: now(), kind, text });

export type TodayAction =
  | { op: "toggle"; id: string; done?: boolean } // `done` makes it idempotent: a stale tab can't flip it back
  | { op: "add"; text: string; focus?: string }
  | { op: "remove"; id: string }
  | { op: "resolve"; id: string; answer: string | string[] }
  | { op: "reopen"; id: string }
  | { op: "note"; text: string };

// A tap aimed at an item that isn't in the file any more (a Rebuild on another device dropped it, or the
// page rolled over to a new day) must fail loudly: a silent 200 told Decide "That's settled" and lost it.
const gone = () => new Error("that item is no longer on this day's plan (it was rebuilt or the day changed) — reload");

export function applyAction(date: string, a: TodayAction): TodayDay {
  const day = readDay(date);
  // Only a real change writes: a no-op used to create the file and flip none→ready, which turned off
  // the heartbeat's carry-over for the day.
  let changed = false;
  switch (a.op) {
    case "toggle": {
      const t = day.todos.find((x) => x.id === a.id); if (!t) throw gone();
      const want = typeof a.done === "boolean" ? a.done : !t.done;
      if (t.done === want) break;
      // `manual`: he decided this one himself, so the auto-tick (vault bin/today-sync.mjs) leaves it alone
      // from now on — it never re-ticks what he unticked, and never second-guesses what he ticked.
      t.done = want; t.done_at = t.done ? now() : undefined; t.manual = true; changed = true;
      if (!want) { delete t.done_by; delete t.done_evidence; }
      log(day, "todo", `${t.done ? "Done" : "Reopened"}: ${t.text}`);
      break;
    }
    case "add": {
      const text = a.text.trim(); if (!text) break;
      const id = crypto.createHash("sha1").update(text + now()).digest("hex").slice(0, 8);
      day.todos.push({ id, text, focus: a.focus || "other", done: false, source: "you" });
      log(day, "todo", `Added: ${text}`); changed = true;
      break;
    }
    case "remove": {
      // A missing id stays a silent no-op: "already gone" is what he asked for, and a double tap mustn't error.
      const t = day.todos.find((x) => x.id === a.id); if (!t) break;
      (day.dropped ||= []).push(t.id);
      day.todos = day.todos.filter((x) => x.id !== a.id);
      log(day, "todo", `Dropped: ${t.text}`); changed = true;
      break;
    }
    case "resolve": {
      const l = day.loops.find((x) => x.id === a.id); if (!l) throw gone();
      // A running chat owns a handed-off answer; changing it here would never reach that chat.
      if (l.handoff) throw new Error("Minami already has this one — change it in the chat");
      l.resolved = { answer: a.answer, at: now() };
      log(day, "decision", `${l.question} → ${[].concat(a.answer as never).join(", ")}`); changed = true;
      break;
    }
    case "reopen": {
      const l = day.loops.find((x) => x.id === a.id); if (!l) throw gone();
      if (l.handoff) throw new Error("Minami already has this one — change it in the chat");
      l.resolved = null;
      log(day, "decision", `Reopened: ${l.question}`); changed = true;
      break;
    }
    case "note": {
      const text = a.text.trim(); if (text) { log(day, "note", text); changed = true; }
      break;
    }
  }
  if (!changed) return day;
  if (day.status === "none") day.status = "ready";
  write(day);
  return day;
}

// ── Hand-offs (§26) ────────────────────────────────────────────────────────────────────────────────
// Three ways out of the page, all born server-side the same way §25's Explain is (a pane can't start
// with a message in it): `do` a to-do, let Minami `decide` a question on the recommended option and act
// on it, or `ask` a teammate through team-ask. Each returns a session id; the client opens /?open=<id>.
// The chat id is stored on the item, so a second tap reopens that chat instead of starting another.
// `starting` covers the 15 s before the mark is written: a double tap or a second device gets turned away.
const starting = new Set<string>();

export type Handoff = { kind: "todo" | "loop"; id: string; how: "do" | "decide" | "ask"; member?: { key: string; name: string; role?: string }; answer?: string | string[] };

// unknown, not string: day files written before the heartbeat coerced loop folders can hold anything.
const expand = (folder?: unknown) => (typeof folder === "string" && folder ? folder.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir());

function handoffPrompt(day: TodayDay, h: Handoff): { message: string; cwd: string } {
  const head = `From my Today page (${day.date}). Today's focus: ${day.focus.map((f) => `${f.name} — ${f.status}`).join(" · ")}`;
  if (h.kind === "todo") {
    const t = day.todos.find((x) => x.id === h.id)!;
    return { cwd: expand(t.folder), message: `${head}\n\nDo this to-do for me, end to end, then tell me in a few lines what you did and what's left:\n\n**${t.title || t.text}**\n${t.title ? t.text + "\n" : ""}${t.why ? `Why: ${t.why}\n` : ""}${t.cmd ? `Suggested command: \`${t.cmd}\`\n` : ""}\nAsk me before anything outward-facing (publishing, Slack, email, spending money).\n\nEnd your last message with one line on its own: `TODAY: done` if the to-do is finished, or `TODAY: blocked — <why>` — my Today page reads it to tick the item.` };
  }
  const l = day.loops.find((x) => x.id === h.id)!;
  const opts = l.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n");
  if (h.how === "ask") {
    const m = h.member!;
    return { cwd: expand(l.folder), message: `${head}\n\nI don't know the answer to this one, so ask ${m.name}${m.role ? ` (${m.role})` : ""} for me with the ask_team tool: assignee "${m.key}", mode "fire" (don't wait). I've already confirmed sending it by tapping "Ask ${m.name}" — don't ask me again. Keep my question and options verbatim, add a short doing/why_now from the context, and a recommendation based on the first option.\n\nQuestion: ${l.question}\nContext: ${l.context || "—"}\nOptions:\n${opts}\n\nAfter it's sent, reply with one line: the ticket and that it's out.` };
  }
  const answer = h.answer ? [].concat(h.answer as never).join(", ") : null;
  return { cwd: expand(l.folder), message: `${head}\n\n${answer ? `I decided: **${answer}**.` : "Decide this for me — take the recommended option unless the facts on disk clearly say otherwise, and tell me which you took and why in one line."}\n\nQuestion: ${l.question}\nContext: ${l.context || "—"}\nOptions:\n${opts}\n\nNow carry it out. Ask me before anything outward-facing (publishing, Slack, email, spending money).` };
}

export async function handoff(date: string, h: Handoff): Promise<{ ok: boolean; sessionId?: string; error?: string; day?: TodayDay }> {
  const { sendMessage, liveStats } = await import("@/lib/agent/manager");
  const day = readDay(date);
  const item = h.kind === "todo" ? day.todos.find((x) => x.id === h.id) : day.loops.find((x) => x.id === h.id);
  if (!item) return { ok: false, error: "not found" };
  if (item.handoff) return { ok: true, sessionId: item.handoff.sessionId, day };
  const lockKey = `${date}:${h.kind}:${h.id}`;
  if (starting.has(lockKey)) return { ok: false, error: "already starting — give it a few seconds" };
  starting.add(lockKey);
  try {
    const { message, cwd } = handoffPrompt(day, h);
    if (!fs.existsSync(cwd)) return { ok: false, error: `folder ${cwd} doesn't exist` };
    const key = `today-${h.how}-${h.id}-${Date.now().toString(36)}`;
    // No `mode`: a hand-off runs like any chat he opens himself (the install default, DEFAULT_PERMISSION_MODE).
    // Pinning "acceptEdits" here made every Today task stop for approval on each shell command.
    let { sessionId } = sendMessage({ key, cwd, message });
    for (let i = 0; !sessionId && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
    }
    if (!sessionId) return { ok: false, error: "the chat didn't start in time — look for it on the board" };
    const fresh = readDay(date); // re-read: the chat took seconds to start and the page may have written since
    const it = (h.kind === "todo" ? fresh.todos : fresh.loops).find((x) => x.id === h.id) as (TodayTodo | TodayLoop) | undefined;
    if (it?.handoff) return { ok: true, sessionId: it.handoff.sessionId, day: fresh }; // another process got there first
    if (it) {
      it.handoff = { how: h.how, sessionId, at: now(), to: h.member?.name };
      // Always overwrite: the stored answer must be the one the chat was given. An earlier pick he
      // backed out of (Decide → Back → "Let Minami decide") is not what Minami was told.
      if (h.kind === "loop" && h.how !== "ask")
        (it as TodayLoop).resolved = { answer: h.answer ?? "Minami decides", at: now() };
    }
    // The chat started either way, so it's logged either way: if a Rebuild dropped the item meanwhile,
    // label it from the copy read before the start rather than logging "undefined".
    const src = (it ?? item) as TodayTodo & TodayLoop;
    log(fresh, "handoff", h.how === "ask" ? `Asked ${h.member?.name}: ${src.question}` : `Handed to Minami: ${src.title || src.text || src.question}`);
    write(fresh);
    return { ok: true, sessionId, day: fresh };
  } finally { starting.delete(lockKey); }
}

// "Run it now" — the same script launchd runs at 07:30, detached so a dashboard restart can't kill it.
export function runHeartbeat(): { started: boolean; reason?: string } {
  const day = readDay(localDate());
  const started = day.started_at ? Date.parse(day.started_at) : 0;
  if (day.status === "running" && Date.now() - started < 20 * 60e3) return { started: false, reason: "already running" };
  const node = fs.existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;
  const out = fs.openSync(path.join(os.homedir(), ".minami/heartbeat.log"), "a");
  spawn(node, [HEARTBEAT], { cwd: path.dirname(path.dirname(HEARTBEAT)), detached: true, stdio: ["ignore", out, out] }).unref();
  return { started: true };
}
