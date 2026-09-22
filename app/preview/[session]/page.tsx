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
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, MousePointerClick, MousePointer2, BoxSelect, StickyNote, MoveRight, AlertTriangle, Send, Check, Trash2, ChevronDown, Loader2, Link2Off } from "lucide-react";
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
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  // `hooked` = the script inside the app said hello for the CURRENT load (see onFrameLoad), so a page
  // that dropped the script — or a production build — shows Enable comments again.
  const [hooked, setHooked] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  // Comment mode by default (Q-followup, 2026-09-21): the window exists to comment, so clicking an
  // element should just work. Browse (`null`) is the mode you opt into — Esc — to use the app.
  const [tool, setTool] = useState<Tool>("pin");
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
  // The iframe's box in wrapper coordinates — what the note editor clamps against. Measured, not
  // derived from window.innerHeight minus assumed chrome heights.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 1200, h: 700 });
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const moveFromRef = useRef(moveFrom);
  moveFromRef.current = moveFrom;
  const toolRef = useRef<Tool>("pin");
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

  // The origin we post to must track where the app actually IS, not where it started. An in-app
  // navigation to another port/host (an auth redirect, a link to another local service) left
  // `postMessage` targeting a stale origin — and a mismatched targetOrigin fails SILENTLY, so the
  // toolbar stayed enabled over a page that could no longer hear a word. `hello` carries the real
  // URL, so it is the authority; `src` only seeds it.
  const appOrigin = useMemo(() => {
    for (const u of [appUrl, src]) { try { if (u) return new URL(u).origin; } catch { /* keep looking */ } }
    return "";
  }, [appUrl, src]);

  // ── channel ────────────────────────────────────────────────────────────────────────────────────
  const post = useCallback((m: WrapperMsg) => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !appOrigin) return;
    try { win.postMessage(m, appOrigin); } catch { /* frame mid-navigation */ }
  }, [appOrigin]);
  const postRef = useRef(post);
  postRef.current = post;

  // Markers live inside the app so they scroll with it; the wrapper is their source of truth.
  //
  // > 🐛 The push used to key on the whole `pins` array, which changes identity on every keystroke
  // in a note, every late crop, and every `anchored` reply — i.e. ~60×/s while scrolling. Each push
  // tears down and rebuilds every badge inside the app, so badges flickered under the cursor and a
  // click on one could land on a node that had just been replaced. Only the four fields the script
  // actually draws are compared now, and the box is rounded: sub-pixel scroll deltas are not news.
  const markerPayload = useMemo(
    () => pins.filter((p) => p.kind !== "page").map((p) => ({ n: p.n, selector: p.el?.selector || null, box: p.box ? { x: Math.round(p.box.x), y: Math.round(p.box.y), w: Math.round(p.box.w), h: Math.round(p.box.h) } : null, state: p.state })),
    [pins],
  );
  const markerKey = JSON.stringify(markerPayload);
  const pushMarkers = useCallback((list: Pin[]) => {
    post({ tag: TAG, t: "markers", markers: list.filter((p) => p.kind !== "page").map((p) => ({ n: p.n, selector: p.el?.selector || null, box: p.box, state: p.state })) });
  }, [post]);
  useEffect(() => {
    if (!hooked) return;
    post({ tag: TAG, t: "markers", markers: markerPayload });
    // markerPayload is rebuilt every render; markerKey is its VALUE, which is the actual trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerKey, hooked, post]);

  const anchor = useCallback(() => {
    const sels = pinsRef.current.filter((p) => p.kind === "pin" || p.kind === "move").map((p) => p.el!.selector);
    if (sels.length) post({ tag: TAG, t: "anchor", selectors: sels });
  }, [post]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStage({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // > 🐛 v1 called `win.history.go()` and `win.location.reload()` on the framed window, on the
  // belief that a cross-origin frame's history is still ours to drive. It is not — `history` is not
  // on the cross-origin Window allow-list and `Location` exposes only `href`/`replace`. Both threw,
  // so Back and Forward were dead buttons, and Reload fell into the catch and remounted the iframe
  // at its ORIGINAL url, silently throwing away wherever you had navigated to (and orphaning every
  // pin anchored on that page).
  //
  // The script reports each URL it lands on (`hello`), so the wrapper keeps its OWN history of the
  // app's pages and navigates by setting `src`. That is a real back/forward over the pages the
  // preview has actually seen, and a reload that reloads what is on screen.
  const history = useRef<string[]>([]);
  const histAt = useRef(-1);
  const navigating = useRef(false);
  const [histState, setHistState] = useState({ back: false, fwd: false });
  const recordVisit = useCallback((url: string) => {
    if (navigating.current) { navigating.current = false; setHistState({ back: histAt.current > 0, fwd: histAt.current < history.current.length - 1 }); return; }
    const h = history.current;
    if (h[histAt.current] === url) return;
    h.splice(histAt.current + 1);   // a new page truncates the forward branch, like a browser
    h.push(url);
    histAt.current = h.length - 1;
    setHistState({ back: histAt.current > 0, fwd: false });
  }, []);

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
          setHooked(true); setAppUrl(d.url); setSrcDraft(d.url); setViewport(d.viewport);
          viewportRef.current = d.viewport;
          recordVisit(d.url);
          post({ tag: TAG, t: "connect" });
          // Re-arm whatever was armed and re-anchor: this is the reload path (Q7).
          if (tool === "pin" || tool === "move") post({ tag: TAG, t: "arm", tool: "pin" });
          else if (tool === "rect") post({ tag: TAG, t: "arm", tool: "rect" });
          setTimeout(() => { anchor(); pushMarkers(pinsRef.current); }, 50);
          break;
        case "hover": setHover(d.el); break;
        case "picked": {
          if (tool === "move") {
            // The ref, not the closure: two picks inside one React commit both read `moveFrom` as
            // null and the second one silently replaced the source instead of completing the move.
            const from = moveFromRef.current;
            if (!from) { moveFromRef.current = d.el; setMoveFrom(d.el); break; }
            const base = closeEditor();
            const n = nextN(base);
            const pin: Pin = { id: uid(), n, kind: "move", note: "", intent: "Move", el: from, to: d.el, box: from.box, cropData: d.crop, reqId: d.reqId, state: "open", url: appUrl };
            moveFromRef.current = null;
            setPins([...base, pin]); setMoveFrom(null); setEditing(pin.id); setTool("pin");
            break;
          }
          // Comment mode stays on after a pick — one click per comment is the whole point. The
          // stray-pin problem that used to disarm it is handled by closeEditor(): a click while a
          // note is open closes it, and an untouched note is dropped rather than left as a blank pin.
          const base = closeEditor();
          const n = nextN(base);
          const pin: Pin = { id: uid(), n, kind: "pin", note: "", intent: null, el: d.el, box: d.el.box, cropData: d.crop, reqId: d.reqId, state: "open", url: appUrl };
          setPins([...base, pin]); setEditing(pin.id);
          break;
        }
        case "region": {
          const base = closeEditor();
          const n = nextN(base);
          const pin: Pin = { id: uid(), n, kind: "rect", note: "", intent: null, region: { box: d.box, els: d.els }, box: d.box, cropData: d.crop, reqId: d.reqId, state: "open", url: appUrl };
          setPins([...base, pin]); setEditing(pin.id); setTool("pin");
          break;
        }
        case "cropped":
          // The picture, arriving after its pin. Matched on reqId so a slow render can never attach
          // itself to whatever pin happens to be open when it lands.
          setPins((prev) => prev.map((p) => (p.reqId === d.reqId && !p.cropData ? { ...p, cropData: d.crop } : p)));
          break;
        case "marker": {
          const hit = pinsRef.current.find((p) => p.n === d.n && p.state === "open");
          if (hit) { closeEditor(); setEditing(hit.id); }
          break;
        }
        case "anchored":
          setPins((prev) => prev.map((p) => (p.el && p.el.selector in d.boxes ? { ...p, box: d.boxes[p.el.selector] } : p)));
          break;
        case "errors": setErrors(d.errors); break;
        case "key": hotkey(d.key); break;
        case "viewport":
          // Size is only read when a batch is composed, so a state write per scroll frame was a
          // whole-component re-render for a value nobody was looking at. Kept in a ref; the state
          // copy is updated only when the size actually changes (a resize, not a scroll).
          viewportRef.current = d.size;
          setViewport((v) => (v.w === d.size.w && v.h === d.size.h ? v : d.size));
          // Boxes are viewport coordinates, so a scroll moves every pin; ask for fresh ones.
          anchor();
          break;
      }
    };
    window.addEventListener("message", onMsg);
    // First time the listener exists, ask — the frame may have greeted an empty room already.
    if (!probedRef.current && iframeRef.current) { probedRef.current = true; probe(); }
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post, anchor, pushMarkers, tool, moveFrom, appUrl, recordVisit]);

  // Close whatever note is open. An untouched one (no text, no chip) is deleted — it was a click,
  // not a comment. Returns the resulting list so a caller can build on it in the same tick, because
  // this runs from inside message handlers where `pins` state is a render behind.
  const closeEditor = useCallback((): Pin[] => {
    const id = editingRef.current;
    let list = pinsRef.current;
    if (id) {
      const cur = list.find((p) => p.id === id);
      if (cur && !cur.note.trim() && !cur.intent && cur.kind !== "move") list = list.filter((p) => p.id !== id);
      setPins(list); setEditing(null);
    }
    return list;
  }, []);

  // Re-send the current arm state. Needed wherever the SCRIPT may have disarmed itself (Escape
  // inside the app) while the wrapper keeps the tool — the arm effect only fires on a tool CHANGE.
  const reArm = useCallback(() => {
    const t = toolRef.current;
    postRef.current({ tag: TAG, t: "arm", tool: t === "pin" || t === "move" ? "pin" : t === "rect" ? "rect" : null });
  }, []);

  // Arm/disarm follows the tool. `move` and `pin` are the same thing to the script: pick an element.
  // Not gated on `hooked`: a disarm that waits for a handshake can leave the crosshair stuck over the
  // app; posting into a frame that isn't listening costs nothing.
  useEffect(() => {
    toolRef.current = tool;
    post({ tag: TAG, t: "arm", tool: tool === "pin" || tool === "move" ? "pin" : tool === "rect" ? "rect" : null });
    if (tool !== "move") setMoveFrom(null);
    if (tool !== "pin" && tool !== "rect" && tool !== "move") setHover(null);
  }, [tool, post]);

  // A whole-page note needs no element: creating it opens its note straight away.
  useEffect(() => {
    if (tool !== "page") return;
    const n = nextN(pinsRef.current);
    const pin: Pin = { id: uid(), n, kind: "page", note: "", intent: null, box: null, state: "open", url: appUrl };
    setPins((prev) => [...prev, pin]); setEditing(pin.id); setTool("pin");
  }, [tool, appUrl]);

  // Hotkeys. One handler for both sources: keys pressed here, and keys the script forwards when the
  // iframe has focus (which it does after any click in the app — without the relay, P would silently
  // stop working the moment you used the page).
  // Esc is layered: first it closes the open note (dropping it if untouched), then it leaves
  // comment mode for Browse. One key that always means "back out of what I'm doing".
  const hotkey = useCallback((key: string) => {
    if (key === "Escape") {
      setSwitcher(false);
      if (editingRef.current) { closeEditor(); reArm(); return; }
      if (moveFromRef.current) {
        // The script disarms ITSELF on Escape, so any branch that keeps a tool selected has to put
        // the overlay back — otherwise the toolbar says Move and the page answers to nothing.
        moveFromRef.current = null; setMoveFrom(null); reArm(); return;
      }
      setTool(null);
      return;
    }
    if (key === "Send") { void sendAllRef.current(); return; }
    if (key === "p") setTool((v) => (v === "pin" ? null : "pin"));
    else if (key === "r") setTool((v) => (v === "rect" ? null : "rect"));
    else if (key === "m") setTool((v) => (v === "move" ? null : "move"));
    else if (key === "n") setTool("page");
  }, [closeEditor]);
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
    if (!sessionId || !cwd) { setSendError("No chat bound — pick one at the bottom left."); setSwitcher(true); return false; }
    setSendError(null);
    if (agent.busy) await agent.queueMessage(text, { cwd, mode: perm });
    else await agent.send(text, { cwd, mode: perm, resume: sessionId, model });
    return true;
  };

  const sendAll = async () => {
    if (sending) return;
    // The open note is KEPT, not dropped. "An untouched note is dropped" is a rule about moving on
    // to the next element — pressing Send is the opposite of moving on, and applying it here meant
    // that pinning something and hitting Send without typing deleted the pin and answered "nothing
    // to send". A pin with no words is still "look at this".
    setEditing(null);
    const batch = pinsRef.current.filter((p) => p.state === "open");
    if (!batch.length) { setSendError("Nothing to send — click something in the page first."); return; }
    if (!sessionId || !cwd) {
      setSendError(liveSessions && Object.keys(liveSessions).length
        ? "No chat bound — pick one from the list."
        : "No chat bound. Open this window from a chat's preview chip, or pick a running chat below.");
      setSwitcher(true);
      return;
    }
    setSending(true); setEditing(null);
    try {
      // Upload crops first so the message can name the paths (§11: the path is the payload).
      const withPaths = await Promise.all(batch.map(async (p) => ({ ...p, cropPath: p.cropData ? await uploadCrop(p.cropData) : null })));
      const lost = withPaths.filter((p) => p.cropData && !p.cropPath).length;
      const text = composeMessage(withPaths, { url: appUrl || src, viewport: viewportRef.current }, errors, { verify });
      // Mode is left alone on FAILURE (it used to drop to Browse before the send was even attempted,
      // so a rejected batch left you clicking a page that no longer answered).
      if (!(await deliver(text))) return;
      awaitingReply.current = true;
      const ids = new Set(batch.map((p) => p.id));
      setPins((prev) => prev.map((p) => (ids.has(p.id) ? { ...p, state: "sent", cropPath: withPaths.find((w) => w.id === p.id)?.cropPath ?? null, cropData: null } : p)));
      setErrors([]); post({ tag: TAG, t: "clearErrors" });
      setSendError(lost ? `Sent — but ${lost} screenshot${lost === 1 ? "" : "s"} couldn't be saved; the selectors still went.` : null);
    } catch (e) {
      setSendError(`Couldn't send: ${String((e as Error)?.message || e)}`);
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
    // The flag is cleared by the timer, not here. Clearing it up front meant that if a new turn
    // started inside the 1.5s window, the cleanup cancelled the timer and the NEXT idle saw the
    // flag already false — so that batch's pins stayed grey in the tray and grey in the app for
    // the rest of the session.
    const t = setTimeout(() => {
      awaitingReply.current = false;
      setPins((prev) => prev.filter((p) => p.state !== "sent"));
    }, 1500);
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

  // A window opened from a pane carries the folder but not always a session id — the pane may not
  // have gone live yet. Rather than leaving it unbound (and Send unexplained), adopt the running
  // chat in that folder as soon as one exists. Exactly one: two chats in a folder is a choice, and
  // guessing there is how comments land in the wrong conversation.
  useEffect(() => {
    if (sessionId || !cwd) return;
    let alive = true;
    const tick = () => fetch("/api/agent/live").then((r) => r.json()).then((d) => {
      if (!alive || !d?.activity) return;
      setLiveSessions(d.activity);
      const mine = Object.entries(d.activity as Record<string, LiveSession>).filter(([, v]) => v.cwd === cwd);
      if (mine.length === 1) {
        const u = new URL(window.location.href);
        u.pathname = `/preview/${mine[0][0]}`;
        window.history.replaceState(null, "", u.toString());
        attachedFor.current = null;
        setSessionId(mine[0][0]);
      }
    }).catch(() => {});
    tick();
    const iv = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, cwd]);

  useEffect(() => {
    if (!switcher) return;
    let alive = true;
    const load = () => fetch("/api/agent/live").then((r) => r.json()).then((d) => { if (alive && d?.activity) setLiveSessions(d.activity); }).catch(() => {});
    load();
    const iv = setInterval(load, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [switcher]);

  // Re-binding RELOADS the window rather than swapping state. useAgent keys its EventSource by pane
  // key and only closes it on unmount — so changing `sessionId` in place left the old session's
  // stream open and the pop-out kept reporting (and routing sends by) the OLD chat's busy state.
  // A reload is the one move that cannot leave a half-swapped binding behind. Pins are the cost, so
  // it asks first when any are open.
  const rebind = (id: string, c: string) => {
    if (pinsRef.current.some((p) => p.state === "open") &&
        !window.confirm("Switching chats reloads this window and clears your unsent comments. Continue?")) return;
    const u = new URL(window.location.href);
    u.pathname = `/preview/${id}`;
    u.searchParams.set("cwd", c);
    if (appUrl) u.searchParams.set("url", appUrl);
    window.location.replace(u.toString());
  };

  useEffect(() => { document.title = `${open.length ? `(${open.length}) ` : ""}${appUrl || "Preview"} — Minami`; }, [open.length, appUrl]);

  const go = (u: string) => {
    const clean = u.trim().replace(/^(?!https?:\/\/)/, "http://");
    if (!isPreviewUrl(clean)) { setSendError("Only localhost URLs can be previewed here."); return; }
    setSendError(null); setSrc(clean); setSrcDraft(clean); setAppUrl(clean); setHooked(false); setIframeKey((k) => k + 1);
  };
  const nav = (dir: -1 | 0 | 1) => {
    if (dir === 0) { setSrc(appUrl || src); setIframeKey((k) => k + 1); return; }
    const next = histAt.current + dir;
    if (next < 0 || next >= history.current.length) return;
    histAt.current = next;
    navigating.current = true;
    const url = history.current[next];
    setSrc(url); setSrcDraft(url); setIframeKey((k) => k + 1);
  };

  const editingPin = editing ? pins.find((p) => p.id === editing) || null : null;
  const boundName = cwd ? basename(cwd) : sessionId ? sessionId.slice(0, 8) : "no chat";
  const busyLabel = agent.busy ? agent.activity.label : "";

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      {/* ── toolbar ── */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 bg-neutral-900/80 px-2 text-[12px]">
        <IconBtn title={histState.back ? "Back" : "Nothing to go back to yet"} disabled={!histState.back} onClick={() => nav(-1)}><ArrowLeft size={14} /></IconBtn>
        <IconBtn title={histState.fwd ? "Forward" : "Nothing forward"} disabled={!histState.fwd} onClick={() => nav(1)}><ArrowRight size={14} /></IconBtn>
        <IconBtn title="Reload this page" onClick={() => nav(0)}><RotateCw size={14} /></IconBtn>
        <form className="mx-1 flex min-w-0 flex-1 items-center" onSubmit={(e) => { e.preventDefault(); go(srcDraft); }}>
          <input
            value={srcDraft} onChange={(e) => setSrcDraft(e.target.value)} onFocus={(e) => e.target.select()}
            placeholder="http://localhost:3001/…" spellCheck={false}
            className="h-7 w-full min-w-0 rounded-md border border-white/10 bg-black/40 px-2 font-mono text-[11.5px] text-neutral-200 outline-none focus:border-[var(--sakura)]/60"
          />
        </form>
        {src && <IconBtn title="Open in your browser" onClick={() => window.open(appUrl || src, "_blank", "noopener")}><ExternalLink size={14} /></IconBtn>}
        <span className="mx-1 h-5 w-px bg-white/10" />
        {/* The mode switch. Comment is the default and the reason the window exists; Browse is the
            escape hatch for using the app (links, forms, scrolling with the mouse). */}
        <div className="flex h-7 items-center rounded-md border border-white/10 bg-black/30 p-0.5" title="Comment: click anything to pin it · Browse: use the app normally (Esc)">
          <button type="button" onClick={() => setTool(null)} className={`flex h-6 items-center gap-1 rounded px-2 ${tool === null ? "bg-white/10 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}><MousePointer2 size={13} /> Browse</button>
          <button type="button" onClick={() => setTool("pin")} disabled={!hooked} className={`flex h-6 items-center gap-1 rounded px-2 disabled:opacity-40 ${tool === "pin" ? "bg-[var(--sakura)]/25 text-[var(--sakura)]" : "text-neutral-500 hover:text-neutral-300"}`}><MousePointerClick size={13} /> Comment</button>
        </div>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <ToolBtn active={tool === "rect"} disabled={!hooked} title="Drag a region (R)" onClick={() => setTool(tool === "rect" ? "pin" : "rect")}><BoxSelect size={14} /> Region</ToolBtn>
        <ToolBtn active={tool === "move"} disabled={!hooked} title="Move this → here (M)" onClick={() => setTool(tool === "move" ? "pin" : "move")}><MoveRight size={14} /> Move</ToolBtn>
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
          // NOT disabled on a missing binding. It used to be, which made the one failure a new
          // user actually hits — a window opened before its chat had a session — a greyed button
          // that swallowed the click and explained nothing. It stays clickable and says what is
          // wrong; only "nothing pinned yet" and "already sending" disable it.
          type="button" onClick={sendAll} disabled={!open.length || sending}
          title={!open.length ? "Nothing pinned yet — click something in the page" : !sessionId ? "No chat bound — click to pick one" : "Send all open comments as one message (⌘↩)"}
          className="ml-1 flex h-7 items-center gap-1.5 rounded-md bg-[var(--sakura)] px-3 font-medium text-black disabled:opacity-40"
        >{sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send {open.length ? open.length : ""}</button>
      </div>

      {/* ── stage ── */}
      <div ref={stageRef} className="relative min-h-0 flex-1 bg-neutral-900">
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

        {/* The hover readout used to float over the page's top-left, which on most sites is the
            logo and nav — the chrome you are most likely to be pointing at. It lives in the status
            bar now; the highlight outline inside the app already says WHERE, so this only has to
            say WHAT. */}
        {tool === "move" && moveFrom && (
          <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-[var(--sakura)]/40 bg-black/80 px-2 py-1 text-[11px] text-neutral-300">
            moving <span className="font-mono">{shortChain(moveFrom, 1)}</span> — click where it should go
          </div>
        )}

        {/* note popover, anchored to the pin's box when it has one */}
        {editingPin && (
          <NoteEditor
            pin={editingPin} stage={stage}
            onChange={(patch) => setPins((prev) => prev.map((p) => (p.id === editingPin.id ? { ...p, ...patch } : p)))}
            onDelete={() => { setPins((prev) => prev.filter((p) => p.id !== editingPin.id)); setEditing(null); reArm(); }}
            onClose={() => { closeEditor(); reArm(); }}
            onSend={() => void sendAllRef.current()}
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
        <button type="button" onClick={() => setSwitcher((v) => !v)}
          className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-white/5 ${!sessionId ? "text-amber-300" : ""}`}
          title={sessionId ? "Bound chat — click to change" : "Nothing to send to yet — click to pick a running chat"}>
          <span className={`h-2 w-2 rounded-full ${!sessionId ? "bg-amber-400" : agent.detached ? "bg-amber-400" : agent.busy ? "bg-[var(--sakura)] animate-pulse" : "bg-emerald-400"}`} />
          {/* An unbound window used to show the FOLDER name here, which looks exactly like a bound
              one — so "why is Send doing nothing" had no answer anywhere on screen. */}
          <span className={`font-medium ${sessionId ? "text-neutral-200" : "text-amber-300"}`}>{sessionId ? boundName : cwd ? `${basename(cwd)} — no chat yet` : "pick a chat"}</span>
          <ChevronDown size={12} className={sessionId ? "text-neutral-500" : "text-amber-400/70"} />
        </button>
        <span className="min-w-0 flex-1 truncate text-neutral-400">
          {sendError ? <span className="text-red-300">{sendError}</span>
            : agent.error ? <span className="text-red-300">{agent.error}</span>
            : busyLabel ? <>Claude {busyLabel}{agent.turnElapsed > 0 ? <span className="text-neutral-600"> · {Math.round(agent.turnElapsed / 1000)}s</span> : null}</>
            : agent.detached ? <span className="flex items-center gap-1"><Link2Off size={11} /> not live — the next send resumes it</span>
            : lastReply ? <>Done — {lastReply}</>
            : !hooked ? ""
            : hover && (tool === "pin" || tool === "move")
              ? <span className="font-mono text-[11px]">{tool === "move" && moveFrom ? <span className="text-[var(--sakura)]">→ </span> : null}<span className="text-neutral-200">{shortChain(hover)}</span> <span className="text-neutral-600">{hover.selector}</span></span>
            : tool === "pin" ? "Comment mode — click anything to pin it · click a number to reopen its note · Esc to browse"
            : tool === "rect" ? "Drag a region · Esc to cancel"
            : tool === "move" ? (moveFrom ? "Now click where it should go · Esc to cancel" : "Click the thing to move · Esc to cancel")
            : "Browse mode — the app works normally · P to comment · click a number to reopen its note"}
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

/** The readable end of a component chain. An ecvision element really does report
 *  `InnerScrollHandlerNew > Hero > Band > Exchange > SignalMatch > Plot`, and a left-truncating
 *  label cut it to "InnerScrollHandlerNew > Hero …" — the two names that identify nothing. The
 *  innermost names are the ones that locate code, so the tail is what gets shown; the full chain
 *  still goes to Claude in the message. */
function shortChain(el: ElementInfo | undefined, n = 2): string {
  if (!el) return "";
  if (!el.components.length) return `<${el.tag}>`;
  const tail = el.components.slice(-n);
  return (el.components.length > n ? "… " : "") + tail.join(" > ");
}

function pinLabel(p: Pin): string {
  if (p.kind === "page") return "whole page";
  if (p.kind === "rect" && p.region) return `region ${Math.round(p.region.box.w)}×${Math.round(p.region.box.h)} · ${p.region.els.length} elements`;
  if (p.kind === "move" && p.el && p.to) return `${shortChain(p.el, 1)} → ${shortChain(p.to, 1)}`;
  if (p.el) return p.el.components.length ? shortChain(p.el, 3) : p.el.selector;
  return "";
}

function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return <button type="button" title={title} onClick={onClick} disabled={disabled} className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-white/5 hover:text-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent">{children}</button>;
}

function ToolBtn({ active, disabled, title, onClick, children }: { active: boolean; disabled?: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={disabled ? "Enable comments first (the app isn't reporting)" : title} onClick={onClick} disabled={disabled}
      className={`flex h-7 items-center gap-1 rounded-md px-2 disabled:opacity-40 ${active ? "bg-[var(--sakura)]/20 text-[var(--sakura)]" : "text-neutral-300 hover:bg-white/5"}`}>
      {children}
    </button>
  );
}

function NoteEditor({ pin, stage, onChange, onDelete, onClose, onSend }: { pin: Pin; stage: { w: number; h: number }; onChange: (patch: Partial<Pin>) => void; onDelete: () => void; onClose: () => void; onSend: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(200); // measured height, for the bottom clamp
  useEffect(() => { ref.current?.focus(); }, [pin.id]);
  // Measured rather than assumed: the card is ~160px bare and ~280px once a crop arrives, and the
  // crop arrives AFTER the card opens (see `cropped`), so a constant would be wrong half the time.
  useEffect(() => {
    if (!boxRef.current) return;
    const ro = new ResizeObserver(() => setH(boxRef.current?.offsetHeight || 200));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);
  // Anchored beside the element when we know where it is; otherwise centred at the top. The stage is
  // the iframe's parent, and boxes are viewport coordinates inside the iframe, which start at the
  // stage's top-left — so a pin's box IS its position here, offset just enough not to cover it.
  //
  // > 🐛 Only the TOP was clamped, so a pin in the lower third of the page opened a note whose
  // textarea, Done and Delete were below the stage's hidden overflow — unreachable, unscrollable,
  // and Esc deleted the pin because the note was still empty. Both axes are clamped now, and a card
  // that would hang off the bottom flips to sit ABOVE its element instead.
  const W = 320, M = 8;
  const style: React.CSSProperties = (() => {
    if (!pin.box) return { left: "50%", top: 12, transform: "translateX(-50%)" };
    const right = pin.box.x + pin.box.w + 12;
    const left = right + W + M <= stage.w ? right : Math.max(M, pin.box.x - W - 12);
    const below = pin.box.y;
    const top = below + h + M <= stage.h ? below : Math.max(M, Math.min(stage.h - h - M, pin.box.y + pin.box.h - h));
    return { left: Math.max(M, Math.min(left, stage.w - W - M)), top: Math.max(M, top) };
  })();
  return (
    <div ref={boxRef} style={style} className="absolute z-20 w-80 rounded-lg border border-white/10 bg-neutral-900 p-2 text-[12px] shadow-2xl">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[var(--sakura)]">{circled(pin.n)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-neutral-500">{pinLabel(pin)}</span>
        <button type="button" onClick={onDelete} title="Delete this comment" className="text-neutral-500 hover:text-red-300"><Trash2 size={13} /></button>
        <button type="button" onClick={onClose} title="Keep and close (Enter / Esc)" className="flex items-center gap-1 rounded-md bg-[var(--sakura)]/20 px-2 py-0.5 text-[11px] text-[var(--sakura)] hover:bg-[var(--sakura)]/30"><Check size={12} /> Done</button>
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
        onKeyDown={(e) => {
          // ⌘↩ has to send from HERE, because the textarea has focus immediately after every pick —
          // the window-level handler bails on any focused input, and this one used to treat ⌘↩ as a
          // plain Enter and merely close the note. Shift+Enter is a newline, as everywhere.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onClose(); onSend(); return; }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onClose(); }
        }}
        placeholder={pin.kind === "move" ? "why / how it should move (optional)" : "what should change here?"}
        rows={2} className="w-full resize-none rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[12px] text-neutral-100 outline-none focus:border-[var(--sakura)]/60"
      />
      {pin.cropData && <img src={pin.cropData} alt="" className="mt-1.5 max-h-28 w-full rounded border border-white/10 object-contain" />}
      <div className="mt-1 text-[10.5px] text-neutral-600">Enter or Esc keeps it · ⌘↩ sends everything · click the next thing to keep going</div>
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
