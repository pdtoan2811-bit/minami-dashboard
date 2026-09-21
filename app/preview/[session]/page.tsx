"use client";
// The pop-out preview (§21): your localhost app in an iframe, bound to one chat pane, with a toolbar
// that turns clicks into numbered comments and one Send that turns the comments into a user turn.
//
// Why a dashboard page around an iframe rather than a toolbar injected into the app: the app reloads
// constantly (HMR, navigation, Claude's fix landing), and anything living inside it dies with each
// reload. Pins, notes, the armed tool and the bound session all live HERE; the app only ever hosts a
// broadcaster (public/inspect-core.js) that reports what's under the cursor and re-anchors the pins
// after every load. `lib/preview-comments.ts` is the typed protocol between the two.
//
// Like app/browser/[id], this window attaches its OWN EventSource to the bound session — two windows
// on one session is a supported case (Session.subs is a Set) — and, unlike it, it SENDS. That is the
// whole point: the pane never has to be touched for a round of feedback.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, MousePointerClick, BoxSelect, StickyNote, MoveRight, AlertTriangle, Send, X, Trash2, ChevronDown, Loader2, Link2Off } from "lucide-react";
import { useAgent, type AgentMode } from "@/lib/use-agent";
import { useSetting } from "@/lib/use-settings";
import {
  TAG, INTENTS, composeMessage, composeErrorsOnly, circled, installSnippet, isPreviewUrl,
  type Pin, type Intent, type ScriptMsg, type WrapperMsg, type AppError, type ElementInfo,
} from "@/lib/preview-comments";

type Tool = "pin" | "rect" | "move" | "page" | null;
type LiveSession = { phase: string; label: string; busy: boolean; cwd: string };

const uid = () => Math.random().toString(36).slice(2, 10);
const basename = (p: string) => p.split("/").filter(Boolean).pop() || p;

