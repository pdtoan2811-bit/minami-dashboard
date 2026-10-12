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
export type TodayTodo = { id: string; title?: string; text: string; handoff?: HandoffMark; why?: string; focus?: string; folder?: string; est_min?: number; cmd?: string; done: boolean; source: "heartbeat" | "you" | "carried"; done_at?: string };
export type TodayLoop = { id: string; header?: string; handoff?: HandoffMark; recommended?: number; question: string; context?: string; focus?: string; folder?: string; multiSelect?: boolean;
  options: { label: string; description?: string }[]; resolved: null | { answer: string | string[]; at: string } };
export type TodayDay = { date: string; status: "running" | "ready" | "facts-only" | "none"; built_at: string | null; started_at?: string; usd: number | null; error?: string | null;
  headline: string; focus: { id: string; name: string; status: string }[]; todos: TodayTodo[]; loops: TodayLoop[];
  research: { title: string; url: string; takeaway: string; focus?: string }[]; log: { at: string; kind: string; text: string }[] };

const DIR = path.join(os.homedir(), ".minami/today");
const HEARTBEAT = path.join(os.homedir(), "secondBrain/bin/morning-heartbeat.mjs");

export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");
const file = (date: string) => path.join(DIR, `${date}.json`);
const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date);

export function readDay(date: string): TodayDay {
  if (!valid(date)) throw new Error("bad date");
  try { return JSON.parse(fs.readFileSync(file(date), "utf8")); }
  catch { return { date, status: "none", built_at: null, usd: null, headline: "", focus: [], todos: [], loops: [], research: [], log: [] }; }
}

export function listDays(): string[] {
  try { return fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse(); }
  catch { return []; }
}

function write(day: TodayDay) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file(day.date) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(day, null, 1));
  fs.renameSync(tmp, file(day.date)); // atomic: the heartbeat may be reading it
}

const now = () => new Date().toISOString();
const log = (day: TodayDay, kind: string, text: string) => day.log.push({ at: now(), kind, text });

export type TodayAction =
  | { op: "toggle"; id: string }
  | { op: "add"; text: string; focus?: string }
  | { op: "remove"; id: string }
  | { op: "resolve"; id: string; answer: string | string[] }
  | { op: "reopen"; id: string }
  | { op: "note"; text: string };

export function applyAction(date: string, a: TodayAction): TodayDay {
  const day = readDay(date);
  if (day.status === "none") day.status = "ready";
  switch (a.op) {
    case "toggle": {
      const t = day.todos.find((x) => x.id === a.id); if (!t) break;
      t.done = !t.done; t.done_at = t.done ? now() : undefined;
      log(day, "todo", `${t.done ? "Done" : "Reopened"}: ${t.text}`);
      break;
    }
    case "add": {
      const text = a.text.trim(); if (!text) break;
      const id = crypto.createHash("sha1").update(text + now()).digest("hex").slice(0, 8);
      day.todos.push({ id, text, focus: a.focus || "other", done: false, source: "you" });
      log(day, "todo", `Added: ${text}`);
      break;
    }
    case "remove": {
      const t = day.todos.find((x) => x.id === a.id); if (!t) break;
      day.todos = day.todos.filter((x) => x.id !== a.id);
      log(day, "todo", `Dropped: ${t.text}`);
      break;
    }
    case "resolve": {
      const l = day.loops.find((x) => x.id === a.id); if (!l) break;
      l.resolved = { answer: a.answer, at: now() };
      log(day, "decision", `${l.question} → ${[].concat(a.answer as never).join(", ")}`);
      break;
    }
    case "reopen": {
      const l = day.loops.find((x) => x.id === a.id); if (!l) break;
      l.resolved = null;
      log(day, "decision", `Reopened: ${l.question}`);
      break;
    }
    case "note": {
      const text = a.text.trim(); if (text) log(day, "note", text);
      break;
    }
  }
  write(day);
  return day;
}

// ── Hand-offs (§26) ────────────────────────────────────────────────────────────────────────────────
// Three ways out of the page, all born server-side the same way §25's Explain is (a pane can't start
// with a message in it): `do` a to-do, let Minami `decide` a question on the recommended option and act
// on it, or `ask` a teammate through team-ask. Each returns a session id; the client opens /?open=<id>.
// The chat id is stored on the item, so a second tap reopens that chat instead of starting another.

export type Handoff = { kind: "todo" | "loop"; id: string; how: "do" | "decide" | "ask"; member?: { key: string; name: string; role?: string }; answer?: string | string[] };

const expand = (folder?: string) => (folder ? folder.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir());

function handoffPrompt(day: TodayDay, h: Handoff): { message: string; cwd: string } {
  const head = `From my Today page (${day.date}). Today's focus: ${day.focus.map((f) => `${f.name} — ${f.status}`).join(" · ")}`;
  if (h.kind === "todo") {
    const t = day.todos.find((x) => x.id === h.id)!;
    return { cwd: expand(t.folder), message: `${head}\n\nDo this to-do for me, end to end, then tell me in a few lines what you did and what's left:\n\n**${t.title || t.text}**\n${t.title ? t.text + "\n" : ""}${t.why ? `Why: ${t.why}\n` : ""}${t.cmd ? `Suggested command: \`${t.cmd}\`\n` : ""}\nAsk me before anything outward-facing (publishing, Slack, email, spending money).` };
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
  const { message, cwd } = handoffPrompt(day, h);
  if (!fs.existsSync(cwd)) return { ok: false, error: `folder ${cwd} doesn't exist` };
  const key = `today-${h.how}-${h.id}-${Date.now().toString(36)}`;
  let { sessionId } = sendMessage({ key, cwd, message, mode: "acceptEdits" });
  for (let i = 0; !sessionId && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
  }
  if (!sessionId) return { ok: false, error: "the chat didn't start in time — look for it on the board" };
  const fresh = readDay(date); // re-read: the chat took seconds to start and the page may have written since
  const it = (h.kind === "todo" ? fresh.todos : fresh.loops).find((x) => x.id === h.id) as (TodayTodo | TodayLoop) | undefined;
  if (it) {
    it.handoff = { how: h.how, sessionId, at: now(), to: h.member?.name };
    if (h.kind === "loop" && h.how !== "ask" && !(it as TodayLoop).resolved)
      (it as TodayLoop).resolved = { answer: h.answer ?? "Minami decides", at: now() };
  }
  log(fresh, "handoff", h.how === "ask" ? `Asked ${h.member?.name}: ${(it as TodayLoop)?.question}` : `Handed to Minami: ${(it as TodayTodo)?.title || (it as TodayTodo)?.text || (it as TodayLoop)?.question}`);
  write(fresh);
  return { ok: true, sessionId, day: fresh };
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
