"use client";
// Client hook that drives one live Claude Code session (Phase 2). It POSTs user messages, opens an
// SSE stream for the reply, accumulates streamed tokens into a transcript, surfaces tool-permission
// prompts, and — when a turn finishes — reconciles the transcript from the authoritative JSONL file
// (so Markdown/tools render exactly as elsewhere and any streaming gap is healed).
import { useCallback, useEffect, useRef, useState } from "react";

export type AgentTurn = { role: "user" | "assistant"; text: string; tools: { name: string; input: unknown }[]; streaming?: boolean };
export type PermissionPrompt = { id: string; toolName: string; input: unknown } | null;
export type AgentQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };
export type AskPrompt = { id: string; questions: AgentQuestion[] } | null;
export type AgentMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type Activity = { name: string; label: string } | null;

const base = (p: string) => String(p).split("/").filter(Boolean).pop() || String(p);
// A short human label for "what Claude is doing right now", from a tool call.
export function activityLabel(name: string, input: unknown): string {
  const o = (input || {}) as Record<string, unknown>;
  if (name === "Bash") return o.command ? `run: ${String(o.command).replace(/\s+/g, " ").slice(0, 48)}` : "running a command";
  if ((name === "Edit" || name === "Write" || name === "NotebookEdit") && o.file_path) return `editing ${base(String(o.file_path))}`;
  if (name === "Read" && o.file_path) return `reading ${base(String(o.file_path))}`;
  if (name === "Grep") return `searching “${String(o.pattern || "").slice(0, 30)}”`;
  if (name === "Glob") return `globbing ${String(o.pattern || "")}`;
  if (name === "WebFetch" || name === "WebSearch") return `browsing the web`;
  if (name === "TodoWrite") return "updating the plan";
  if (name === "Task") return "running a subagent";
  return `using ${name}`;
}

export function useAgent(paneKey: string) {
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [live, setLive] = useState(false); // has this pane started driving a session?
  const [busy, setBusy] = useState(false); // a turn is in flight
  const [pending, setPending] = useState<PermissionPrompt>(null);
  const [ask, setAsk] = useState<AskPrompt>(null); // Claude's AskUserQuestion prompt
  const [activity, setActivity] = useState<Activity>(null); // what Claude is doing right now
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const sentOnce = useRef(false); // pass `resume` only on the first send of a pane
  const sessionIdRef = useRef<string | null>(null);

  const closeStream = useCallback(() => { esRef.current?.close(); esRef.current = null; }, []);
  useEffect(() => closeStream, [closeStream]);

  // Reload the authoritative transcript from disk after a turn completes.
  const reconcile = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const d = await fetch(`/api/bento/session/${id}`).then((r) => r.json());
      if (Array.isArray(d?.turns)) {
        setTurns(d.turns.map((t: AgentTurn) => ({ role: t.role, text: t.text, tools: t.tools || [] })));
      }
    } catch { /* keep the streamed version */ }
  }, []);

  const ensureStream = useCallback(() => {
    if (esRef.current) return;
    const es = new EventSource(`/api/agent/stream?key=${encodeURIComponent(paneKey)}`);
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
              if (next[i].role === "assistant" && next[i].streaming) { next[i] = { ...next[i], text: next[i].text + ev.text }; break; }
            }
            return next;
          });
          break;
        case "tool":
          setActivity({ name: ev.name, label: activityLabel(ev.name, ev.input) });
          setTurns((prev) => {
            const next = prev.slice();
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === "assistant" && next[i].streaming) { next[i] = { ...next[i], tools: [...next[i].tools, { name: ev.name, input: ev.input }] }; break; }
            }
            return next;
          });
          break;
        case "permission":
          setPending({ id: ev.id, toolName: ev.toolName, input: ev.input }); break;
        case "ask":
          setAsk({ id: ev.id, questions: ev.questions || [] }); break;
        case "busy":
          setBusy(ev.busy); break;
        case "result":
          setBusy(false); setPending(null); setAsk(null); setActivity(null);
          setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)));
          reconcile();
          break;
        case "error":
          setError(String(ev.message || "error")); setBusy(false); setActivity(null); break;
      }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    esRef.current = es;
  }, [paneKey, reconcile]);

  // Send a user message. `seed` = the existing (file) transcript to preserve when going live;
  // `resume` = the Claude session id to continue on the pane's first send.
  const send = useCallback(async (text: string, opts: { cwd: string; mode: AgentMode; resume?: string; seed?: AgentTurn[] }) => {
    const clean = text.trim();
    if (!clean || !opts.cwd) return;
    setError(null);
    setTurns((prev) => {
      const base = live ? prev : (opts.seed || []);
      return [...base, { role: "user", text: clean, tools: [] }, { role: "assistant", text: "", tools: [], streaming: true }];
    });
    setLive(true); setBusy(true); ensureStream();
    if (!sessionIdRef.current && opts.resume) { setSessionId(opts.resume); sessionIdRef.current = opts.resume; }
    const body = { key: paneKey, cwd: opts.cwd, message: clean, mode: opts.mode, resume: sentOnce.current ? undefined : opts.resume };
    sentOnce.current = true;
    try {
      const r = await fetch("/api/agent/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d?.error) { setError(d.error); setBusy(false); }
      else if (d?.sessionId && !sessionIdRef.current) { setSessionId(d.sessionId); sessionIdRef.current = d.sessionId; }
    } catch (e) { setError(String((e as Error)?.message || e)); setBusy(false); }
  }, [paneKey, live, ensureStream]);

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

  return { turns, live, busy, pending, ask, activity, sessionId, error, send, respond, answerAsk, changeMode };
}
