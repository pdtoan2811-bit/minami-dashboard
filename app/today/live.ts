"use client";

// What each Today hand-off's chat is doing right now (§26). A hand-off used to be fire-and-forget:
// the button turned into "Open Minami's chat" and the page knew nothing more, so when one of nine
// asked a question Thomas had to find it on the board, among six chats that shared one name.
//
// Reads the same /api/agent/live the board and the cover screen read — server state, REPLACE
// semantics, no derivation of our own that could disagree with the pane.

import { useEffect, useState } from "react";

export type LiveNeed = {
  id: string; kind: "question" | "plan" | "held" | "permission"; tool: string; summary: string;
  options?: string[]; since?: number;
  qs?: { q: string; header?: string; multi?: boolean; options: string[] }[];
};
export type LiveTile = {
  phase: string; label: string; busy: boolean; cwd: string;
  need?: LiveNeed; ended?: { at: number; ok: boolean; text?: string; error?: string };
};

/** running · needs you · failed · finished (turn over, chat still open) · gone (no live session —
 *  closed or the server restarted; the transcript is still on disk behind "Open chat"). */
export type HandoffState = "needs" | "running" | "failed" | "finished" | "gone";

export function stateOf(t: LiveTile | undefined): HandoffState {
  if (!t) return "gone";
  if (t.need) return "needs";
  if (t.busy) return "running";
  if (t.ended && !t.ended.ok) return "failed";
  return "finished";
}

/** A single, single-select question with options is the one shape answerable in place. Everything
 *  else (several questions, multi-select, a plan to approve, a held tool call) opens the chat: the
 *  pane is where approvals happen, the same rule the cover screen keeps (§23). */
export function quickAnswerable(n: LiveNeed | undefined): n is LiveNeed & { options: string[] } {
  return !!n && n.kind === "question" && !!n.options?.length && (n.qs?.length ?? 1) === 1 && !n.qs?.[0]?.multi;
}

/** Polls only while there is something to watch and the tab is visible: a background /today tab must
 *  not hold one of Chrome's six connections per host (chrome-six-connections). */
export function useHandoffLive(ids: string[], everyMs = 3000): Record<string, LiveTile> {
  const [tiles, setTiles] = useState<Record<string, LiveTile>>({});
  const key = ids.slice().sort().join(",");
  useEffect(() => {
    if (!key) { setTiles({}); return; }
    let gone = false;
    const want = new Set(key.split(","));
    const run = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/agent/live", { cache: "no-store" });
        const j = (await r.json()) as { activity?: Record<string, LiveTile> };
        if (gone) return;
        const next: Record<string, LiveTile> = {};
        for (const [sid, t] of Object.entries(j.activity ?? {})) if (want.has(sid)) next[sid] = t;
        setTiles(next);
      } catch { /* keep the last answer; the next poll heals it */ }
    };
    void run();
    const t = setInterval(run, everyMs);
    const vis = () => { if (!document.hidden) void run(); };
    document.addEventListener("visibilitychange", vis);
    return () => { gone = true; clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [key, everyMs]);
  return tiles;
}

export async function answerInPlace(sessionId: string, needId: string, answer: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await fetch("/api/glance/answer", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, needId, answer }),
  });
  if (r.ok) return { ok: true };
  const j = (await r.json().catch(() => ({}))) as { reason?: string; error?: string };
  return { ok: false, reason: j.reason || j.error || `HTTP ${r.status}` };
}
