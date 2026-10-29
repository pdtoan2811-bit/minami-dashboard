"use client";
// Threads, client side (§37): one /api/threads poll per tab, shared by the home sections, the tiles'
// Resume, and every open chat's "Name this thread?" / wrong-project hints.
import { useSyncExternalStore } from "react";
import type { ProjectRef, ThreadView } from "@/lib/threads";
import { onPageVisible, pageHidden } from "@/lib/page-visible";

/** `busy`: task ids Minami is writing or checking a done-list for right now. */
export type ThreadsData = { threads: ThreadView[]; done: ThreadView[]; projects: ProjectRef[]; dismissed: string[]; busy: string[] };
export type { ProjectRef, ThreadView };

let data: ThreadsData | null = null;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let offVisible: (() => void) | null = null;
let inflight: Promise<void> | null = null;

export function refreshThreads(): Promise<void> {
  inflight ??= fetch("/api/threads", { cache: "no-store" }).then((r) => r.json()).then((j) => {
    if (j && Array.isArray(j.threads)) { data = j as ThreadsData; subs.forEach((f) => f()); }
  }).catch(() => {}).finally(() => { inflight = null; });
  return inflight;
}

function subscribe(f: () => void) {
  subs.add(f);
  if (!timer) {
    void refreshThreads();
    timer = setInterval(() => { if (!pageHidden()) void refreshThreads(); }, 8000);
    offVisible = onPageVisible(() => void refreshThreads());
  }
  return () => {
    subs.delete(f);
    if (!subs.size && timer) { clearInterval(timer); timer = null; offVisible?.(); offVisible = null; }
  };
}

export function useThreads(): ThreadsData | null {
  return useSyncExternalStore(subscribe, () => data, () => null);
}

export async function threadPost(body: Record<string, unknown>): Promise<{ ok?: boolean; id?: string; error?: string }> {
  const r = await fetch("/api/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  await refreshThreads();
  return j;
}

/** Open a thread as the bento panel: its sessions become the tabs (newest four). */
export function openThread(t: ThreadView) {
  window.dispatchEvent(new CustomEvent("minami:open-thread", { detail: { project: t.project, cwd: t.cwd, sessions: t.sessions } }));
}

/** Ask Minami to give these tasks a done-list and tick what their chats show is met. Called by whatever
 *  is on screen (the expanded tile, the board); throttled per task so a re-render or the 8s poll doesn't
 *  re-send it. The server decides whether there is anything to do (no list yet, or newer activity). */
const ensured = new Map<string, number>();
export function ensureDod(ts: ThreadView[]) {
  const now = Date.now();
  // The state is in the key: a turn ends (working → waiting/idle) with the same `at` as its last write,
  // and that's exactly when the full re-read is due. Keyed on `at` alone it waited out the 60s throttle,
  // the ✓ came a minute late, and he pressed ▶ Do it again on an item that was already done (2026-10-28).
  const k = (t: ThreadView) => `${t.id}:${t.at}:${t.state}`;
  const ids = ts.filter((t) => !t.archived && (ensured.get(k(t)) ?? 0) < now - 60_000).map((t) => t.id);
  if (!ids.length) return;
  for (const t of ts) ensured.set(k(t), now);
  void fetch("/api/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ensure", ids }) });
}

/** "Minami, do it" on one done-item (or the whole run): send it to the task's chat and open that chat. */
/** `dodId` null = ▶ Run: every open item up to the first gate, in one message (lib/task-pace.ts). */
export async function doDodItem(t: ThreadView, dodId: string | null, opts: { mode?: string; model?: string | null } = {}): Promise<string | null> {
  return sendVia(t, dodId ? { action: "do", id: t.id, dodId } : { action: "run", id: t.id }, opts);
}

/** His one tap on what the task waits on him for (`t.step`): the step's reply goes to the task's chat. */
export function answerStep(t: ThreadView, opts: { mode?: string; model?: string | null } = {}): Promise<string | null> {
  return sendVia(t, { action: "answer", id: t.id }, opts);
}

async function sendVia(t: ThreadView, body: object, opts: { mode?: string; model?: string | null }): Promise<string | null> {
  const r = await fetch("/api/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => null);
  if (!r?.key) return r?.error ?? "couldn't reach the task's chat";
  const s = await fetch("/api/agent/send", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: r.key, cwd: r.cwd, message: r.message, resume: r.resume, mode: opts.mode, model: opts.model ?? undefined }) });
  if (!s.ok) return (await s.json().catch(() => ({})))?.error ?? `send ${s.status}`;
  openThread(t);
  return null;
}