export default function PreviewPopOut() {
  const params = useParams<{ session: string }>();
  const search = useSearchParams();
  const initialSession = params?.session && params.session !== "new" ? params.session : "";
  const [sessionId, setSessionId] = useState(initialSession);
  const [cwd, setCwd] = useState(search.get("cwd") || "");
  // The URL the iframe was opened with. Navigation inside the app never changes this — `appUrl`
  // (from the script's `hello`) is what the message and the address bar show.
  const [src, setSrc] = useState(() => {
    const u = search.get("url") || "";
    return isPreviewUrl(u) ? u : "";
  });
  const [srcDraft, setSrcDraft] = useState(src);
  const [appUrl, setAppUrl] = useState(src);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  // `hooked` = the script inside the app said hello for the CURRENT load (see onFrameLoad), so a page
  // that dropped the script — or a production build — shows Enable comments again.
  const [hooked, setHooked] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [tool, setTool] = useState<Tool>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [errors, setErrors] = useState<AppError[]>([]);
  const [hover, setHover] = useState<ElementInfo | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // pin id whose note popover is open
  const [moveFrom, setMoveFrom] = useState<ElementInfo | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [verify, setVerify] = useState(true);
  const [switcher, setSwitcher] = useState(false);
  const [liveSessions, setLiveSessions] = useState<Record<string, LiveSession>>({});
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  // When the script last said hello. The handshake has two races, in opposite directions: the
  // script's hello fires at parse time, BEFORE the iframe's `load` — and on a fresh navigation the
  // iframe (in the SSR HTML) is already loading before React has hydrated this listener at all, so
  // that first hello can land with nobody listening. So the wrapper never waits to be greeted: it
  // probes (connect + ping) both when it mounts and on every frame load, and judges presence by
  // whether a hello comes back within the grace period. `connect` is idempotent in the script.
  const helloAt = useRef(0);
  const probe = () => {
    const t = Date.now();
    postRef.current({ tag: TAG, t: "connect" });
    postRef.current({ tag: TAG, t: "ping" });
    setTimeout(() => setHooked(helloAt.current >= t), 1500);
  };
  const onFrameLoad = () => { setLoadedOnce(true); probe(); };

  const agent = useAgent(sessionId ? "live:" + sessionId : "preview-popout");
  // Same keys the pane uses (§5e), so the pop-out sends with the pane's own permission mode and
  // model rather than a guess — and the switch flips both if the binding is changed.
  const [permDefault] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [perm] = useSetting<Exclude<AgentMode, "plan">>("permMode:live:" + sessionId, permDefault);
  const [modelDefault] = useSetting<string | null>("chatModel", null);
  const [model] = useSetting<string | null>("chatModel:live:" + sessionId, modelDefault);

  // Attach once per binding. Re-binding (the switcher) changes the hook's key, which tears the old
  // stream down; the new one needs its own attach.
  const attachedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || attachedFor.current === sessionId) return;
    attachedFor.current = sessionId;
    agent.attach(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const appOrigin = useMemo(() => { try { return new URL(src).origin; } catch { return ""; } }, [src]);

  // ── channel ────────────────────────────────────────────────────────────────────────────────────
  const post = useCallback((m: WrapperMsg) => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !appOrigin) return;
    try { win.postMessage(m, appOrigin); } catch { /* frame mid-navigation */ }
  }, [appOrigin]);
  const postRef = useRef(post);
  postRef.current = post;

  // Markers live inside the app so they scroll with it; the wrapper is their source of truth.
  const pushMarkers = useCallback((list: Pin[]) => {
    post({ tag: TAG, t: "markers", markers: list.filter((p) => p.kind !== "page").map((p) => ({ n: p.n, selector: p.el?.selector || null, box: p.box, state: p.state })) });
  }, [post]);
  useEffect(() => { if (hooked) pushMarkers(pins); }, [pins, hooked, pushMarkers]);

  const anchor = useCallback(() => {
    const sels = pinsRef.current.filter((p) => p.kind === "pin" || p.kind === "move").map((p) => p.el!.selector);
    if (sels.length) post({ tag: TAG, t: "anchor", selectors: sels });
  }, [post]);

  const probedRef = useRef(false);
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as ScriptMsg;
      if (!d || d.tag !== TAG) return;
      // Only the frame we opened. A second embedded frame (an iframe inside the app that happens to
      // include the script) would otherwise report its own, unrelated elements.
      if (ev.source !== iframeRef.current?.contentWindow) return;
      switch (d.t) {
        case "hello":
          helloAt.current = Date.now();
          setHooked(true); setAppUrl(d.url); setViewport(d.viewport);
          post({ tag: TAG, t: "connect" });
          // Re-arm whatever was armed and re-anchor: this is the reload path (Q7).
          if (tool === "pin" || tool === "move") post({ tag: TAG, t: "arm", tool: "pin" });
          else if (tool === "rect") post({ tag: TAG, t: "arm", tool: "rect" });
          setTimeout(() => { anchor(); pushMarkers(pinsRef.current); }, 50);
          break;
        case "hover": setHover(d.el); break;
        case "picked": {
          if (tool === "move") {
            if (!moveFrom) { setMoveFrom(d.el); break; }
            const n = nextN(pinsRef.current);
            const pin: Pin = { id: uid(), n, kind: "move", note: "", intent: "Move", el: moveFrom, to: d.el, box: moveFrom.box, cropData: d.crop, state: "open", url: appUrl };
            setPins((prev) => [...prev, pin]); setMoveFrom(null); setEditing(pin.id); setTool(null);
            break;
          }
          // One pick, one pin, then the tool drops: the note editor takes focus next, and a crosshair
          // left armed turns the very next click on the page — to scroll, to focus — into a stray pin.
          const n = nextN(pinsRef.current);
          const pin: Pin = { id: uid(), n, kind: "pin", note: "", intent: null, el: d.el, box: d.el.box, cropData: d.crop, state: "open", url: appUrl };
          setPins((prev) => [...prev, pin]); setEditing(pin.id); setTool(null);
          break;
        }
        case "region": {
          const n = nextN(pinsRef.current);
          const pin: Pin = { id: uid(), n, kind: "rect", note: "", intent: null, region: { box: d.box, els: d.els }, box: d.box, cropData: d.crop, state: "open", url: appUrl };
          setPins((prev) => [...prev, pin]); setEditing(pin.id); setTool(null);
          break;
        }
        case "anchored":
          setPins((prev) => prev.map((p) => (p.el && p.el.selector in d.boxes ? { ...p, box: d.boxes[p.el.selector] } : p)));
          break;
        case "errors": setErrors(d.errors); break;
        case "key": hotkey(d.key); break;
        case "viewport":
          setViewport(d.size);
          // Boxes are viewport coordinates, so a scroll moves every pin; ask for fresh ones. The
          // script throttles `viewport` to animation frames, so this is one message per frame at
          // worst, and the reply is a handful of getBoundingClientRect calls.
          anchor();
          break;
      }
    };
    window.addEventListener("message", onMsg);
    // First time the listener exists, ask — the frame may have greeted an empty room already.
    if (!probedRef.current && iframeRef.current) { probedRef.current = true; probe(); }
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post, anchor, pushMarkers, tool, moveFrom, appUrl]);

  // Arm/disarm follows the tool. `move` and `pin` are the same thing to the script: pick an element.
  useEffect(() => {
    if (!hooked) return;
    post({ tag: TAG, t: "arm", tool: tool === "pin" || tool === "move" ? "pin" : tool === "rect" ? "rect" : null });
    if (tool !== "move") setMoveFrom(null);
    if (tool !== "pin" && tool !== "rect" && tool !== "move") setHover(null);
  }, [tool, hooked, post]);

  // A whole-page note needs no element: creating it opens its note straight away.
  useEffect(() => {
    if (tool !== "page") return;
    const n = nextN(pinsRef.current);
    const pin: Pin = { id: uid(), n, kind: "page", note: "", intent: null, box: null, state: "open", url: appUrl };
    setPins((prev) => [...prev, pin]); setEditing(pin.id); setTool(null);
  }, [tool, appUrl]);

  // Hotkeys. One handler for both sources: keys pressed here, and keys the script forwards when the
  // iframe has focus (which it does after any click in the app — without the relay, P would silently
  // stop working the moment you used the page).
  const hotkey = useCallback((key: string) => {
    if (key === "Escape") { setTool(null); setEditing(null); setSwitcher(false); return; }
    if (key === "Send") { void sendAllRef.current(); return; }
    if (key === "p") setTool((v) => (v === "pin" ? null : "pin"));
    else if (key === "r") setTool((v) => (v === "rect" ? null : "rect"));
    else if (key === "m") setTool((v) => (v === "move" ? null : "move"));
    else if (key === "n") setTool("page");
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      if (e.key === "Escape") { hotkey("Escape"); return; }
      if (typing) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); hotkey("Send"); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      hotkey(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);

  // ── sending ────────────────────────────────────────────────────────────────────────────────────
  const awaitingReply = useRef(false);
  const open = pins.filter((p) => p.state === "open");

  const uploadCrop = async (dataUrl: string): Promise<string | null> => {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const r = await fetch("/api/fs/paste", { method: "POST", headers: { "content-type": blob.type || "image/png" }, body: blob });
      const d = await r.json();
      return typeof d?.path === "string" ? d.path : null;
    } catch { return null; }
  };

  const deliver = async (text: string) => {
    if (!sessionId || !cwd) { setSendError("This window isn't bound to a chat — pick one from the status bar."); return false; }
    setSendError(null);
    if (agent.busy) await agent.queueMessage(text, { cwd, mode: perm });
    else await agent.send(text, { cwd, mode: perm, resume: sessionId, model });
    return true;
  };

  const sendAll = async () => {
    const batch = pinsRef.current.filter((p) => p.state === "open");
    if (!batch.length || sending) return;
    setSending(true); setEditing(null); setTool(null);
    try {
      // Upload crops first so the message can name the paths (§11: the path is the payload).
      const withPaths = await Promise.all(batch.map(async (p) => ({ ...p, cropPath: p.cropData ? await uploadCrop(p.cropData) : null })));
      const text = composeMessage(withPaths, { url: appUrl || src, viewport }, errors, { verify });
      if (!(await deliver(text))) return;
      awaitingReply.current = true;
      const ids = new Set(batch.map((p) => p.id));
      setPins((prev) => prev.map((p) => (ids.has(p.id) ? { ...p, state: "sent", cropPath: withPaths.find((w) => w.id === p.id)?.cropPath ?? null, cropData: null } : p)));
      setErrors([]); post({ tag: TAG, t: "clearErrors" });
    } finally { setSending(false); }
  };
  // The hotkey listener is installed once; this ref is how it reaches the current closure.
  const sendAllRef = useRef(sendAll);
  sendAllRef.current = sendAll;

  const sendErrorsOnly = async () => {
    if (!errors.length || sending) return;
    setSending(true);
    try {
      if (!(await deliver(composeErrorsOnly({ url: appUrl || src, viewport }, errors)))) return;
      setErrors([]); post({ tag: TAG, t: "clearErrors" });
    } finally { setSending(false); }
  };

  // Q8: sent pins go grey while the turn runs and fade when it ends, so the next reload shows the
  // clean result. Only a turn WE started clears them — a turn the pane started is not an answer.
  useEffect(() => {
    if (agent.busy || !awaitingReply.current) return;
    awaitingReply.current = false;
    const t = setTimeout(() => setPins((prev) => prev.filter((p) => p.state !== "sent")), 1500);
    return () => clearTimeout(t);
  }, [agent.busy]);

  // Enable-comments (Q14): one click sends the bound session a precise instruction.
  const enableComments = async () => {
    const origin = window.location.origin;
    const next = installSnippet(origin, "next");
    const html = installSnippet(origin, "html");
    const text = [
      `[Preview setup] I'm previewing ${src} from the Minami dashboard and want to comment on it directly. Include the dashboard's inspect script in this app, development only.`,
      "",
      `If it's a Next.js app, add this inside <body> in the root layout (app/layout.tsx or pages/_app.tsx):`,
      `  ${next}`,
      `If it's plain HTML/Astro/Vite, add this before </body> in the template:`,
      `  ${html}`,
      "",
      "Don't add it to production builds. Tell me when it's in; I'll reload the preview.",
    ].join("\n");
    await deliver(text);
  };

  // ── status bar ─────────────────────────────────────────────────────────────────────────────────
  const lastReply = useMemo(() => {
    for (let i = agent.turns.length - 1; i >= 0; i--) {
      const t = agent.turns[i];
      if (t.role !== "assistant" || t.streaming || !t.text.trim()) continue;
      const line = t.text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("```") && !l.startsWith("#"));
      return (line || "").replace(/[*_`]/g, "").slice(0, 160);
    }
    return "";
  }, [agent.turns]);

  useEffect(() => {
    if (!switcher) return;
    let alive = true;
    const load = () => fetch("/api/agent/live").then((r) => r.json()).then((d) => { if (alive && d?.activity) setLiveSessions(d.activity); }).catch(() => {});
    load();
    const iv = setInterval(load, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [switcher]);

  const rebind = (id: string, c: string) => {
    attachedFor.current = null;
    setSessionId(id); setCwd(c); setSwitcher(false);
    const u = new URL(window.location.href);
    u.pathname = `/preview/${id}`; u.searchParams.set("cwd", c);
    window.history.replaceState(null, "", u.toString());
  };

  useEffect(() => { document.title = `${open.length ? `(${open.length}) ` : ""}${appUrl || "Preview"} — Minami`; }, [open.length, appUrl]);

  const go = (u: string) => {
    const clean = u.trim().replace(/^(?!https?:\/\/)/, "http://");
    if (!isPreviewUrl(clean)) { setSendError("Only localhost URLs can be previewed here."); return; }
    setSendError(null); setSrc(clean); setSrcDraft(clean); setAppUrl(clean); setHooked(false); setIframeKey((k) => k + 1);
  };
  // Back/forward/reload reach the frame through its history — a cross-origin frame's history is
  // still ours to navigate, just not to read.
  const nav = (dir: -1 | 0 | 1) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try { if (dir === 0) win.location.reload(); else win.history.go(dir); }
    catch { if (dir === 0) setIframeKey((k) => k + 1); }
  };

  const editingPin = editing ? pins.find((p) => p.id === editing) || null : null;
  const boundName = cwd ? basename(cwd) : sessionId ? sessionId.slice(0, 8) : "no chat";
  const busyLabel = agent.busy ? agent.activity.label : "";

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      {/* ── toolbar ── */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 bg-neutral-900/80 px-2 text-[12px]">
        <IconBtn title="Back" onClick={() => nav(-1)}><ArrowLeft size={14} /></IconBtn>
        <IconBtn title="Forward" onClick={() => nav(1)}><ArrowRight size={14} /></IconBtn>
        <IconBtn title="Reload" onClick={() => nav(0)}><RotateCw size={14} /></IconBtn>
        <form className="mx-1 flex min-w-0 flex-1 items-center" onSubmit={(e) => { e.preventDefault(); go(srcDraft); }}>
          <input
            value={srcDraft} onChange={(e) => setSrcDraft(e.target.value)} onFocus={(e) => e.target.select()}
            placeholder="http://localhost:3001/…" spellCheck={false}
            className="h-7 w-full min-w-0 rounded-md border border-white/10 bg-black/40 px-2 font-mono text-[11.5px] text-neutral-200 outline-none focus:border-[var(--sakura)]/60"
          />
        </form>
        {src && <IconBtn title="Open in your browser" onClick={() => window.open(appUrl || src, "_blank", "noopener")}><ExternalLink size={14} /></IconBtn>}
        <span className="mx-1 h-5 w-px bg-white/10" />
        <ToolBtn active={tool === "pin"} disabled={!hooked} title="Pin an element (P)" onClick={() => setTool(tool === "pin" ? null : "pin")}><MousePointerClick size={14} /> Pin</ToolBtn>
        <ToolBtn active={tool === "rect"} disabled={!hooked} title="Drag a region (R)" onClick={() => setTool(tool === "rect" ? null : "rect")}><BoxSelect size={14} /> Rect</ToolBtn>
        <ToolBtn active={tool === "move"} disabled={!hooked} title="Move this → here (M)" onClick={() => setTool(tool === "move" ? null : "move")}><MoveRight size={14} /> Move</ToolBtn>
        <ToolBtn active={false} title="Whole-page note (N)" onClick={() => setTool("page")}><StickyNote size={14} /> Note</ToolBtn>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <button
          type="button" onClick={sendErrorsOnly} disabled={!errors.length || sending}
          title={errors.length ? `${errors.length} error(s) since last send — click to send them alone` : "No errors since last send"}
          className={`flex h-7 items-center gap-1 rounded-md px-2 ${errors.length ? "bg-red-500/20 text-red-300 hover:bg-red-500/30" : "text-neutral-600"}`}
        ><AlertTriangle size={13} /> {errors.length}</button>
        <label className="ml-1 flex items-center gap-1 text-[11px] text-neutral-500" title="Ask Claude to re-screenshot each pinned selector after the fix">
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} className="accent-[var(--sakura)]" /> verify
        </label>
        <button
          type="button" onClick={sendAll} disabled={!open.length || sending || !sessionId}
          title="Send all open comments as one message (⌘↩)"
          className="ml-1 flex h-7 items-center gap-1.5 rounded-md bg-[var(--sakura)] px-3 font-medium text-black disabled:opacity-40"
        >{sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send {open.length ? open.length : ""}</button>
      </div>

      {/* ── stage ── */}
      <div className="relative min-h-0 flex-1 bg-neutral-900">
        {src ? (
          <iframe
            key={iframeKey} ref={iframeRef} src={src} title="preview"
            className="h-full w-full border-0 bg-white"
            onLoad={onFrameLoad}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-neutral-500">Enter a localhost URL above.</div>
        )}

        {/* the script isn't in the page → the one-click setup (Q14) */}
        {src && loadedOnce && !hooked && (
          <NotHooked onEnable={enableComments} canSend={!!sessionId && !!cwd} snippet={typeof window !== "undefined" ? installSnippet(window.location.origin, "next") : ""} />
        )}

        {/* hover readout while a tool is armed */}
        {hover && (tool === "pin" || tool === "move") && (
          <div className="pointer-events-none absolute left-2 top-2 max-w-[60%] truncate rounded-md border border-white/10 bg-black/80 px-2 py-1 font-mono text-[11px] text-neutral-300">
            {tool === "move" && moveFrom ? "→ destination: " : ""}{hover.components.length ? hover.components.join(" > ") : `<${hover.tag}>`} <span className="text-neutral-500">{hover.selector}</span>
          </div>
        )}
        {tool === "move" && moveFrom && (
          <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-[var(--sakura)]/40 bg-black/80 px-2 py-1 text-[11px] text-neutral-300">
            moving <span className="font-mono">{moveFrom.components.at(-1) || `<${moveFrom.tag}>`}</span> — click where it should go
          </div>
        )}

        {/* note popover, anchored to the pin's box when it has one */}
        {editingPin && (
          <NoteEditor
            pin={editingPin}
            onChange={(patch) => setPins((prev) => prev.map((p) => (p.id === editingPin.id ? { ...p, ...patch } : p)))}
            onDelete={() => { setPins((prev) => prev.filter((p) => p.id !== editingPin.id)); setEditing(null); }}
            onClose={() => setEditing(null)}
          />
        )}

        {/* the pin list — a tray on the right so a long batch stays reviewable */}
        {pins.length > 0 && !editingPin && (
          <div className="absolute bottom-2 right-2 flex max-h-[60%] w-72 flex-col gap-1 overflow-auto rounded-lg border border-white/10 bg-black/85 p-1.5 text-[11.5px] backdrop-blur">
            {pins.map((p) => (
              <button key={p.id} type="button" onClick={() => p.state === "open" && setEditing(p.id)}
                className={`flex items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/5 ${p.state === "sent" ? "opacity-50" : ""}`}>
                <span className="text-[var(--sakura)]">{circled(p.n)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-neutral-200">{p.intent ? <span className="text-neutral-400">{p.intent} — </span> : null}{p.note || <span className="italic text-neutral-500">no note</span>}</span>
                  <span className="block truncate font-mono text-[10.5px] text-neutral-500">{pinLabel(p)}</span>
                </span>
                {p.cropData && <img src={p.cropData} alt="" className="h-8 w-8 rounded object-cover" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── status bar ── */}
      <div className="relative flex h-8 shrink-0 items-center gap-2 border-t border-white/10 bg-neutral-900/80 px-2 text-[11.5px]">
        <button type="button" onClick={() => setSwitcher((v) => !v)} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-white/5" title="Bound chat — click to change">
          <span className={`h-2 w-2 rounded-full ${!sessionId ? "bg-neutral-600" : agent.detached ? "bg-amber-400" : agent.busy ? "bg-[var(--sakura)] animate-pulse" : "bg-emerald-400"}`} />
          <span className="font-medium text-neutral-200">{boundName}</span>
          <ChevronDown size={12} className="text-neutral-500" />
        </button>
        <span className="min-w-0 flex-1 truncate text-neutral-400">
          {sendError ? <span className="text-red-300">{sendError}</span>
            : agent.error ? <span className="text-red-300">{agent.error}</span>
            : busyLabel ? <>Claude {busyLabel}{agent.turnElapsed > 0 ? <span className="text-neutral-600"> · {Math.round(agent.turnElapsed / 1000)}s</span> : null}</>
            : agent.detached ? <span className="flex items-center gap-1"><Link2Off size={11} /> not live — the next send resumes it</span>
            : lastReply ? <>Done — {lastReply}</>
            : hooked ? "Ready — P to pin, R for a region, N for a page note" : ""}
        </span>
        {agent.queued.length > 0 && <span className="text-neutral-500">{agent.queued.length} queued</span>}
        <button type="button" onClick={() => { if (window.opener && !window.opener.closed) window.opener.focus(); else window.open("/", "_blank"); }} className="text-neutral-500 hover:text-neutral-200">open pane →</button>

        {switcher && (
          <div className="absolute bottom-9 left-2 z-10 w-80 rounded-lg border border-white/10 bg-neutral-900 p-1 shadow-xl">
            <div className="px-2 py-1 text-[10.5px] uppercase tracking-wide text-neutral-500">Live chats</div>
            {Object.entries(liveSessions).length === 0 && <div className="px-2 py-1 text-neutral-500">none running</div>}
            {Object.entries(liveSessions).map(([id, s]) => (
              <button key={id} type="button" onClick={() => rebind(id, s.cwd)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-white/5 ${id === sessionId ? "text-[var(--sakura)]" : "text-neutral-200"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${s.busy ? "bg-[var(--sakura)]" : "bg-emerald-400"}`} />
                <span className="flex-1 truncate">{basename(s.cwd)}</span>
                <span className="truncate text-[10.5px] text-neutral-500">{s.busy ? s.label : "idle"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function nextN(list: Pin[]): number { return list.reduce((m, p) => Math.max(m, p.n), 0) + 1; }

function pinLabel(p: Pin): string {
  if (p.kind === "page") return "whole page";
  if (p.kind === "rect" && p.region) return `region ${Math.round(p.region.box.w)}×${Math.round(p.region.box.h)} · ${p.region.els.length} elements`;
  if (p.kind === "move" && p.el && p.to) return `${p.el.components.at(-1) || p.el.tag} → ${p.to.components.at(-1) || p.to.tag}`;
  if (p.el) return p.el.components.length ? p.el.components.join(" > ") : p.el.selector;
  return "";
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={title} onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-white/5 hover:text-neutral-100">{children}</button>;
}

function ToolBtn({ active, disabled, title, onClick, children }: { active: boolean; disabled?: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={disabled ? "Enable comments first (the app isn't reporting)" : title} onClick={onClick} disabled={disabled}
      className={`flex h-7 items-center gap-1 rounded-md px-2 disabled:opacity-40 ${active ? "bg-[var(--sakura)]/20 text-[var(--sakura)]" : "text-neutral-300 hover:bg-white/5"}`}>
      {children}
    </button>
  );
}

function NoteEditor({ pin, onChange, onDelete, onClose }: { pin: Pin; onChange: (patch: Partial<Pin>) => void; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, [pin.id]);
  // Anchored beside the element when we know where it is; otherwise centred at the top. The stage is
  // the iframe's parent, and boxes are viewport coordinates inside the iframe, which start at the
  // stage's top-left — so a pin's box IS its position here, offset just enough not to cover it.
  const style: React.CSSProperties = pin.box
    ? { left: Math.max(8, Math.min(pin.box.x + pin.box.w + 12, (typeof window !== "undefined" ? window.innerWidth : 1200) - 340)), top: Math.max(8, pin.box.y) }
    : { left: "50%", top: 12, transform: "translateX(-50%)" };
  return (
    <div style={style} className="absolute z-20 w-80 rounded-lg border border-white/10 bg-neutral-900 p-2 text-[12px] shadow-2xl">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[var(--sakura)]">{circled(pin.n)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-neutral-500">{pinLabel(pin)}</span>
        <button type="button" onClick={onDelete} title="Delete this comment" className="text-neutral-500 hover:text-red-300"><Trash2 size={13} /></button>
        <button type="button" onClick={onClose} title="Done (Esc)" className="text-neutral-500 hover:text-neutral-200"><X size={13} /></button>
      </div>
      <div className="mb-1.5 flex flex-wrap gap-1">
        {INTENTS.map((i: Intent) => (
          // preventDefault on mousedown keeps focus in the textarea: a focused chip would otherwise
          // receive the Enter meant for "keep" and toggle itself straight back off.
          <button key={i} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange({ intent: pin.intent === i ? null : i })}
            className={`rounded-full border px-2 py-0.5 text-[10.5px] ${pin.intent === i ? "border-[var(--sakura)]/60 bg-[var(--sakura)]/15 text-[var(--sakura)]" : "border-white/10 text-neutral-400 hover:border-white/30"}`}>{i}</button>
        ))}
      </div>
      <textarea
        ref={ref} value={pin.note} onChange={(e) => onChange({ note: e.target.value })}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onClose(); } }}
        placeholder={pin.kind === "move" ? "why / how it should move (optional)" : "what should change here?"}
        rows={2} className="w-full resize-none rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[12px] text-neutral-100 outline-none focus:border-[var(--sakura)]/60"
      />
      {pin.cropData && <img src={pin.cropData} alt="" className="mt-1.5 max-h-28 w-full rounded border border-white/10 object-contain" />}
      <div className="mt-1 text-[10.5px] text-neutral-600">Enter to keep · Esc to close · pins stay until you Send</div>
    </div>
  );
}

function NotHooked({ onEnable, canSend, snippet }: { onEnable: () => Promise<void>; canSend: boolean; snippet: string }) {
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
      <div className="pointer-events-auto flex max-w-[640px] items-center gap-3 rounded-lg border border-amber-400/30 bg-neutral-900/95 px-3 py-2 text-[12px] shadow-xl">
        <span className="text-neutral-300">This page isn&apos;t reporting to the dashboard, so nothing can be pinned yet.</span>
        {asked ? <span className="text-neutral-500">asked — reload once Claude says it&apos;s in</span> : (
          <button type="button" disabled={!canSend || busy} onClick={async () => { setBusy(true); try { await onEnable(); setAsked(true); } finally { setBusy(false); } }}
            className="shrink-0 rounded-md bg-amber-400/90 px-2.5 py-1 font-medium text-black disabled:opacity-40" title={canSend ? "Ask the bound chat to add the one-line dev script" : "Bind a chat first"}>
            {busy ? "asking…" : "Enable comments"}
          </button>
        )}
        <button type="button" onClick={() => navigator.clipboard?.writeText(snippet)} className="shrink-0 text-neutral-500 hover:text-neutral-200" title={snippet}>copy snippet</button>
      </div>
    </div>
  );
}
