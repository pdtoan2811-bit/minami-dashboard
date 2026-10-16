import os from "node:os";
import path from "node:path";
import { liveActivity } from "@/lib/agent/manager";
import { listSessions } from "@/lib/claude-sessions";
import { listGoals } from "@/lib/goals";
import { list as listAutomations } from "@/lib/automations";
import { readDay, localDate } from "@/lib/today";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → everything the app shell (§30) shows on every page, in one poll:
//   needs    — the bell's one count: chats asking something, goal-runner asks, failing automations
//   day      — the Bento Day strip: the next open to-do and how many are left, each goal's pulse
//   projects — the project filter's list, most-worked-on first
//
// One route, not five: the shell is mounted on every tab and every phone, and Chrome gives a host six
// HTTP/1.1 connections that the chat panes' streams already compete for (§3, "The stream budget").
// Each extra poll per tab is a slot taken from a pane.
//
// Chats are read live every call (liveActivity is an in-memory walk). Goals and automations shell out
// to launchctl — once per job for automations — so they are shared for SLOW_MS: a failing job is
// news on a minutes scale, and polling launchctl from every open tab every few seconds is not free.
const SLOW_MS = 60_000;
let slow: { at: number; goals: ReturnType<typeof listGoals>; autos: ReturnType<typeof listAutomations> } | null = null;
function slowNow() {
  if (slow && Date.now() - slow.at < SLOW_MS) return slow;
  let goals: ReturnType<typeof listGoals> = [], autos: ReturnType<typeof listAutomations> = [];
  try { goals = listGoals(); } catch { /* no goals dir on this box */ }
  try { autos = listAutomations(); } catch { /* not macOS, or launchctl refused */ }
  slow = { at: Date.now(), goals, autos };
  return slow;
}

const PROJECT_DAYS = 14;

export type ShellNeed =
  | { kind: "chat"; sid: string; title: string; project: string; summary: string; ask: string; since?: number }
  | { kind: "goal"; id: string; title: string; project: string; summary: string }
  | { kind: "automation"; id: string; title: string; project: string; summary: string };

export type ShellData = {
  needs: ShellNeed[];
  day: { next: { id: string; text: string } | null; left: number; done: number;
    goals: { id: string; goal: string; note: string; onTrack: boolean | null; daysLeft: number }[] };
  projects: string[];
};

// POST { op: "goal", text } → { sessionId } — the capture button's "Goal". A goal is a JSON block in a
// vault project note with targets, levers and rules (lib/goals.ts), not a line of text, so a captured
// goal can't be written straight to disk: it opens a chat in the vault that drafts the block and asks
// before writing. Ideas and to-dos need no such step and go to their own routes from the client.
export async function POST(req: Request) {
  try {
    const { op, text } = await req.json();
    if (op !== "goal" || typeof text !== "string" || !text.trim()) return Response.json({ error: "op: goal and text are required" }, { status: 400 });
    const { sendMessage, liveStats } = await import("@/lib/agent/manager");
    const vault = process.env.SECOND_BRAIN_DIR || path.join(os.homedir(), "secondBrain");
    const key = `capture:goal:${Date.now()}`;
    const message = `Goal · ${text.trim().split("\n")[0].slice(0, 60)}\n\nI want this as an autonomous goal: ${text.trim()}\n\n` +
      "Find the project note in 10-19 Projects/ it belongs to, read how the existing ```json goal blocks are written there (lib/goals.ts in ~/minami-dashboard has the GoalSpec type), and draft one for this: goal, done_when, deadline, target, levers, never, escalate. Ask me anything you can't infer. Show me the block and wait for my yes before writing it.";
    let { sessionId } = sendMessage({ key, cwd: vault, message });
    // Same wait as Today's hand-off: the session id exists only once the CLI has started.
    for (let i = 0; !sessionId && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
    }
    if (!sessionId) return Response.json({ error: "the chat didn't start in time — look for it on the board" }, { status: 504 });
    return Response.json({ sessionId });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}

export async function GET() {
  try {
    const sessions = listSessions();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const needs: ShellNeed[] = [];

    for (const [sid, a] of Object.entries(liveActivity())) {
      if (!a.need) continue;
      const s = byId.get(sid);
      needs.push({ kind: "chat", sid, title: (s && (s.now || s.task || s.title)) || a.label || "A chat",
        project: s?.project || a.cwd.split("/").pop() || "", summary: a.need.summary, ask: a.need.kind,
        since: (a.need as { since?: number }).since });
    }
    needs.sort((x, y) => ((x as { since?: number }).since ?? 0) - ((y as { since?: number }).since ?? 0));

    const { goals, autos } = slowNow();
    const today = localDate();
    for (const g of goals) {
      // Only today's asks: yesterday's part is stale the moment the runner has run again.
      if (!g.today || g.today.date !== today) continue;
      const open = g.today.todos.filter((t) => !t.done).length, qs = g.today.questions.length;
      if (!open && !qs) continue;
      needs.push({ kind: "goal", id: g.spec.id, title: g.spec.goal, project: g.note,
        summary: [qs && `${qs} question${qs > 1 ? "s" : ""}`, open && `${open} to-do${open > 1 ? "s" : ""}`].filter(Boolean).join(" · ") });
    }
    for (const a of autos) {
      if (a.status !== "failing") continue;
      needs.push({ kind: "automation", id: a.id, title: a.name, project: a.project || "",
        summary: a.lastLine || `exited ${a.lastExit ?? "with an error"}` });
    }

    let next: ShellData["day"]["next"] = null, left = 0, done = 0;
    try {
      const d = readDay(today);
      const todos = d.todos || [];
      done = todos.filter((t) => t.done).length;
      const open = todos.filter((t) => !t.done);
      left = open.length;
      if (open[0]) next = { id: open[0].id, text: open[0].title || open[0].text };
    } catch { /* no plan yet today */ }

    const cutoff = Date.now() - PROJECT_DAYS * 86_400_000;
    const weight = new Map<string, number>();
    for (const s of sessions) if (s.lastActivity >= cutoff && s.project) weight.set(s.project, (weight.get(s.project) ?? 0) + s.messages);
    const projects = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p]) => p);

    const body: ShellData = {
      needs,
      day: { next, left, done, goals: goals.map((g) => ({ id: g.spec.id, goal: g.spec.goal, note: g.note,
        onTrack: g.log.length ? g.log[g.log.length - 1].decision.on_track : null, daysLeft: g.daysLeft })) },
      projects,
    };
    return Response.json(body);
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
