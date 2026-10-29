"use client";
// The Ask line's three small jobs (§37): say which project an ask will land in BEFORE it is sent,
// split a numbered multi-ask into separate chats, and start a chat without a panel open first.
// No model call anywhere here — a project name in the text and a numbered list are both literal, and
// a guess that shows itself before sending can be corrected with one tap.
import type { ProjectRef } from "@/lib/use-threads";

const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ");

/** The project the text names, longest name first ("ecvisionContent" beats "ecvision"). */
export function guessProject(text: string, projects: ProjectRef[]): ProjectRef | null {
  const t = " " + norm(text).replace(/[^a-z0-9 ]+/g, " ") + " ";
  const names = projects.flatMap((p) => {
    const n = norm(p.project);
    const spaced = norm(p.project.replace(/([a-z])([A-Z])/g, "$1 $2"));
    const joined = n.replace(/ /g, "");
    return [...new Set([n, spaced, joined])].map((k) => ({ k, p }));
  }).sort((a, b) => b.k.length - a.k.length);
  for (const { k, p } of names) if (k.length >= 4 && t.includes(" " + k + " ")) return p;
  return null;
}

/** A numbered list of 2+ asks → one string per ask, each carrying any lead-in line as context. */
export function splitAsks(text: string): string[] {
  const lines = text.split("\n");
  const items: string[] = [];
  const lead: string[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*\d+[.)]\s+(.*\S)/);
    if (m) items.push(m[1]);
    else if (items.length && l.trim()) items[items.length - 1] += "\n" + l.trim();
    else if (!items.length && l.trim()) lead.push(l.trim());
  }
  if (items.length < 2 || items.some((x) => x.length < 6)) return [];
  const ctx = lead.join(" ");
  return items.map((x) => (ctx ? `${ctx}\n\n${x}` : x));
}

/** Start a chat in a project and open it as a bento tab. Its own worktree when the folder is a repo,
 *  like a Today hand-off — a fresh ask beside other running chats would otherwise share their tree. */
/** `task: false` for a chat that isn't a new task: the board's ▶ Start joins its To-do card instead. */
export async function startAsk(p: ProjectRef, text: string, opts: { mode?: string; model?: string | null; open?: boolean | "quiet"; onStep?: (step: "sent") => void; task?: boolean } = {}): Promise<{ key: string; sid: string | null }> {
  let cwd = p.cwd;
  try {
    const w = await (await fetch("/api/worktree", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "isolate", cwd: p.cwd, label: "chat" }) })).json();
    if (w?.isolated?.dir) cwd = w.isolated.dir;
  } catch { /* the shared folder still works */ }
  const key = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const r = await fetch("/api/agent/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, cwd, message: text, mode: opts.mode, model: opts.model ?? undefined, task: opts.task !== false }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `send ${r.status}`);
  opts.onStep?.("sent");
  if (opts.open === false) return { key, sid: null };
  // Open it by session id, the way a notification link does (`minami:open-chat` waits for the list to
  // have it). The id arrives with the SDK's init a second or two after the send.
  let sid: string | null = (await r.json().catch(() => ({})))?.sessionId ?? null;
  for (let i = 0; !sid && i < 30; i++) {
    await new Promise((res) => setTimeout(res, 700));
    sid = (await (await fetch(`/api/threads?key=${encodeURIComponent(key)}`)).json().catch(() => ({})))?.sessionId ?? null;
  }
  if (sid && opts.open !== "quiet") window.dispatchEvent(new CustomEvent("minami:open-chat", { detail: sid }));
  return { key, sid };
}

// Starting a task in the background (§37). The New task sheets used to await startAsk with the sheet
// and its backdrop still up — worktree creation, the send, then up to ~20s polling for the session id —
// so the whole board was frozen behind a "Starting…" button. Now the sheet closes on click and the start
// runs here, outside any component, so it survives the tile collapsing or a client-side page change.
// The shell's <Starting> chip shows progress and offers Open once the session id arrives; it does not
// open the chat by itself, because by then Thomas may be somewhere else and a pane jumping open under
// him is the same interruption the freeze was.
//
// The same entry drives the dashed placeholder card in the topic tile and the board (StartingCard,
// Thomas's pick from pitch `task-lands`, 2026-10-29): it holds the first slot from the click until the
// real task card exists. So dismissing the chip only HIDES the entry — the card still needs it until
// the thread shows up (the first reply can land well after the chip's 15s) — and entries are dropped
// for good after KEEP_MS, by which point the real card has long replaced the placeholder.
export type Starting = {
  id: string; project: string; title: string; at: number;
  state: "starting" | "ready" | "failed";
  /** How far it got: the worktree is being made, or the message is sent and the session id awaited. */
  step: "worktree" | "sent";
  sid?: string | null; error?: string;
  /** The chip was dismissed or timed out; the placeholder card may still be showing. */
  hidden?: boolean;
};
const KEEP_MS = 5 * 60_000;
let starting: Starting[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const patch = (id: string, v: Partial<Starting>) => { starting = starting.map((s) => (s.id === id ? { ...s, ...v } : s)); emit(); };

export function subscribeStarting(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
export const getStarting = () => starting;
export function dismissStarting(id: string) { patch(id, { hidden: true }); }

/** Fire-and-forget start. `onFail` runs if it never got going — the sheets use it to put the draft back. */
export function startInBackground(p: ProjectRef, text: string, opts: { mode?: string; model?: string | null }, onFail?: () => void): void {
  const id = Math.random().toString(36).slice(2, 9);
  const title = text.split("\n").find((l) => l.trim())?.trim() ?? text;
  starting = [...starting, { id, project: p.project, title, at: Date.now(), state: "starting", step: "worktree" }];
  emit();
  setTimeout(() => { starting = starting.filter((s) => s.id !== id); emit(); }, KEEP_MS);
  startAsk(p, text, { ...opts, open: "quiet", onStep: () => patch(id, { step: "sent" }) }).then(
    ({ sid }) => patch(id, { state: "ready", sid }),
    (e) => { onFail?.(); patch(id, { state: "failed", error: String((e as Error)?.message || e) }); },
  );
}
