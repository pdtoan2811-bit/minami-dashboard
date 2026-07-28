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
export type Notice = { kind: string; text: string; at: number };

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

  // Reload the authoritative transcript from disk after a turn completes.
  const reconcile = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const d = await fetch(`/api/bento/session/${id}`).then((r) => r.json());
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
    es.onmessage = (e) => {
      let ev: any;
      try { ev = JSON.parse(e.data); } catch { return; }
      switch (ev.t) {
        case "init":
          setSessionId(ev.sessionId); sessionIdRef.current = ev.sessionId; break;
        case "delta":
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
          const sid = sessionIdRef.current;
          if (sid) {
            fetch(`/api/bento/session/${sid}`).then((r) => r.json()).then((d) => {
              const seed: AgentTurn[] = Array.isArray(d?.turns) ? d.turns.map((t: AgentTurn) => ({ role: t.role, text: t.text, tools: t.tools || [] })) : [];
              setTurns([...seed, ...overlay]);
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
          setNotices((prev) => [...prev.slice(-4), { kind: ev.kind, text: String(ev.text || ""), at: Date.now() }]);
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
          setError(String(ev.message || "error")); setBusy(false); setStopping(false); applyActivity(IDLE_ACTIVITY); break;
      }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    esRef.current = es;
  }, [paneKey, reconcile, closeStream, applyActivity]);

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

  // Send a user message. `seed` = the existing (file) transcript to preserve when going live;
  // `resume` = the Claude session id to continue on the pane's first send.
  const send = useCallback(async (text: string, opts: { cwd: string; mode: AgentMode; resume?: string; seed?: AgentTurn[] }) => {
    const clean = text.trim();
    if (!clean || !opts.cwd) return;
    setError(null); setDetached(false); attachingRef.current = false;
    setTurns((prev) => {
      const base = live ? prev : (opts.seed || []);
      return [...base, { role: "user", text: clean, tools: [] }, { role: "assistant", text: "", tools: [], streaming: true }];
    });
    // Start the indicator optimistically on the click, not on the server's first event — the POST +
// SSE round-trip is otherwise a visible dead beat right after hitting send.
    setLive(true); setBusy(true);
    applyActivity({ phase: "thinking", label: "thinking…", elapsedMs: 0, tools: [], tasks: [] });
    ensureStream();
    if (!sessionIdRef.current && opts.resume) { setSessionId(opts.resume); sessionIdRef.current = opts.resume; }
    const usingResume = !sentOnce.current;
    const body = { key: paneKey, cwd: opts.cwd, message: clean, mode: opts.mode, resume: usingResume ? opts.resume : undefined };
    try {
      const r = await fetch("/api/agent/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      // Only latch sentOnce once the server actually accepted this send — the snapshot handler above
      // is the other (more common) place this flips true. On failure, leave it alone so a retry still
      // offers `resume` instead of quietly falling back to a fresh, context-less session.
      if (d?.error) { setError(d.error); setBusy(false); applyActivity(IDLE_ACTIVITY); }
      else { sentOnce.current = true; if (d?.sessionId && !sessionIdRef.current) { setSessionId(d.sessionId); sessionIdRef.current = d.sessionId; } }
    } catch (e) { setError(String((e as Error)?.message || e)); setBusy(false); applyActivity(IDLE_ACTIVITY); }
  }, [paneKey, live, ensureStream, applyActivity]);

  const respond = useCallback(async (decision: "allow" | "deny") => {
    const p = pending; if (!p) return;
    setPending(null);
    try { await fetch("/api/agent/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, id: p.id, decision }) }); } catch { /* ignore */ }
  }, [pending, paneKey]);

  const answerAsk = useCallback(async (answers: Record<string, string | string[]>) => {
    const a = ask; if (!a) return;
    setAsk(null);
    try { await fetch("/api/agent/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, id: a.id, answers }) }); } catch { /* ignore */ }
  }, [ask, paneKey]);

  const changeMode = useCallback(async (mode: AgentMode) => {
    if (!live) return;
    try { await fetch("/api/agent/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: paneKey, mode }) }); } catch { /* ignore */ }
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
