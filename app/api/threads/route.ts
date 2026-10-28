// Threads (§37). GET: open threads (tasks), the Done column, and the project list the Ask line routes to.
// POST: the edits a task can take — name it, keep/tick/add to its Definition of Done, queue a To-do,
// start one, archive (Done) and reopen — plus `ensure`, which asks Minami to write a done-list for a
// task that has none and to tick the items its chats show are met.
import { sessionIdentity } from "@/lib/agent/manager";
import { runHaiku } from "@/lib/bento-enrich";
import { fid, mutateFlow, readFlow, type FlowDod, type FlowThread } from "@/lib/flow-store";
import { listSessions, topicOf } from "@/lib/claude-sessions";
import { baseCwd, recentText, threads, type ThreadView } from "@/lib/threads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  // `?key=` → the session id a just-started chat got (the Ask line waits on this before opening it: a
  // pane attaches by session id, and a key-only pane would sit on an empty "new chat").
  const key = new URL(req.url).searchParams.get("key");
  if (key) return Response.json({ sessionId: sessionIdentity(key)?.sessionId ?? null });
  const t = threads();
  return Response.json({ threads: t.threads, done: t.done, projects: t.projects, dismissed: t.dismissed, busy: [...inflight] });
}

type Body =
  | { action: "name"; sessionId: string; title: string }
  | { action: "dismiss"; sessionId: string }
  | { action: "dod.accept"; id: string }
  | { action: "dod.toggle"; id: string; dodId: string }
  | { action: "dod.add"; id: string; t: string }
  | { action: "archive"; id: string }
  | { action: "unarchive"; id: string }
  | { action: "drop"; id: string }
  | { action: "queue"; project: string; cwd: string; title: string }
  | { action: "start"; id: string; sessionId: string }
  | { action: "ensure"; ids: string[] }
  | { action: "do"; id: string; dodId: string }
  /** Close a task from inside its chat: by session id, or by the chat's own MINAMI_SESSION_KEY. */
  | { action: "close"; sessionId?: string; key?: string };

// ── Minami's done-lists ──────────────────────────────────────────────────────────────────────────
// Both jobs are cheap Haiku side calls, never on the request path: `ensure` returns at once and the
// result lands on a later poll. Two at a time, one per task, so opening a board of twenty tasks queues
// twenty small calls rather than firing them together. `inflight` is per process; two servers may
// duplicate a call, which costs a cent and writes the same answer twice.
const inflight = new Set<string>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
function enqueue(id: string, job: () => Promise<void>) {
  if (inflight.has(id)) return;
  inflight.add(id);
  queue.push(async () => { try { await job(); } finally { inflight.delete(id); } });
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const j = queue.shift()!;
    running++;
    void j().finally(() => { running--; pump(); });
  }
}
const RETRY_EMPTY_MS = 6 * 3600e3;
const FOCUS_EVERY_MS = 2 * 60e3;

// Done closes itself (Thomas, 2026-10-28: "I don't want to check the subtask done manually"). Only on
// the TRANSITION to all-met, never on a list that was already all met: a task he reopened, or one that
// came back because he replied in it (lib/threads.ts `revived`), stays open with Close until he says.
const allDone = (dod?: FlowDod[]) => !!dod?.length && dod.every((d) => d.done);
function closeIfDone(t: FlowThread, wasDone: boolean) {
  if (wasDone || !allDone(t.dod)) return;
  t.archived = true; t.autoDone = true; t.doneAt = Date.now(); t.auto = false;
}

function haikuJSON(raw: string): unknown {
  try {
    const result = JSON.parse(raw)?.result ?? raw;
    return JSON.parse(String(result).match(/[[{][\s\S]*[\]}]/)?.[0] ?? "null");
  } catch { return null; }
}

function chatOf(v: ThreadView): string {
  return v.sessions.slice(-2).map((x) => recentText(x.id, x.cwd, 4000)).filter(Boolean).join("\n\n---\n\n").slice(-7000);
}

