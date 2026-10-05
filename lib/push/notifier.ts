// The push rules (§24): which live events become a notification, which ones are heads-up, and when a
// notification is taken back. Pure — the clock, the sender, the live feed and the title lookup are all
// injected — so scripts/push-rules-test.mjs can drive it without a server, a phone or a push service.
// lib/push/server.ts wires it to the real ones.
import crypto from "node:crypto";
import type { Need } from "@/lib/agent/manager";

/** What the service worker receives (public/sw.js is the reader — keep the two in step). */
export type PushPayload =
  | { t: "show"; tag: string; title: string; body: string; silent: boolean; url: string; sessionId?: string;
      actions: { action: string; title: string }[]; nonces: Record<string, string>; ts: number }
  | { t: "close"; tag: string };

/** What a nonce lets its bearer do — never more than the two things that are safe from a lock screen:
 *  pick one of Claude's own offered answers, or deny. There is deliberately no "allow" variant, so no
 *  bug elsewhere in this file can mint an approve button. */
export type Binding = { sessionId: string; needId: string; endpoint: string; expiresAt: number; act: { type: "answer"; label: string } | { type: "deny" } };

export type DeviceRef = { endpoint: string; finished?: boolean };
export type Deps = {
  now: () => number;
  devices: () => DeviceRef[];
  send: (device: DeviceRef, payload: PushPayload, opts: { urgency: "high" | "normal"; ttl: number; topic?: string }) => void;
  /** Current need per session — liveActivity() in production. */
  needs: () => Record<string, { need?: Need; cwd: string } | undefined>;
  label: (sessionId: string, cwd: string) => string;
};

export const HEADS_UP_GAP_MS = 5 * 60_000; // ≤ 1 heads-up per chat per 5 min; later needs update silently
export const BURST_WINDOW_MS = 30_000;
export const BURST_MAX = 3;                // a 4th chat inside the window collapses into one summary
export const PRESENCE_MS = 45_000;         // client pings every 30s while visible; 15s of slack
export const FINISHED_MIN_MS = 60_000;     // a turn shorter than this was watched, or not worth a buzz
export const NONCE_MAX_MS = 15 * 60_000;
export const SUMMARY_TAG = "minami-summary";

