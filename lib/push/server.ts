// Web push, wired to the live sessions (§24). Started once per process from instrumentation.ts.
//
// The notifier (rules) is pure; this file supplies the real clock, the live feed, the session titles
// and the sender, and owns the one-per-process guard. The guard is on globalThis, not a module
// variable, because Next evaluates this module separately in the instrumentation bundle and in every
// route bundle that imports it — a module-level flag would subscribe to liveEvents twice and every
// need would buzz the phone twice.
import path from "node:path";
import { createNotifier, type Notifier, type PushPayload } from "./notifier";
import { devices, noteDelivery, removeDevice, vapidKeys } from "./store";
import { sendPush } from "./webpush";

const SUBJECT = process.env.MINAMI_PUSH_SUBJECT || "mailto:minami-bento@localhost.invalid";
const G = globalThis as unknown as { __minamiPush?: { n: Notifier; timer: NodeJS.Timeout | null } };

function deliver(device: { endpoint: string }, payload: PushPayload, opts: { urgency: "high" | "normal"; ttl: number; topic?: string }) {
  const sub = devices().find((x) => x.endpoint === device.endpoint);
  if (!sub) return;
  sendPush(sub, payload, vapidKeys(), { subject: SUBJECT, ...opts }).then((r) => {
    if (r.gone) { removeDevice(sub.endpoint); return; }
    noteDelivery(sub.endpoint, r.status);
    if (r.status < 200 || r.status >= 300) console.warn(`[push] ${new URL(sub.endpoint).host} → ${r.status} ${r.body || ""}`);
  }).catch((e) => console.warn("[push] send failed:", e));
}

/** The notifier, created on first use. Routes call this too (presence, act), so it must not depend on
 *  startPush() having run — but only startPush() subscribes it to events. */
export async function notifier(): Promise<Notifier> {
  if (G.__minamiPush) return G.__minamiPush.n;
  // Dynamic: the manager pulls in the Agent SDK, and instrumentation should not pay for that before
  // the server is listening — same reason lib/autopilot/runner.ts imports it lazily.
  const { liveActivity } = await import("@/lib/agent/manager");
  const { sessionTitle, topicOf } = await import("@/lib/claude-sessions");
  const raced = (globalThis as typeof G).__minamiPush; // re-read: TS narrowed G above, but awaits ran since
  if (raced) return raced.n; // lost the race to a concurrent first caller
  const n = createNotifier({
    now: Date.now,
    devices,
    send: deliver,
    needs: liveActivity,
    label: (sid, cwd) => {
      const t = sessionTitle(sid);
      const project = t?.project || topicOf(cwd).project || path.basename(cwd);
      const title = (t?.title || "").replace(/\s+/g, " ").trim();
      return title ? `${project} · ${title.length > 60 ? title.slice(0, 59) + "…" : title}` : project;
    },
  });
  G.__minamiPush = { n, timer: null };
  return n;
}

export async function startPush() {
  const g = globalThis as unknown as { __minamiPushStarted?: boolean };
  if (g.__minamiPushStarted) return;
  g.__minamiPushStarted = true;
  const n = await notifier();
  const { liveEvents } = await import("@/lib/agent/manager");
  // Listener errors are caught here: an EventEmitter listener that throws throws INTO the manager's
  // emit() call, i.e. into canUseTool or the result handler of somebody's live turn.
  const safe = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => { try { f(...a); } catch (e) { console.warn("[push]", e); } };
  liveEvents.on("need", safe((e: any) => { n.onNeed(e.sessionId, e.cwd, e.need); ensureTicking(); }));
  liveEvents.on("ended", safe((e: any) => n.onEnded(e.sessionId, e.cwd, e.ended)));
}

/** The reconcile loop only runs while something is on a phone's screen (or deferred) — an idle box
 *  should not be walking every session every 3s for nothing. */
function ensureTicking() {
  const p = G.__minamiPush;
  if (!p || p.timer) return;
  p.timer = setInterval(() => {
    try { p.n.tick(); } catch (e) { console.warn("[push] tick:", e); }
    if (!p.n.busy()) { clearInterval(p.timer!); p.timer = null; }
  }, 3000);
  p.timer.unref?.();
}

/** /api/push/act — spend a nonce, then settle the prompt through the same manager functions the
 *  pane's own buttons call (pendingFor() hands back the key they take). The binding is re-checked
 *  against the LIVE prompt: a nonce minted for a question can only answer a question, and only with
 *  a label that prompt offered. */
export async function act(nonce: string, endpoint: string): Promise<{ ok: boolean; reason?: string; sessionId?: string }> {
  const n = await notifier();
  const b = n.consume(nonce, endpoint);
  if (!b) return { ok: false, reason: "invalid or used" };
  const { pendingFor, answer, decide } = await import("@/lib/agent/manager");
  const p = pendingFor(b.sessionId, b.needId);
  if (!p) return { ok: false, reason: "already settled", sessionId: b.sessionId };
  let ok = false;
  if (b.act.type === "answer") {
    if (p.toolName !== "AskUserQuestion" || p.questions.length !== 1) return { ok: false, reason: "not a single question", sessionId: b.sessionId };
    ok = answer(p.key, b.needId, { [p.questions[0]]: b.act.label });
  } else {
    if (p.toolName === "AskUserQuestion") return { ok: false, reason: "not a tool step", sessionId: b.sessionId };
    ok = decide(p.key, b.needId, "deny", "Denied from a phone notification — ask before retrying this step.");
  }
  ensureTicking(); // the tick is what sends the close for the notification this just settled
  return { ok, sessionId: b.sessionId };
}

export async function markPresence(sessionId: string, gone?: boolean) {
  const n = await notifier();
  n.markPresence(sessionId, gone);
  if (gone) ensureTicking(); // a deferred need for this chat is owed now
}
