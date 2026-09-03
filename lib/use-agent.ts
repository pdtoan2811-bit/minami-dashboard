"use client";
// Client hook that drives one live Claude Code session (Phase 2). It POSTs user messages, opens an
// SSE stream for the reply, accumulates streamed tokens into a transcript, surfaces tool-permission
// prompts, and — when a turn finishes — reconciles the transcript from the authoritative JSONL file
// (so Markdown/tools render exactly as elsewhere and any streaming gap is healed).
import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_ACTIVITY, type ActivityState, type ToolOutput } from "./agent/labels";

export type AgentTurn = { role: "user" | "assistant"; text: string; tools: AgentToolCall[]; streaming?: boolean; thinking?: string };
export type AgentToolCall = { name: string; input: unknown; id?: string; done?: boolean; ok?: boolean; ms?: number; output?: ToolOutput };
// `held` marks a prompt raised by the Flow view's brake rather than by the permission mode — the pane
// renders it as "paused for review" (with the countdown `expiresAt` drives) instead of "needs approval".
export type PermissionPrompt = { id: string; toolName: string; input: unknown; held?: boolean; expiresAt?: number } | null;
// `preview` is the AskUserQuestion schema's own field (SDK 0.3.220 / CLI 2.1.241): free-form content —
// a mockup, a code snippet, a plan — that the model attaches to an option so the two can be compared
// side by side. It rides through manager.ts untouched (the whole `questions` array is broadcast
// verbatim), so it was always ARRIVING here; it was only ever missing from this type and from AskCard.
export type AgentQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] };
export type AskPrompt = { id: string; questions: AgentQuestion[] } | null;
export type AgentMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
// `agent`/`status` only ride along on kind "task" — see manager.ts's AgentEvent for why.
export type Notice = { kind: string; text: string; at: number; agent?: string; status?: "completed" | "failed" | "stopped" };

export { activityLabel, toolCategory, escalationHint } from "./agent/labels";
export type { ActivityState, ActivityPhase, ToolCategory, ToolOutput, ToolOutputBlock, TodoItem, LiveTask } from "./agent/labels";

// How long "the server is blocked on you, and you have nothing to answer" must hold before the client
// treats it as a lost prompt rather than one still in flight. Generous on purpose: the two facts travel
// in the same broadcast burst, so any real gap is sub-second, and a resync costs a reconnect.
const AWAIT_HEAL_MS = 4000;