/** Write a proposed done-list for a task. A derived task is stored (`auto`) to hold it. */
async function suggest(v: ThreadView) {
  const firstAsks = v.sessions.length ? (listSessions().find((x) => x.id === v.sessions[0].id)?.asks ?? []).slice(0, 3) : [];
  const prompt = `A piece of work is called "${v.title}" (project ${v.project}).\n${firstAsks.length ? `It started with:\n${firstAsks.map((a) => "- " + a.slice(0, 300)).join("\n")}\n` : ""}${v.sessions.length ? `The end of its chat:\n${chatOf(v).slice(-3000)}\n` : ""}\nWrite its Definition of Done: 2 to 4 outcomes Thomas can check by looking (a page renders, a number is right, a file exists, it is merged). Each under 10 words, no verbs in the imperative. Reply with ONLY a JSON array of strings.`;
  const arr = haikuJSON(await runHaiku(prompt));
  const items = (Array.isArray(arr) ? arr : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  mutateFlow((s) => {
    let t = s.threads.find((x) => x.id === v.id);
    if (!t) {
      if (!items.length) return;
      t = { id: v.id.startsWith("s:") ? fid() : v.id, title: v.title, project: v.project, cwd: v.cwd, sessions: v.sessions.map((x) => x.id), auto: true, createdAt: Date.now(), updatedAt: Date.now() };
      s.threads.unshift(t);
    }
    if (t.dod?.length) return;
    if (!items.length) { t.dodTriedAt = Date.now(); return; }
    t.dod = items.map((x, i) => ({ id: t!.id + "-" + i, t: x, done: false }));
    t.dodPending = true;
    t.evalAt = 0; // tick right away against what the chat already says
  });
}

/** Tick the items the chat shows are met, and note which open item the chat is on now. Never unticks
 *  what Thomas ticked; unticks its own only when the chat says the thing broke. `focusOnly` (a chat mid-turn): only the "on now" part — a
 *  half-finished reply reads as "not yet", so ticks wait for the chat to go quiet. */
async function evaluate(v: ThreadView, focusOnly = false) {
  const dod = v.dod ?? [];
  const chat = chatOf(v);
  if (!dod.length || !chat) { mutateFlow((s) => { const t = s.threads.find((x) => x.id === v.id); if (t) { if (focusOnly) t.focusAt = Date.now(); else t.evalAt = v.at; } }); return; }
  const prompt = `Definition of Done for "${v.title}":\n${dod.map((d, i) => `${i + 1}. ${d.t}`).join("\n")}\n\nThe end of the work chat:\n${chat}\n\nWhich items does the chat show are actually met (done and confirmed, not planned or promised)? For each met item, copy the evidence word for word from the chat (one sentence, under 30 words, no paraphrase) and say who said it. Also: which NOT-met item is the end of the chat working on or asking about right now (0 if none, or if it's about something else)? And list any item the chat says was done but is now broken or reverted (usually none). Finally: did Thomas say the WHOLE task is done or to close it, or did the chat end by declaring the whole task finished with nothing left to do? Only the whole task counts, never one step; if yes, copy those words exactly. Reply with ONLY JSON: {"met":[{"n":<item number>,"why":"<under 12 words: what in the chat shows it>","quote":"<exact words from the chat>","by":"Thomas"|"Minami"}],"now":<item number or 0>,"undone":[<item numbers>],"finished":<"exact words" or null>}`;
  const j = haikuJSON(await runHaiku(prompt)) as { met?: { n?: number; why?: string }[]; now?: number } | null;
  const nowIdx = typeof j?.now === "number" && j.now > 0 ? j.now - 1 : -1;
  // "It's done" said in the chat closes the task even with items open (Thomas, 2026-10-28: "I told it is
  // done but it has no way to mark itself as done"). Same evidence rule as the ticks: the words must
  // really be in the chat, and a revived task doesn't re-close on the same old words.
  const fin = String((j as { finished?: unknown } | null)?.finished ?? "").trim().replace(/^["“]|["”]$/g, "").slice(0, 300);
  const undone = new Set(((j as { undone?: unknown } | null)?.undone instanceof Array ? (j as { undone: unknown[] }).undone : []).filter((n): n is number => typeof n === "number").map((n) => n - 1));
  const met = new Map<number, string>();
  // Evidence is only evidence if it is really there: a quote that isn't in the chat (whitespace and
  // quote marks aside) is dropped, and the tick keeps just its reason. A made-up quote under a tick
  // would be worse than none.
  const norm = (x: string) => x.toLowerCase().replace(/[“”"'‘’`*_]/g, "").replace(/\s+/g, " ").trim();
  const hay = norm(chat);
  const finished = fin.length >= 4 && fin !== "null" && hay.includes(norm(fin)) ? fin : null;
  const ev = new Map<number, { quote?: string; quoteBy?: "Thomas" | "Minami" }>();
  for (const x of (j as { met?: { n?: number; why?: string; quote?: string; by?: string }[] } | null)?.met ?? []) {
    if (typeof x?.n !== "number") continue;
    met.set(x.n - 1, String(x.why ?? "").slice(0, 120));
    const q = String(x.quote ?? "").trim().replace(/^["“]|["”]$/g, "").slice(0, 300);
    if (q.length >= 8 && hay.includes(norm(q))) ev.set(x.n - 1, { quote: q, quoteBy: x.by === "Thomas" ? "Thomas" : "Minami" });
  }
  mutateFlow((s) => {
    const t = s.threads.find((x) => x.id === v.id);
    if (!t?.dod) return;
    if (focusOnly) t.focusAt = Date.now(); else t.evalAt = v.at;
    if (!j) return; // a failed call says nothing about the items
    // Which item is on now. A ▶ Do it from the last 10 minutes outranks the reading: he said which one.
    const pinned = t.dod.some((d) => !d.done && d.doing && Date.now() - d.doing < 10 * 60e3);
    if (!pinned) t.dod = t.dod.map((d, i) => (i === nowIdx && !d.done ? { ...d, doing: d.doing ?? Date.now() } : d.doing ? (({ doing: _, ...r }) => r)(d) : d));
    if (focusOnly) return;
    const was = allDone(t.dod);
    t.dod = t.dod.map((d, i): FlowDod => {
      if (d.done && d.by !== "minami") return d; // his tick stands
      if (met.has(i)) return { id: d.id, t: d.t, done: true, by: "minami", why: met.get(i), quote: ev.get(i)?.quote, quoteBy: ev.get(i)?.quoteBy, at: d.done ? d.at : Date.now() };
      // Minami's own tick also stands unless the chat now says that thing is broken (`undone`). It used
      // to be unticked whenever the item wasn't in this reading — but Minami reads only the END of the
      // chat, so every tick fell off once the evidence scrolled out of the window (seen 2026-10-28: a
      // 3/4 task went to 0/4 an hour later with nothing undone).
      return d.by === "minami" && undone.has(i) ? { id: d.id, t: d.t, done: false } : d;
    });
    if (!t.archived) closeIfDone(t, was);
    if (!t.archived && finished && finished !== t.closedWhy) {
      t.archived = true; t.autoDone = true; t.doneAt = Date.now(); t.auto = false; t.closedWhy = finished;
    }
  });
}

function ensure(ids: string[]) {
  const store = readFlow();
  const all = threads(14);
  const byId = new Map([...all.threads, ...all.done].map((v) => [v.id, v]));
  for (const id of ids.slice(0, 40)) {
    const v = byId.get(id);
    if (!v || v.archived) continue;
    const st = store.threads.find((x) => x.id === v.id);
    if (!v.dod?.length) {
      if (st?.dodTriedAt && Date.now() - st.dodTriedAt < RETRY_EMPTY_MS) continue;
      enqueue(v.id, () => suggest(v));
    } else if (v.state !== "working" && v.sessions.length && (st?.evalAt ?? 0) < v.at) {
      // Checked when the chat goes quiet, not mid-turn: a half-finished reply reads as "not yet".
      enqueue(v.id, () => evaluate(v));
    } else if (v.state === "working" && v.sessions.length && Date.now() - (st?.focusAt ?? 0) > FOCUS_EVERY_MS) {
      // Mid-turn: only which item it's on, at most every two minutes per task.
      enqueue(v.id, () => evaluate(v, true));
    }
  }
}

/** "Minami, do it": where to send one done-item — the task's latest chat, under the key that already
 *  owns that conversation when one does (a pane, or a run started elsewhere). Resuming a live session
 *  under a second key is two processes writing one transcript (manager.sendMessage refuses it). With no
 *  owner, a fresh key resumes it from disk and the panel attaches by session id. The browser does the
 *  send through /api/agent/send, so a chat whose worktree is gone is re-homed there as usual. */
function doItem(b: { id: string; dodId: string }): { key?: string; cwd?: string; resume?: string; message?: string; error?: string } {
  const v = threads(14).threads.find((t) => t.id === b.id);
  const item = v?.dod?.find((d) => d.id === b.dodId);
  if (!v || !item) return { error: "no such task or item" };
  const last = v.sessions[v.sessions.length - 1];
  if (!last) return { error: "the task has no chat yet — start it first" };
  const owner = sessionIdentity("live:" + last.id);
  const key = owner?.key ?? "live:" + last.id; // the alias a panel attaches through (Home's Go uses it too)
  const message = `Next on the done-list for "${v.title}": ${item.t}\n\nDo this now. When it's done and checked, say so plainly.`;
  // This item is the one on now: he just handed it over.
  mutateFlow((s) => { const t = s.threads.find((x) => x.id === v.id); if (t?.dod) t.dod = t.dod.map((d) => (d.id === item.id ? { ...d, doing: Date.now() } : d.doing ? (({ doing: _, ...r }) => r)(d) : d)); });
  return { key, cwd: owner?.cwd ?? last.cwd, resume: last.id, message };
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as Body | null;
  if (!b || typeof b !== "object" || !("action" in b)) return Response.json({ error: "bad body" }, { status: 400 });
  try {
    if (b.action === "do") return Response.json(doItem(b));
    if (b.action === "close") {
      const sid = b.sessionId || (b.key ? sessionIdentity(b.key)?.sessionId : null);
      const v = sid ? threads(14).threads.find((t) => t.sessions.some((x) => x.id === sid)) : undefined;
      if (!v) throw new Error("no open task holds that chat");
      let id = v.id;
      mutateFlow((s) => {
        let t = s.threads.find((x) => x.id === v.id);
        if (!t) { id = fid(); t = { id, title: v.title, project: v.project, cwd: v.cwd, sessions: v.sessions.map((x) => x.id), createdAt: Date.now(), updatedAt: Date.now() }; s.threads.unshift(t); }
        t.archived = true; t.autoDone = true; t.doneAt = Date.now(); t.auto = false; t.closedWhy = "closed from the chat"; t.updatedAt = Date.now();
      });
      return Response.json({ ok: true, id, title: v.title });
    }
    if (b.action === "ensure") { ensure(Array.isArray(b.ids) ? b.ids.map(String) : []); return Response.json({ ok: true }); }
    if (b.action === "name") {
      const m = listSessions().find((x) => x.id === b.sessionId);
      if (!m) throw new Error("no such session");
      // Naming the thread a session is in: the whole derived thread (it and its continuations) is
      // stored under the name, so a continuation found later still joins it.
      const view = threads(30).threads.find((t) => t.sessions.some((x) => x.id === b.sessionId));
      const ids = view?.sessions.map((x) => x.id) ?? [b.sessionId];
      const title = String(b.title || "").trim().slice(0, 90) || m.task || m.title;
      let id = "";
      mutateFlow((s) => {
        const existing = view?.stored ? s.threads.find((t) => t.id === view.id) : undefined;
        if (existing) { existing.title = title; existing.auto = false; existing.updatedAt = Date.now(); id = existing.id; return; }
        id = fid();
        s.threads.unshift({ id, title, project: topicOf(baseCwd(m.cwd)).project || m.project, cwd: baseCwd(m.cwd), sessions: ids, createdAt: Date.now(), updatedAt: Date.now() });
      });
      const v = threads(30).threads.find((t) => t.id === id);
      if (v && !v.dod?.length) enqueue(id, () => suggest(v));
      return Response.json({ ok: true, id });
    }
    if (b.action === "queue") {
      const title = String(b.title || "").trim().slice(0, 140);
      if (!title || !b.project || !b.cwd) throw new Error("title, project and cwd");
      const id = fid();
      mutateFlow((s) => { s.threads.unshift({ id, title, project: b.project, cwd: baseCwd(b.cwd), sessions: [], queued: true, createdAt: Date.now(), updatedAt: Date.now() }); });
      const v = threads().threads.find((t) => t.id === id);
      if (v) enqueue(id, () => suggest(v));
      return Response.json({ ok: true, id });
    }
    // A derived task (id "s:…") has nothing stored yet; the edits below that need a record make one.
    if ("id" in b && b.id.startsWith("s:") && (b.action === "archive" || b.action === "dod.add" || b.action === "drop")) {
      const v = threads(14).threads.find((t) => t.id === b.id);
      if (!v) throw new Error("no such task");
      const id = fid();
      mutateFlow((s) => { s.threads.unshift({ id, title: v.title, project: v.project, cwd: v.cwd, sessions: v.sessions.map((x) => x.id), auto: true, createdAt: Date.now(), updatedAt: Date.now() }); });
      b.id = id;
    }
    mutateFlow((s) => {
      const t = "id" in b ? s.threads.find((x) => x.id === b.id) : undefined;
      switch (b.action) {
        case "dismiss": if (!s.dismissed.includes(b.sessionId)) s.dismissed = [...s.dismissed, b.sessionId].slice(-500); break;
        case "dod.accept": if (t) t.dodPending = false; break;
        // His tap is his: it clears Minami's mark either way, so Minami won't untick it later.
        case "dod.toggle": if (t?.dod) { const was = allDone(t.dod); t.dod = t.dod.map((d) => (d.id === b.dodId ? { id: d.id, t: d.t, done: !d.done, at: Date.now() } : d)); t.dodPending = false; if (!t.archived) closeIfDone(t, was); } break;
        case "dod.add": if (t && b.t.trim()) { t.dod = [...(t.dod ?? []), { id: fid(), t: b.t.trim().slice(0, 140), done: false }]; t.dodPending = false; } break;
        case "archive": if (t) { t.archived = true; t.doneAt = Date.now(); t.auto = false; } break;
        // A To-do never started is just deleted; anything with chats is hidden, so they stay claimed.
        case "drop": if (t) { if (!t.sessions.length) s.threads = s.threads.filter((x) => x !== t); else t.hidden = true; } break;
        case "unarchive": if (t) { t.archived = false; t.autoDone = false; delete t.doneAt; } break;
        case "start": if (t) { t.queued = false; if (!t.sessions.includes(b.sessionId)) t.sessions.push(b.sessionId); } break;
      }
      if (t) t.updatedAt = Date.now();
    });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 400 });
  }
}
