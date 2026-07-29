"use client";
// Client hook that drives one live Claude Code session (Phase 2). It POSTs user messages, opens an
// SSE stream for the reply, accumulates streamed tokens into a transcript, surfaces tool-permission
// prompts, and — when a turn finishes — reconciles the transcript from the authoritative JSONL file
// (so Markdown/tools render exactly as elsewhere and any streaming gap is healed).
import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_ACTIVITY, type ActivityState, type ToolOutput } from "./agent/labels";

export type AgentTurn = { role: "user" | "assistant"; text: string; tools: AgentToolCall[]; streaming?: boolean; thinking?: string };
export type AgentToolCall = { name: string; input: unknown; id?: string; done?: boolean; ok?: boolean; ms?: number; output?: ToolOutput };
export type PermissionPrompt = { id: string; toolName: string; input: unknown } | null;
export type AgentQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };
export type AskPrompt = { id: string; questions: AgentQuestion[] } | null;
export type AgentMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
// `agent`/`status` only ride along on kind "task" — see manager.ts's AgentEvent for why.
export type Notice = { kind: string; text: string; at: number; agent?: string; status?: "completed" | "failed" | "stopped" };

export { activityLabel, toolCategory, escalationHint } from "./agent/labels";
export type { ActivityState, ActivityPhase, ToolCategory, ToolOutput, ToolOutputBlock, TodoItem } from "./agent/labels";

export function useAgent(paneKey: string) {
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [live, setLive] = useState(false); // has this pane started driving a session?
  const [busy, setBusy] = useState(false); // a turn is in flight
  const [stopping, setStopping] = useState(false); // Stop was clicked; waiting for the turn to actually end
  const [pending, setPending] = useState<PermissionPrompt>(null);
  const [ask, setAsk] = useState<AskPrompt>(null); // Claude's AskUserQuestion prompt
  // What Claude is doing right now. Derived on the SERVER (see lib/agent/labels.ts) and delivered with
  // replace semantics, so a dropped event self-heals and a refresh mid-tool-call resumes correctly.
  const [activity, setActivity] = useState<ActivityState>(IDLE_ACTIVITY);
  const [notices, setNotices] = useState<Notice[]>([]); // retries, compactions, denials — non-fatal
  // Wall-clock start of the current phase, translated out of the server's elapsedMs so our own ticking
  // timer never depends on the two clocks agreeing.
  const [phaseStart, setPhaseStart] = useState<number>(() => Date.now());
  const [sessionId, setSessionId] = useState<string | null>(null);
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
          setSessionId(ev.sessionId); sessionIdRef.current = ev.sessionId; break;
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
          // The activity state is always safe to adopt — REPLACE semantics, idempotent, never clobbers
          // anything. This matters even on a fresh send(): the POST (sendMessage) and the GET (this
          // stream's subscribe) race, and the POST usually wins, broadcasting the turn's opening
          // activity (e.g. `spawning`) to zero subscribers a few ms before this snapshot arrives as the
          // only copy of it the client will ever see. Applying it here is what makes that first phase
          // visible at all instead of silently lost to the race.
          if (ev.activity) applyActivity(ev.activity);
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
                return [...seed, ...(liveTurn && !staleAfterOutage ? [liveTurn] : overlay)];
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
        case "permission":
          setPending({ id: ev.id, toolName: ev.toolName, input: ev.input }); break;
        case "ask":
          setAsk({ id: ev.id, questions: ev.questions || [] }); break;
        case "busy":
          setBusy(ev.busy); if (!ev.busy) setStopping(false); break;
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
          setPending(null); setAsk(null);
          break;
      }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    esRef.current = es;
  }, [paneKey, reconcile, closeStream, applyActivity]);

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
  // Deliberately much longer than a glance at another window: the whole point of a warm pane is that
  // switching away and back is free, and re-attaching costs a cold start. This only targets the tab
  // that has genuinely been left open in the background.
  const HIDDEN_RELEASE_MS = 10 * 60 * 1000;
  const hiddenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releasedWhileHiddenRef = useRef(false);
  // Mirrored into a ref because the release timer's callback would otherwise close over the state as it
  // was when the tab was hidden — and "was this pane busy 10 minutes ago" is the wrong question.
  const releasableRef = useRef(true);
  releasableRef.current = !busy && !pending && !ask;
  useEffect(() => {
    const releaseIfSafe = () => {
      hiddenTimerRef.current = null;
      if (document.visibilityState === "visible") return;
      // Never release mid-turn or over an unanswered prompt. A parked permission/AskUserQuestion promise
      // is auto-denied once the server reaps the session, so releasing here would silently answer a
      // question on the user's behalf; and dropping the stream mid-turn loses the tokens it was carrying.
      // Re-check on a short cadence instead, so a long unattended turn is still released once it lands.
      if (!releasableRef.current) { hiddenTimerRef.current = setTimeout(releaseIfSafe, 60_000); return; }
      closeStream();
      releasedWhileHiddenRef.current = true;
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        if (!live || detached) return; // nothing warm to give back
        if (hiddenTimerRef.current) clearTimeout(hiddenTimerRef.current);
        hiddenTimerRef.current = setTimeout(releaseIfSafe, HIDDEN_RELEASE_MS);
        return;
      }
      if (hiddenTimerRef.current) { clearTimeout(hiddenTimerRef.current); hiddenTimerRef.current = null; }
      // Came back to a stream we let go on purpose. Re-attach down the same path a refresh takes: if the
      // session survived, the snapshot rebuilds the pane; if the reaper got it, the server says
      // `detached` and the pane falls back to disk with `resume` re-armed for the next send.
      if (releasedWhileHiddenRef.current) {
        releasedWhileHiddenRef.current = false;
        attachingRef.current = true;
        ensureStream(true);
        return;
      }
      if (!live || detached) return; // never went live, or the session is legitimately gone
      const es = esRef.current;
      if (es && es.readyState !== EventSource.CLOSED) return; // open, or already reconnecting
      closeStream();
      attachingRef.current = true; // full resync, same path a manual refresh takes
      ensureStream(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (hiddenTimerRef.current) { clearTimeout(hiddenTimerRef.current); hiddenTimerRef.current = null; }
    };
  }, [live, detached, closeStream, ensureStream, HIDDEN_RELEASE_MS]);

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

  // Send a user message. `seed` = the existing (file) transcript to preserve when going live;
  // `resume` = the Claude session id to continue on the pane's first send.
  const send = useCallback(async (text: string, opts: { cwd: string; mode: AgentMode; resume?: string; seed?: AgentTurn[] }) => {
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
    const body = { key: paneKey, cwd: opts.cwd, message: clean, mode: opts.mode, resume: usingResume ? opts.resume : undefined };
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

  const respond = useCallback(async (decision: "allow" | "deny") => {
    const p = pending; if (!p) return;
    // Clear only once the server actually has the decision — not optimistically before the fetch. If
    // the POST fails (network blip), the prompt stays up (with an error shown) so the user can retry;
    // otherwise the UI would show no prompt at all while the server-side session is still blocked
    // waiting for one, stuck until a full reload.
    try {
      const r = await fetch("/api/agent/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, id: p.id, decision }) });
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
  return { turns, live, busy, stopping, pending, ask, activity, elapsed, notices, sessionId, error, detached, send, attach, respond, answerAsk, changeMode, stop };
}