export function useAgent(paneKey: string) {
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [live, setLive] = useState(false); // has this pane started driving a session?
  const [busy, setBusy] = useState(false); // a turn is in flight
  // Follow-ups handed to the CLI mid-turn, waiting their own turn. Server-owned (REPLACE semantics) —
  // never derived locally, because only the CLI knows whether a queued message has started, and it says
  // so on the command_lifecycle channel the server mirrors.
  const [queued, setQueued] = useState<{ uuid: string; text: string }[]>([]);
  const [stopping, setStopping] = useState(false); // Stop was clicked; waiting for the turn to actually end
  const [pending, setPending] = useState<PermissionPrompt>(null);
  const [ask, setAsk] = useState<AskPrompt>(null); // Claude's AskUserQuestion prompt
  // The Flow view's brake. Server-owned (see setHold in lib/agent/manager.ts) and delivered with
  // REPLACE semantics like `activity`, so this never derives a supervision state the gate disagrees
  // with — the gate is what actually decides whether a tool runs.
  const [hold, setHoldState] = useState(false);
  // Read by send() so the brake rides in with the message. A ref, not a dep: listing `hold` on send()
  // would give it a new identity on every toggle, and every effect that depends on send() would tear
  // down and re-run — the same stale-closure/lost-state trap useSetting's setter comments describe.
  const holdRef = useRef(false);
  holdRef.current = hold;
  // What Claude is doing right now. Derived on the SERVER (see lib/agent/labels.ts) and delivered with
  // replace semantics, so a dropped event self-heals and a refresh mid-tool-call resumes correctly.
  const [activity, setActivity] = useState<ActivityState>(IDLE_ACTIVITY);
  const [notices, setNotices] = useState<Notice[]>([]); // retries, compactions, denials — non-fatal
  // Wall-clock start of the current phase, translated out of the server's elapsedMs so our own ticking
  // timer never depends on the two clocks agreeing.
  const [phaseStart, setPhaseStart] = useState<number>(() => Date.now());
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The model the live session reported at init — observed, never chosen. Null until a session exists,
  // which is why the picker falls back to the word "default" rather than naming a model it is guessing.
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  // Where the placement pass moved this conversation, if it did — the pane's cwd prop is stale the
  // moment this is set, and every later send must use this instead. Null until a relocation.
  const [relocatedTo, setRelocatedTo] = useState<string | null>(null);
  // Context-window fill in tokens, REPLACE semantics from the server. Null until a live turn reports.
  const [ctxUsed, setCtxUsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detached, setDetached] = useState(false); // an attach found no live server session
  const esRef = useRef<EventSource | null>(null);
  // Pass `resume` on send until we've confirmed the server actually has a live session backing this
  // pane. Sets true only once a `snapshot` is observed (proof a live session exists) and is re-armed to
  // false on `detached` (proof it doesn't) — NOT unconditionally in attach(), because attach() doesn't
  // yet know which of those is true. Getting this wrong is how a pane silently starts a brand-new,
  // context-less session after the server reaps an idle one (see scheduleIdle in lib/agent/manager.ts):
  // attach() used to mark this true optimistically, so the next send() after a detach omitted `resume`.
  const sentOnce = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const attachingRef = useRef(false); // this stream was opened by attach() (reconnect), not send()
  // Timestamp of the last "delta"/"thinking" event actually applied to `turns`. Used to tell a genuinely
  // live connection (still receiving fresh tokens) apart from one that's stale because the underlying
  // EventSource silently dropped and reconnected — see the snapshot resync logic below.
  const lastDeltaAtRef = useRef(0);

  const closeStream = useCallback(() => { esRef.current?.close(); esRef.current = null; }, []);
  useEffect(() => closeStream, [closeStream]);

  // Adopt a server activity state. The phase clock only restarts when the phase/label actually
  // changes, so a burst of text deltas doesn't reset the visible "12s" counter.
  const applyActivity = useCallback((a: ActivityState) => {
    setActivity((prev) => {
      if (prev.phase !== a.phase || prev.label !== a.label) setPhaseStart(Date.now() - (a.elapsedMs || 0));
      return a;
    });
  }, []);

  // One shared 1s tick drives the elapsed counter. It runs only while a phase is actually active, so
  // an idle pane does no work — but while Claude is busy the UI is guaranteed to repaint every second
  // even during a long silent tool call, which is what makes the indicator feel alive.
  const [, forceTick] = useState(0);
  const ticking = activity.phase !== "idle";
  useEffect(() => {
    if (!ticking) return;
    const h = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [ticking]);

  // Bumped every time send() optimistically appends a new turn. reconcile() below captures this value
  // before its async fetch and checks it again after — if a NEW send() happened in the meantime (the
  // user fired off a follow-up message while the previous turn's disk-reconcile fetch was still in
  // flight), that fetch's result is almost certainly stale (the file write for the earlier turn may not
  // have landed yet either) and would wholesale-clobber the just-appended optimistic turns, making the
  // new message flicker/vanish from view even though it was actually delivered to the server.
  const turnsGenRef = useRef(0);

  // Reload the authoritative transcript from disk after a turn completes.
  const reconcile = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    const gen = turnsGenRef.current;
    try {
      const d = await fetch(`/api/bento/session/${id}`).then((r) => r.json());
      if (gen !== turnsGenRef.current) return; // superseded by a newer send() — let its own flow win
      if (Array.isArray(d?.turns)) {
        setTurns((prev) => {
          const fresh: AgentTurn[] = d.turns.map((t: AgentTurn) => ({ role: t.role, text: t.text, tools: t.tools || [] }));
          // The JSONL has no reasoning, so carry the streamed thinking onto the turns it belongs to
          // (aligned from the end) — otherwise it would vanish the moment a turn finished.
          for (let i = 1; i <= Math.min(fresh.length, prev.length); i++) {
            const f = fresh[fresh.length - i], p = prev[prev.length - i];
            if (f.role === "assistant" && p?.role === "assistant" && p.thinking) f.thinking = p.thinking;
          }
          return fresh;
        });
      }
    } catch { /* keep the streamed version */ }
  }, []);

  // `attaching` marks a reconnect (page refresh) rather than a fresh send, so the server knows a
  // missing session is worth reporting as `detached` instead of a race with the send that's coming.
  const ensureStream = useCallback((attaching?: boolean) => {
    if (esRef.current) return;
    const es = new EventSource(`/api/agent/stream?key=${encodeURIComponent(paneKey)}${attaching ? "&attach=1" : ""}`);
    // EventSource silently auto-reconnects at the transport level on a network blip (mobile switching
    // networks, laptop sleep/wake, a proxy idle-killing the connection) — `onopen` fires again each time
    // that happens, not just on the very first connect. Left alone, that reconnect is invisible at the
    // app level: it reuses this stream's ORIGINAL url, which doesn't carry `attach=1` when this stream
    // was opened by send() — so a session that fully ended while we were disconnected never gets reported
    // `detached` (the server just parks us in `waiting`, see subscribe() in lib/agent/manager.ts), and
    // even if it's still alive, the client only resyncs `turns` from the resent `snapshot` when
    // `attachingRef.current` is true, which a bare reconnect never sets. Both add up to: a dropped
    // connection leaves the transcript frozen at whatever it was when it dropped until the user manually
    // reloads the page (which happens to go through the real attach() path). Fix: treat every open PAST
    // the first as a signal to replace this connection with an explicit attach — same server-side
    // handling a manual refresh gets, just automatic.
    let opens = 0;
    es.onopen = () => {
      opens++;
      if (opens > 1) { closeStream(); attachingRef.current = true; ensureStream(true); }
    };
    es.onmessage = (e) => {
      let ev: any;
      try { ev = JSON.parse(e.data); } catch { return; }
      switch (ev.t) {
        case "init":
          setSessionId(ev.sessionId); sessionIdRef.current = ev.sessionId;
          // What this session is ACTUALLY on, reported by the SDK rather than assumed from the picker.
          // The composer needs it because the box pin lives in lib/model-pins.ts, which reads ~/Minami's
          // config off disk and so cannot be imported into a browser component — and mirroring the id
          // client-side to render a "default" label is precisely the drift that file exists to prevent.
          if (ev.model) setSessionModel(ev.model);
          break;
        case "delta":
          lastDeltaAtRef.current = Date.now();
          setTurns((prev) => {
            const next = prev.slice();
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === "assistant" && next[i].streaming) { next[i] = { ...next[i], text: next[i].text + ev.text }; return next; }
            }
            // No open streaming turn (e.g. we just reattached between messages) — start one.
            next.push({ role: "assistant", text: ev.text, tools: [], streaming: true });
            return next;
          });
          break;
        case "thinking":
          lastDeltaAtRef.current = Date.now();
          setTurns((prev) => {
            const next = prev.slice();
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === "assistant" && next[i].streaming) {
                next[i] = { ...next[i], thinking: (next[i].thinking || "") + ev.text };
                return next;
              }
            }
            next.push({ role: "assistant", text: "", tools: [], streaming: true, thinking: ev.text });
            return next;
          });
          break;
        case "snapshot": {
          if (typeof ev.ctxUsed === "number") setCtxUsed(ev.ctxUsed);
          // The activity state is always safe to adopt — REPLACE semantics, idempotent, never clobbers
          // anything. This matters even on a fresh send(): the POST (sendMessage) and the GET (this
          // stream's subscribe) race, and the POST usually wins, broadcasting the turn's opening
          // activity (e.g. `spawning`) to zero subscribers a few ms before this snapshot arrives as the
          // only copy of it the client will ever see. Applying it here is what makes that first phase
          // visible at all instead of silently lost to the race.
          if (ev.activity) applyActivity(ev.activity);
          // Always adopted, for the same reason as `activity`: it's the server's truth, replace
          // semantics, and a pane that refreshed while a hold was armed must come back holding.
          setHoldState(!!ev.hold);
          // Same contract, and the same reason it's outside the `attachingRef` guard below: the queue
          // lives only in the server's mirror of the CLI's queue, so a refreshed pane has no local copy
          // to preserve and adopting the server's is always right.
          setQueued(ev.queued || []);
          // A snapshot only ever arrives for a key the server confirms is live (see subscribe() in
          // lib/agent/manager.ts) — so this is the actual proof `resume` can be safely omitted from here
          // on, whether this snapshot came from a genuine reattach or the fresh-send race above.
          sentOnce.current = true;
          // The TURNS reconstruction below is different: it's only meaningful for a reconnect (attach())
          // — on a fresh send() we've already staged the local turns, so rebuilding from disk here would
          // clobber them. attach() flips this ref on; send() explicitly flips it off.
          if (!attachingRef.current) break;
          attachingRef.current = false;
          setDetached(false); setLive(true); setBusy(ev.busy);
          // Rebuild the transcript: on-disk history + the in-flight message (partial) still streaming.
          const overlay: AgentTurn[] = ev.busy ? [{ role: "assistant", text: ev.partial || "", tools: [], streaming: true, thinking: ev.partialThinking || "" }] : [];
          // Captured BEFORE the disk fetch below — see the freshness check in its `.then()`.
          const resyncStartedAt = Date.now();
          const sid = sessionIdRef.current;
          if (sid) {
            fetch(`/api/bento/session/${sid}`).then((r) => r.json()).then((d) => {
              const seed: AgentTurn[] = Array.isArray(d?.turns) ? d.turns.map((t: AgentTurn) => ({ role: t.role, text: t.text, tools: t.tools || [] })) : [];
              // Whether to trust the locally-held streaming turn over `overlay` (this event's `ev.partial`,
              // captured the instant this resync began) hinges on whether the connection was actually alive
              // the whole time. Two cases land here: (a) a genuine attach() on a fresh page load, where
              // `prev` has no streaming turn at all — overlay wins trivially; (b) THIS stream silently
              // dropped and the browser's EventSource auto-reconnected (see the onopen counter above) — the
              // locally-held turn is exactly what's missing whatever streamed in during the outage, so
              // `overlay`/`seed` (the server's current truth) must win, not the stale local copy. A THIRD,
              // narrower case is why "prefer local" isn't simply removed: a still-live connection can keep
              // delivering delta/thinking events for the in-flight turn while this fetch is in the air — in
              // that case the local turn is actually AHEAD of `overlay` and rolling back to it would visibly
              // "un-stream" text the user already saw. Distinguish the two by whether a delta actually
              // landed after this resync started (only possible if the connection was live throughout).
              setTurns((prev) => {
                const liveTurn = prev.find((t) => t.streaming);
                const staleAfterOutage = !liveTurn || lastDeltaAtRef.current <= resyncStartedAt;
                const tail = liveTurn && !staleAfterOutage ? [liveTurn] : overlay;
                // The in-flight message is often ALREADY on disk. A turn that stops at a tool call —
                // a permission prompt, or an AskUserQuestion — has had its assistant message written
                // out (that's the message carrying the tool_use), while `partial` still holds the same
                // text because the turn hasn't ended. Concatenating seed + tail therefore rendered the
                // reply twice, once above the reasoning block and once below it. Attaching to a parked
                // turn is the normal case for an agent's onboarding interview, so this is not an edge:
                // it's what you see every time you open one. Compare by prefix in either direction —
                // whichever side is further along, they are the same message.
                // NOT simply `seed[seed.length - 1]`: the CLI splits one reply across two assistant
                // rows when it ends in a tool call — the prose lands in one, and the tool_use in a
                // second whose text is empty. So the copy that duplicates `partial` is the last
                // assistant turn WITH TEXT, which is usually the second-to-last row, and comparing
                // against the final row silently matched nothing.
                // Explicit reverse loop rather than findLastIndex: `target` is ES2017 here, so that
                // method is a runtime-lib call TypeScript will happily accept and older engines won't
                // have. Nothing else in this codebase relies on it, and this is not the file to start.
                let dupAt = -1;
                if (tail[0]?.role === "assistant" && tail[0].text.trim()) {
                  for (let i = seed.length - 1; i >= 0; i--) {
                    const t = seed[i];
                    if (t.role !== "assistant" || !t.text.trim()) continue;
                    if (tail[0].text.startsWith(t.text) || t.text.startsWith(tail[0].text)) { dupAt = i; }
                    break; // only the LAST texted assistant turn can be the in-flight one
                  }
                }
                return dupAt < 0
                  ? [...seed, ...tail]
                  : [...seed.slice(0, dupAt), ...seed.slice(dupAt + 1), ...tail];
              });
            }).catch(() => setTurns(overlay));
          } else setTurns(overlay);
          break;
        }
        case "detached":
          // The server has no live session for this key (it ended or was reclaimed) — fall back to disk.
          // Re-arm `resume`: the next send() must hand the SDK its session id again so it resumes the
          // on-disk conversation instead of silently starting a fresh, context-less one.
          attachingRef.current = false; sentOnce.current = false;
          // The brake lived on the (now gone) server session — keeping it lit here would claim a
          // supervision state nothing is enforcing, and the next send would start unheld regardless.
          setHoldState(false);
          setDetached(true); setLive(false); closeStream();
          break;
        case "activity":
          applyActivity(ev.activity); break;
        case "tool":
          setTurns((prev) => {
            const next = prev.slice();
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === "assistant" && next[i].streaming) {
                // content_block_start already registered this id server-side; the assistant message
                // then re-broadcasts it with real arguments. Update in place instead of duplicating.
                const tools = next[i].tools.slice();
                const at = ev.id ? tools.findIndex((t) => t.id === ev.id) : -1;
                if (at >= 0) tools[at] = { ...tools[at], name: ev.name, input: ev.input };
                else tools.push({ name: ev.name, input: ev.input, id: ev.id });
                next[i] = { ...next[i], tools };
                break;
              }
            }
            return next;
          });
          break;
        case "tool_end":
          // Mark the call finished so the transcript can show ✓/✗ + duration rather than leaving every
          // tool looking perpetually in-flight. `output` (text/images) rides along here — this is what
          // lets a browser tool's screenshot show up the instant the call returns.
          setTurns((prev) => prev.map((t) => {
            if (!t.tools.some((x) => x.id === ev.id)) return t;
            return { ...t, tools: t.tools.map((x) => (x.id === ev.id ? { ...x, done: true, ok: ev.ok, ms: ev.ms, output: ev.output } : x)) };
          }));
          break;
        case "notice":
          setNotices((prev) => [...prev.slice(-4), { kind: ev.kind, text: String(ev.text || ""), at: Date.now(), agent: ev.agent, status: ev.status }]);
          break;
        case "ctx":
          setCtxUsed(typeof ev.used === "number" ? ev.used : null); break;
        case "relocated":
          // The placement pass moved this conversation to a new folder. Two duties, same contract
          // as a model swap's `respawned`: the next send must carry `resume` (the session was torn
          // down; the conversation continues from disk), and it must carry the NEW cwd — which
          // lives in ChatColumn's state, so it is surfaced here for the pane to adopt. The notice
          // makes it visible; a chat that silently changes folders reads as a bug.
          sentOnce.current = false;
          setRelocatedTo(String(ev.cwd || "") || null);
          setNotices((prev) => [...prev.slice(-4), { kind: "relocated", text: String(ev.text || "moved"), at: Date.now() }]);
          break;
        case "permission":
          setPending({ id: ev.id, toolName: ev.toolName, input: ev.input, held: ev.held, expiresAt: ev.expiresAt }); break;
        case "hold":
          setHoldState(!!ev.hold); break;
        case "ask":
          setAsk({ id: ev.id, questions: ev.questions || [] }); break;
        case "busy":
          setBusy(ev.busy); if (!ev.busy) setStopping(false); break;
        case "queued":
          setQueued(ev.queued || []); break;
        case "started":
          // A queued message just became the running turn. Write it into the transcript NOW, the same
          // shape send() stages: the message, then an empty streaming bubble for the reply.
          //
          // Optimistic appends are safe HERE and were not at queue time, and the difference is which
          // reconcile() comes next. Queued, the next reconcile is the RUNNING turn's `result`, which
          // rebuilds `turns` from a disk transcript the message isn't in yet — so the bubble vanished.
          // Started, the previous result has already fired; the next one ends THIS turn, by which point
          // the message is on disk and reconcile replaces this row with the real one. Same text, no
          // duplicate.
          //
          // Without it the message is invisible for the length of the turn: the tray drops it on
          // `started` and the transcript doesn't gain it until `result`, so a long turn streams a reply
          // with no question above it.
          setTurns((prev) => [
            ...prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
            { role: "user", text: ev.text, tools: [] },
            { role: "assistant", text: "", tools: [], streaming: true },
          ]);
          break;
        case "result":
          setBusy(false); setStopping(false); setPending(null); setAsk(null); applyActivity(IDLE_ACTIVITY);
          setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)));
          reconcile();
          break;
        case "error":
          // The server side of this session is gone for good once it emits "error" (see manager.ts's
          // consumer-loop catch) — any permission/ask prompt still shown here will never be answerable
          // (its POST would 404 against a session the server already deleted), so clear it instead of
          // leaving a dialog stuck on screen forever with no working button.
          setError(String(ev.message || "error")); setBusy(false); setStopping(false); applyActivity(IDLE_ACTIVITY);
          setPending(null); setAsk(null); setHoldState(false);
          break;
      }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    esRef.current = es;
  }, [paneKey, reconcile, closeStream, applyActivity]);

  // Force the server to REPLAY onto a stream that is already open.
  //
  // `attach()` cannot do this and shouldn't: it ends in ensureStream(), which no-ops when a stream
  // exists — correct for its own callers (mount, reattach-after-release), useless here. Replay happens
  // exactly once per subscribe, so getting it again means dropping the connection and taking a new one.
  const resync = useCallback(() => {
    closeStream();
    attachingRef.current = true;
    ensureStream(true);
  }, [closeStream, ensureStream]);

  // Heal the stream when a backgrounded tab comes back. Mobile browsers freeze (and often outright
  // close) an EventSource while the tab is in the background, and coming back doesn't reliably fire the
  // reconnect path in ensureStream()'s onopen counter — so the pane sits frozen on whatever it last
  // saw, sometimes mid-sentence, until a manual reload. Checking readyState is the point: a stream the
  // browser is already re-dialling (CONNECTING) heals itself and must be left alone; only a CLOSED one
  // needs replacing. Paired with the longer server-side reap window (IDLE_REAP_MS in
  // lib/agent/manager.ts), this is what lets the phone view survive being put in a pocket.
  //
  // The same handler also runs the OPPOSITE direction — releasing a stream that has been hidden for a
  // while — because an open tab is what pins the SDK subprocess in memory. The server only arms its
  // idle reaper when a session's subscriber count reaches zero (`scheduleIdle`, and note the
  // `subs.size !== 0` early return inside it), and a visible pane's EventSource is always a subscriber.
  // So `IDLE_REAP_MS` never got a chance to apply to a tab someone left open: measured on this box,
  // each live pane pins a ~400 MB `claude` process indefinitely, on a 16 GB machine that was down to
  // 81 MB free with 6 GB in swap. Dropping the stream after a long hide hands the session back to the
  // existing reaper instead of inventing a second eviction path.
  //
  // Hiding is not the only way a pane stops needing its subprocess — it is just the most obvious one.
  // A pane sitting VISIBLE and untouched pins ~400 MB exactly as hard as a hidden one, and measurably
  // does: with two agents on the box, one idle session held 388 MB while a 16 GB machine sat at 71 MB
  // free. So the trigger is inactivity, with a shorter fuse when the tab is also hidden.
  //
  // Unpinning is close to free, which is what makes the short fuse safe. It only removes the SSE
  // subscriber; the session stays warm until the server's own 30-minute reaper decides otherwise, so
  // returning inside that window costs one reconnect and nothing else. Only a pane left for
  // UNPIN_IDLE + IDLE_REAP actually pays a cold start — and that is precisely the trade IDLE_REAP_MS
  // already encodes for every session the dashboard isn't watching.
  const UNPIN_IDLE_MS = 5 * 60 * 1000;
  const UNPIN_HIDDEN_MS = 60 * 1000; // hidden AND idle: nobody can be reading it, so don't wait long
  const releasedRef = useRef(false);
  // Everything the check needs lives in refs: a single interval that reads state through refs cannot
  // develop the stale-closure and cleared-timer bugs that a per-transition setTimeout chain did (an
  // earlier version silently lost its pending timer whenever the effect re-registered).
  const releasableRef = useRef(true);
  releasableRef.current = !busy && !pending && !ask;
  const lastActiveRef = useRef(Date.now());
  if (busy || pending || ask) lastActiveRef.current = Date.now();
  const liveRef = useRef(live); liveRef.current = live;
  const detachedRef = useRef(detached); detachedRef.current = detached;

  useEffect(() => {
    const reattach = () => {
      if (!releasedRef.current) return;
      releasedRef.current = false;
      if (esRef.current) return; // a send() already reopened it — don't flag a resync over a live stream
      attachingRef.current = true; // full resync, same path a manual refresh takes
      ensureStream(true);
    };
    // Any real interaction means this pane is in use again — re-attach before the user can notice it
    // was ever detached, and restart its idle clock.
    const onInteract = () => {
      lastActiveRef.current = Date.now();
      if (document.visibilityState === "visible") reattach();
    };
    const check = () => {
      if (!esRef.current || !liveRef.current || detachedRef.current) return; // nothing pinned to give back
      // Never release mid-turn or over an unanswered prompt: a parked permission/AskUserQuestion promise
      // is auto-denied once the server reaps the session, so releasing would answer for the user, and
      // dropping the stream mid-turn loses the tokens it was carrying. The next tick re-checks, so a long
      // unattended turn is still released once it lands.
      if (!releasableRef.current) return;
      const idleFor = Date.now() - Math.max(lastActiveRef.current, lastDeltaAtRef.current);
      const limit = document.visibilityState === "visible" ? UNPIN_IDLE_MS : UNPIN_HIDDEN_MS;
      if (idleFor < limit) return;
      closeStream();
      releasedRef.current = true;
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") { check(); return; } // may already be over the limit
      // Came back to a stream we let go on purpose. Re-attach down the same path a refresh takes: if the
      // session survived, the snapshot rebuilds the pane; if the reaper got it, the server says
      // `detached` and the pane falls back to disk with `resume` re-armed for the next send.
      if (releasedRef.current) { lastActiveRef.current = Date.now(); reattach(); return; }
      if (!live || detached) return; // never went live, or the session is legitimately gone
      const es = esRef.current;
      if (es && es.readyState !== EventSource.CLOSED) return; // open, or already reconnecting
      closeStream();
      attachingRef.current = true;
      ensureStream(true);
    };
    const iv = setInterval(check, 30_000);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("pointerdown", onInteract, { passive: true });
    document.addEventListener("keydown", onInteract, { passive: true });
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", onInteract);
      document.removeEventListener("keydown", onInteract);
    };
  }, [live, detached, closeStream, ensureStream, UNPIN_IDLE_MS, UNPIN_HIDDEN_MS]);

  // ── The one-shot events, and why they need a watchdog ────────────────────────────────────────────
  //
  // `activity`, `hold` and `queued` are REPLACE semantics: the server re-broadcasts the whole value on
  // every change, so a client that misses one is corrected by the next. That is the convention this
  // pipeline is built on — and `ask`/`permission` are the exception to it. Each is broadcast exactly
  // ONCE, at the moment canUseTool parks its promise (see manager.ts), and the only other copy is the
  // replay handed to a fresh subscribe. So a single lost delivery is permanent: the session sits at
  // `phase=awaiting`, the composer says "waiting on your answer", and the card that would answer it
  // never arrives. Reloading the page fixes it because a reload re-subscribes — and nothing else did,
  // which is exactly how this reads as "the question doesn't show up until I hit F5".
  //
  // A lost delivery has more than one cause and we do not need to know which one it was: a suspended
  // background tab, a socket the server hasn't yet noticed is dead, an EventSource that reconnected at
  // the transport level without the onopen counter firing. What they share is the observable state
  // below.
  //
  // The inconsistency is self-evident and cheap: the server says this pane is BLOCKED ON THE USER while
  // the pane holds no prompt to show. Those two facts are broadcast microseconds apart, so the gap is
  // real only in flight — sustained, it means the prompt was lost. Re-subscribe and the replay returns
  // it. Once per episode, never in a loop: if the resync produces nothing (a phase that is itself
  // stale), `healed` stays set until the phase actually changes.
  const healedRef = useRef(false);
  useEffect(() => {
    if (!live || detached) return;
    if (activity.phase !== "awaiting" || pending || ask) { healedRef.current = false; return; }
    if (healedRef.current) return;
    const t = setTimeout(() => { healedRef.current = true; resync(); }, AWAIT_HEAL_MS);
    return () => clearTimeout(t);
  }, [live, detached, activity.phase, pending, ask, resync]);

  // Reattach to a still-running server session after a page refresh: open the stream and let the
  // server's snapshot rebuild the transcript (history + in-flight message + any pending prompt). If no
  // live session backs this pane, the server replies `detached` and we quietly fall back to disk.
  const attach = useCallback((resumeId?: string) => {
    if (resumeId && !sessionIdRef.current) { setSessionId(resumeId); sessionIdRef.current = resumeId; }
    // NB: sentOnce is deliberately left untouched here — whether resume can be skipped depends on
    // whether the server confirms this key is actually live (snapshot) or not (detached), both handled
    // in ensureStream() above. Setting it true here regardless was the bug.
    setError(null); setDetached(false); attachingRef.current = true;
    ensureStream(true);
  }, [ensureStream]);

  // A failed send() below stages an empty `{streaming: true}` assistant bubble optimistically before
  // the request even goes out — without this, a failure leaves that placeholder in the transcript
  // forever (it renders as nothing, since there's no text) until the NEXT successful turn's `result`
  // event happens to call reconcile() and overwrite `turns` wholesale. Marking it done immediately
  // means a failed send doesn't leave a dangling ghost turn for however long the user waits before
  // trying again.
  const unstickTrailingTurn = useCallback(() => {
    setTurns((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      if (!last.streaming) return prev;
      return [...prev.slice(0, -1), { ...last, streaming: false }];
    });
  }, []);

  // Queue a follow-up into the turn that's already running. Deliberately NOT a branch inside send():
  // send()'s whole body is turn-start staging — a new user turn plus an empty `{streaming: true}`
  // assistant bubble, `setBusy(true)`, a `thinking` activity — and every one of those is wrong here.
  // The assistant bubble in particular would be a second, permanent ghost reply next to the real one.
  //
  // Nothing is staged locally at all: the server answers with a `queued` event and that list is the only
  // copy the UI renders. Appending the queued text to `turns` optimistically would look right and then
  // vanish, because the running turn's `result` triggers reconcile(), which rebuilds `turns` wholesale
  // from the on-disk transcript — where a message that hasn't run yet does not appear.
  const queueMessage = useCallback(async (text: string, opts: { cwd: string; mode: AgentMode }) => {
    const clean = text.trim();
    if (!clean || !opts.cwd) return;
    setError(null);
    try {
      const r = await fetch("/api/agent/send", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: paneKey, cwd: opts.cwd, message: clean, mode: opts.mode, hold: holdRef.current }),
      });
      const d = await r.json();
      if (d?.error) setError(d.error);
    } catch (e) {
      setError(`Couldn't queue that message — try again (${String((e as Error)?.message || e)})`);
    }
  }, [paneKey]);

  // Send a user message. `seed` = the existing (file) transcript to preserve when going live;
  // `resume` = the Claude session id to continue on the pane's first send.
  const send = useCallback(async (text: string, opts: { cwd: string; mode: AgentMode; resume?: string; seed?: AgentTurn[]; model?: string | null; fanout?: boolean }) => {
    const clean = text.trim();
    if (!clean || !opts.cwd) return;
    setError(null); setDetached(false); attachingRef.current = false;
    turnsGenRef.current++; // invalidate any in-flight reconcile() from a previous turn — see its comment
    setTurns((prev) => {
      const base = live ? prev : (opts.seed || []);
      return [...base, { role: "user", text: clean, tools: [] }, { role: "assistant", text: "", tools: [], streaming: true }];
    });
    // Start the indicator optimistically on the click, not on the server's first event — the POST +
// SSE round-trip is otherwise a visible dead beat right after hitting send.
    setLive(true); setBusy(true);
    applyActivity({ phase: "thinking", label: "thinking…", elapsedMs: 0, tools: [], tasks: [] });
    ensureStream();
    // Adopting the id up front is what lets the pane stream and reconcile as that conversation — but it
    // has to be UNDONE if the server rejects the send, so remember whether this call is what adopted it.
    const adoptedHere = !sessionIdRef.current && !!opts.resume;
    if (adoptedHere) { setSessionId(opts.resume!); sessionIdRef.current = opts.resume!; }
    const usingResume = !sentOnce.current;
    // `model` rides on every send, not just the first. It's creation-only on the server, so on a warm
    // session it is simply ignored — but that means the pane's pick is authoritative on whichever send
    // turns out to be the cold one, without this caller having to know which that is. Same reasoning as
    // `mode` being re-applied per turn in sendMessage.
    // `fanout` rides like `model` and for the same reason: creation-only server-side, so sending it
    // every turn makes the pill authoritative on whichever send happens to be the cold one.
    const body = { key: paneKey, cwd: opts.cwd, message: clean, mode: opts.mode, resume: usingResume ? opts.resume : undefined, hold: holdRef.current, model: opts.model || undefined, fanout: opts.fanout };
    try {
      const r = await fetch("/api/agent/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      // Only latch sentOnce once the server actually accepted this send — the snapshot handler above
      // is the other (more common) place this flips true. On failure, leave it alone so a retry still
      // offers `resume` instead of quietly falling back to a fresh, context-less session.
      if (d?.error) {
        setError(d.error); setBusy(false); applyActivity(IDLE_ACTIVITY); unstickTrailingTurn();
        // Give the id back. The server refuses a resume whose conversation is already live under another
        // key — and without this the pane KEPT the id it was just refused, so a rejected "continue last
        // chat" silently re-pointed the pane at that conversation (onLive → pane.sid) while its message
        // was never delivered. Only ever undoes an adoption made by THIS call.
        if (adoptedHere) { setSessionId(null); sessionIdRef.current = null; }
      }
      else { sentOnce.current = true; if (d?.sessionId && !sessionIdRef.current) { setSessionId(d.sessionId); sessionIdRef.current = d.sessionId; } }
    } catch (e) {
      setError(String((e as Error)?.message || e)); setBusy(false); applyActivity(IDLE_ACTIVITY); unstickTrailingTurn();
    }
  }, [paneKey, live, ensureStream, applyActivity, unstickTrailingTurn]);

  // `message` is only meaningful on a denial, and it is the steering channel: the text is handed back
  // to Claude as the tool result, so a correction written against a held step is read and acted on
  // WITHIN the same turn instead of arriving as a follow-up after the step already ran.
  const respond = useCallback(async (decision: "allow" | "deny", message?: string) => {
    const p = pending; if (!p) return;
    // Clear only once the server actually has the decision — not optimistically before the fetch. If
    // the POST fails (network blip), the prompt stays up (with an error shown) so the user can retry;
    // otherwise the UI would show no prompt at all while the server-side session is still blocked
    // waiting for one, stuck until a full reload.
    try {
      const r = await fetch("/api/agent/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, id: p.id, decision, message }) });
      const d = await r.json().catch(() => null);
      if (!d?.ok) throw new Error("the server didn't confirm this decision");
      setPending(null);
    } catch (e) { setError(`Couldn't send that decision — try again (${String((e as Error)?.message || e)})`); }
  }, [pending, paneKey]);

  const answerAsk = useCallback(async (answers: Record<string, string | string[]>) => {
    const a = ask; if (!a) return;
    // Same reasoning as respond() above — don't clear the prompt until the server confirms it landed.
    try {
      const r = await fetch("/api/agent/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, id: a.id, answers }) });
      const d = await r.json().catch(() => null);
      if (!d?.ok) throw new Error("the server didn't confirm this answer");
      setAsk(null);
    } catch (e) { setError(`Couldn't send that answer — try again (${String((e as Error)?.message || e)})`); }
  }, [ask, paneKey]);

  // Point this pane at a different model. Returns whether it applied, so the composer's picker can
  // revert rather than display a model the session isn't on — the same contract as changeMode().
  //
  // The interesting half is `respawned`. A warm session cannot change model (see setModel on the
  // server), so the server tears it down; the conversation then has to be picked back up off disk,
  // which means the NEXT send must carry `resume`. `sentOnce` is the flag that decides that, and it is
  // true by now for any live pane — so re-arming it here is the whole handover. Miss this line and the
  // swap silently starts a brand-new, context-less session that looks like the same chat, which is the
  // exact failure `sentOnce`'s own comment documents from the idle-reap path.
  const changeModel = useCallback(async (model: string | null): Promise<boolean> => {
    try {
      const r = await fetch("/api/agent/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, model }) });
      const d = await r.json().catch(() => null);
      if (!d?.ok) { if (d?.reason || d?.error) setError(d.reason || d.error); return false; }
      if (d.respawned) sentOnce.current = false;
      return true;
    } catch (e) { setError(`Couldn't switch model — ${String((e as Error)?.message || e)}`); return false; }
  }, [paneKey]);

  // changeModel's twin for the fan-out pill — same respawn contract, same `sentOnce` re-arm. See
  // changeModel above for why missing that re-arm silently forks a context-less session.
  const changeFanout = useCallback(async (fanout: boolean): Promise<boolean> => {
    try {
      const r = await fetch("/api/agent/fanout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, fanout }) });
      const d = await r.json().catch(() => null);
      if (!d?.ok) { if (d?.reason || d?.error) setError(d.reason || d.error); return false; }
      if (d.respawned) sentOnce.current = false;
      return true;
    } catch (e) { setError(`Couldn't switch fan-out — ${String((e as Error)?.message || e)}`); return false; }
  }, [paneKey]);

  // Returns whether the server actually applied the mode change, so the caller (the Plan/Code and
  // approval-level toggles in app/page.tsx) can revert its own optimistic UI state on failure instead
  // of silently diverging from what the live session is really running under.
  const changeMode = useCallback(async (mode: AgentMode): Promise<boolean> => {
    if (!live) return true; // no live session yet — the chosen mode just applies whenever one starts
    try {
      const r = await fetch("/api/agent/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, mode }) });
      const d = await r.json().catch(() => null);
      return !!d?.ok;
    } catch { return false; }
  }, [live, paneKey]);

  // Arm/release the brake. Optimistic so the toggle feels instant, reverted if no live session took
  // it — a lit brake that the gate isn't honouring is the one state this must never show.
  const setHold = useCallback(async (on: boolean): Promise<boolean> => {
    setHoldState(on);
    // Nothing live to arm yet. Keep the intent locally — send() carries it in with the first message,
    // which is the only point at which it can be applied before the session's first tool call. Without
    // this the natural order (arm the brake, THEN ask for something) silently did nothing.
    if (!live) return true;
    try {
      const r = await fetch("/api/agent/hold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, hold: on }) });
      const d = await r.json().catch(() => null);
      if (!d?.ok) { setHoldState(!on); return false; }
      return true;
    } catch { setHoldState(!on); return false; }
  }, [paneKey, live]);

  // Interrupt the in-flight turn (Stop button). `stopping` flips back to false once the server
  // confirms via a `busy:false` / `result` / `error` event — not optimistically here — so the button
  // stays disabled for the (usually sub-second) gap rather than flickering back to "stop" too early.
  const stop = useCallback(async () => {
    if (!live || !busy || stopping) return;
    setStopping(true);
    try {
      const r = await fetch("/api/agent/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey }) });
      const d = await r.json();
      if (!d?.ok) setStopping(false);
    } catch { setStopping(false); }
  }, [live, busy, stopping, paneKey]);

  // `elapsed` recomputes on every 1s tick above, so the caller gets a live-counting number for free.
  const elapsed = activity.phase === "idle" ? 0 : Math.max(0, Date.now() - phaseStart);
  return { turns, live, busy, stopping, pending, ask, activity, elapsed, notices, sessionId, sessionModel, relocatedTo, ctxUsed, error, detached, hold, queued, send, queueMessage, attach, respond, answerAsk, changeMode, changeModel, changeFanout, setHold, stop };
}
