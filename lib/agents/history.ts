// What an agent has actually done — assembled from transcripts on disk, not from a log we keep.
//
// Two sources, and the difference between them is a claim about ownership:
//
//   HOME       every transcript in the agent's home folder is its own. Adopting ~/secondBrain hands
//              that agent months of real history on day one, which is the whole reason adoption is
//              offered — an agent with an empty past is a chat window with a name on it.
//
//   WORKSPACE  only the runs the agent actually performed. A shared repo like ~/minami-dashboard has
//              transcripts from every pane on the box; claiming all of them because one agent is
//              allowed to work there would be a fabrication, and a convincing one. The task record's
//              sessionId is the only honest link, so that's what's used.
import { listSessionsIn, type SessionMeta } from "../claude-sessions";
import { sessionOwners } from "./tasks";
import type { AgentDef, AgentTask } from "./types";

export type AgentSession = SessionMeta & {
  /** How this session is attributed — a run in the agent's own folder, or a task it was assigned. */
  via: "home" | "task";
  /**
   * The task that produced it, when `via` is "task". Named `run`, not `task`, because SessionMeta
   * already has a `task?: string` (the bento's Project > Goal > Task label) — intersecting the two
   * under one name collapses the field to `never` and every read of it silently stops type-checking.
   */
  run?: Pick<AgentTask, "id" | "title" | "status">;
};

export function agentHistory(a: AgentDef, limit = 200): AgentSession[] {
  const owners = sessionOwners(a.id);
  const out: AgentSession[] = [];
  const seen = new Set<string>();

  for (const s of listSessionsIn([a.home], limit)) {
    seen.add(s.id);
    const t = owners.get(s.id);
    // A task run inside the agent's own home is still a task run — label it as one so the history
    // reads as a timeline of work rather than an undifferentiated pile of chats.
    out.push(t ? { ...s, via: "task", run: { id: t.id, title: t.title, status: t.status } } : { ...s, via: "home" });
  }

  if (a.workspaces.length && owners.size) {
    for (const s of listSessionsIn(a.workspaces, limit)) {
      if (seen.has(s.id)) continue;
      const t = owners.get(s.id);
      if (!t) continue; // someone else's session in a folder this agent merely has access to
      out.push({ ...s, via: "task", run: { id: t.id, title: t.title, status: t.status } });
    }
  }

  return out.sort((x, y) => y.lastActivity - x.lastActivity).slice(0, limit);
}

/** Cheap roll-up for the roster tile — avoids shipping a whole history to paint one card. */
export function agentStats(a: AgentDef): { sessions: number; tokensIn: number; tokensOut: number; cost: number; lastActivity: number } {
  const h = agentHistory(a);
  return {
    sessions: h.length,
    tokensIn: h.reduce((n, s) => n + s.tokensIn, 0),
    tokensOut: h.reduce((n, s) => n + s.tokensOut, 0),
    cost: h.reduce((n, s) => n + s.cost, 0),
    lastActivity: h.length ? h[0].lastActivity : 0,
  };
}