export function createNotifier(d: Deps) {
  const headsUpAt = new Map<string, number>();
  const unblockedAt = new Map<string, number>(); // when a need we had notified was last settled
  const notified = new Map<string, { needId: string; cwd: string }>(); // tag (= sessionId) is on screen
  const deferred = new Map<string, { need: Need; cwd: string }>();     // skipped because it was being looked at
  const presence = new Map<string, number>();
  const nonces = new Map<string, Binding>();
  let burst: { sid: string; at: number }[] = [];
  let summary: Set<string> | null = null;

  const present = (sid: string) => d.now() - (presence.get(sid) ?? 0) < PRESENCE_MS;

  function dropNonces(sid: string, needId?: string) {
    for (const [k, b] of nonces) if (b.sessionId === sid && (!needId || b.needId === needId)) nonces.delete(k);
  }
  function mint(b: Binding): string {
    for (const [k, v] of nonces) if (v.expiresAt < d.now()) nonces.delete(k); // sweep on write, no timer
    const k = crypto.randomBytes(18).toString("base64url");
    nonces.set(k, b);
    return k;
  }

  function actionsFor(need: Need): { action: string; title: string; act?: Binding["act"] }[] {
    // Chrome on Android renders at most two actions, so "two of Claude's options" is the whole menu
    // and Open is the tap on the body. Only a single single-select question carries `options`
    // (needOf in manager.ts) — anything richer must be answered in the app.
    if (need.kind === "question" && need.options?.length) return need.options.slice(0, 2).map((o, i) => ({ action: `a${i}`, title: o.slice(0, 40), act: { type: "answer" as const, label: o } }));
    // No approve button for any tool, ever: a Bash/Edit/merge/deploy/plan is approved by reading it,
    // and a lock screen shows one truncated line. Deny is always safe — it only stops a step.
    if (need.kind === "held" || need.kind === "permission") return [{ action: "open", title: "Open" }, { action: "deny", title: "Deny", act: { type: "deny" } }];
    return [{ action: "open", title: "Open" }];
  }

  function showNeed(sid: string, cwd: string, need: Need, silent: boolean) {
    const expiresAt = Math.min(need.expiresAt ?? Infinity, d.now() + NONCE_MAX_MS);
    const ttl = Math.max(30, Math.round((expiresAt - d.now()) / 1000));
    dropNonces(sid); // a replaced notification's buttons die with it
    for (const dev of d.devices()) {
      const acts = actionsFor(need);
      const ns: Record<string, string> = {};
      for (const a of acts) if (a.act) ns[a.action] = mint({ sessionId: sid, needId: need.id, endpoint: dev.endpoint, expiresAt, act: a.act });
      d.send(dev, { t: "show", tag: sid, title: d.label(sid, cwd), body: need.summary, silent, url: `/?open=${encodeURIComponent(sid)}`, sessionId: sid,
        actions: acts.map(({ action, title }) => ({ action, title })), nonces: ns, ts: d.now() }, { urgency: silent ? "normal" : "high", ttl, topic: sid });
    }
    notified.set(sid, { needId: need.id, cwd });
  }

  function close(tag: string) {
    for (const dev of d.devices()) d.send(dev, { t: "close", tag }, { urgency: "high", ttl: 900, topic: tag });
  }

  function onNeed(sid: string, cwd: string, need: Need) {
    if (!d.devices().length) return;
    if (present(sid)) { deferred.set(sid, { need, cwd }); return; }
    deferred.delete(sid);
    const now = d.now();
    burst = burst.filter((b) => now - b.at < BURST_WINDOW_MS && b.sid !== sid);
    burst.push({ sid, at: now });
    if (burst.length > BURST_MAX || (summary && burst.length > 1)) {
      // A burst is one interruption, not four: the summary is heads-up once, then updates silently.
      // Its members are the chats it stands for, so it is closed only once all of them are settled.
      const first = !summary;
      summary ??= new Set();
      for (const b of burst) summary.add(b.sid);
      const n = Object.entries(d.needs()).filter(([k, v]) => v?.need && !present(k)).length || summary.size;
      for (const dev of d.devices()) d.send(dev, { t: "show", tag: SUMMARY_TAG, title: "Minami", body: `${n} chats need you`, silent: !first, url: "/",
        actions: [], nonces: {}, ts: now }, { urgency: first ? "high" : "normal", ttl: 900, topic: SUMMARY_TAG });
      return;
    }
    const loud = now - (headsUpAt.get(sid) ?? -Infinity) >= HEADS_UP_GAP_MS;
    if (loud) headsUpAt.set(sid, now);
    showNeed(sid, cwd, need, !loud);
  }

  function onEnded(sid: string, cwd: string, ended: { ok: boolean; text?: string; error?: string; turnMs?: number }) {
    if ((ended.turnMs ?? 0) <= FINISHED_MIN_MS || present(sid)) return;
    // turnMs includes the time the turn sat blocked on the user. A two-minute turn that was 110s of
    // waiting for "Tea or coffee?" ran for ten seconds after the answer — and the person who answered
    // is still holding the phone. Seen in the end-to-end run: answering a question earned a second,
    // "finished", notification seconds later.
    if (d.now() - (unblockedAt.get(sid) ?? -Infinity) <= FINISHED_MIN_MS) return;
    if (d.needs()[sid]?.need) return; // still blocked on the user — the need notification is the truth
    const firstLine = (s?: string) => (s || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 140) || "";
    const body = ended.ok ? firstLine(ended.text) || "Finished" : `Failed: ${firstLine(ended.error) || "unknown error"}`;
    const devs = d.devices().filter((x) => x.finished !== false);
    for (const dev of devs) d.send(dev, { t: "show", tag: sid, title: d.label(sid, cwd), body, silent: true, url: `/?open=${encodeURIComponent(sid)}`, sessionId: sid,
      actions: [], nonces: {}, ts: d.now() }, { urgency: "normal", ttl: 1800, topic: sid });
    // The finished notice took the chat's tag, so a later "close" for the old need would delete it.
    // Only when it actually went to every device; otherwise the poller still owes the others a close.
    if (devs.length === d.devices().length) { notified.delete(sid); dropNonces(sid); }
  }

  /** Reconcile against the live feed. Polling rather than a "resolved" event from the manager because
   *  a pending prompt is settled in six places there (pane answer, pane decision, hold timeout, Stop,
   *  session end, close), and missing one would strand a notification with live-looking buttons. */
  function tick() {
    const live = d.needs();
    for (const [sid, n] of notified) {
      const cur = live[sid]?.need;
      if (!cur) { notified.delete(sid); dropNonces(sid); unblockedAt.set(sid, d.now()); close(sid); }
      else if (cur.id !== n.needId) showNeed(sid, n.cwd, cur, true); // the one on screen settled, another is queued behind it
    }
    for (const [sid, x] of deferred) {
      if (present(sid)) continue;
      deferred.delete(sid);
      // Looked at, then left still blocked (phone locked mid-question): that is exactly when it's owed.
      const cur = live[sid]?.need;
      if (cur && cur.id === x.need.id) onNeed(sid, x.cwd, cur);
    }
    if (summary) {
      for (const sid of summary) if (!live[sid]?.need) summary.delete(sid);
      if (!summary.size) { summary = null; close(SUMMARY_TAG); }
    }
  }

  return {
    onNeed, onEnded, tick,
    busy: () => notified.size > 0 || deferred.size > 0 || !!summary,
    markPresence(sid: string, gone?: boolean) {
      if (gone) presence.delete(sid); else presence.set(sid, d.now());
    },
    /** One-time: a nonce is spent whether or not the action then succeeds, and spending it spends its
     *  siblings (the other button on the same notification). */
    consume(nonce: string, endpoint: string): Binding | null {
      const b = nonces.get(nonce);
      if (!b || b.endpoint !== endpoint || b.expiresAt < d.now()) return null;
      dropNonces(b.sessionId, b.needId);
      unblockedAt.set(b.sessionId, d.now());
      return b;
    },
    // test seams
    _state: () => ({ notified, deferred, nonces, summary, burst }),
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
