"use client";
// A link that stands alone on its own line in a message, rendered as a card instead of a run of
// underlined text (§5c). The usual case is a page a session just built — a pitch on :3120, a dev
// server — and the questions you have about it are "what is it", "is it up" and "what does it look
// like", none of which a bare https://<mac>.ts.net:3120/homepage-hero/ answers.
//
// Pages on THIS machine get the full card: title from the page itself, a live thumbnail, an up/down
// dot. Anything else gets a quiet host + path card and no request at all (the meta route refuses it).
import { memo, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Copy, Check, Globe } from "lucide-react";
import { openLocalUrl, isLoopbackUrl, viewedRemotely, PREVIEW_EVENT } from "@/lib/open-local";

type Meta = { own: boolean; ok?: boolean; title?: string; description?: string; image?: string; remote?: string | null };

// One request per url per page load, shared by every card showing it — a url repeated across a
// transcript (it often is: "see X", then "X updated") must not fan out into N fetches.
const metaCache = new Map<string, Promise<Meta>>();
function loadMeta(url: string): Promise<Meta> {
  let p = metaCache.get(url);
  if (!p) {
    p = fetch(`/api/link-meta?url=${encodeURIComponent(url)}`).then((r) => r.json()).catch(() => ({ own: false }));
    metaCache.set(url, p);
  }
  return p;
}

// The thumbnail is the page itself at desktop width, scaled down — not a screenshot, so it is never
// stale, and nothing has to run a browser to make one.
const FRAME_W = 1280, FRAME_H = 800;

function LinkCard({ url, label }: { url: string; label?: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [copied, setCopied] = useState(false);
  // The live thumbnail is OPT-IN, one tap on "Preview" (fixed 2026-10-07). It used to mount on its own
  // as soon as the card neared the viewport, and every frame is a whole running page: a chat that
  // listed a few dev servers mounted a few apps, an animation-heavy pitch page pinned the main
  // thread, and a link to the dashboard itself framed the dashboard inside the dashboard, with every
  // poller and SSE stream that brings. The board froze and a pending question couldn't be answered.
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [scale, setScale] = useState(0.3);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { let alive = true; loadMeta(url).then((m) => { if (alive) setMeta(m); }); return () => { alive = false; }; }, [url]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / FRAME_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta, visible]);

  let u: URL | null = null;
  try { u = new URL(url); } catch { /* rendered as plain text by the caller's regex anyway */ }
  if (!u) return null;
  const own = !!meta?.own;
  const remote = viewedRemotely();
  // What the frame loads: the url as written on the desktop; on a phone, a loopback url has to become
  // its tailnet address, and if it hasn't been exposed there is nothing the phone could load.
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  // Never frame the dashboard itself — same origin, or its loopback port seen from here.
  const here = typeof window !== "undefined" ? window.location : null;
  const isDashboard = !!here && (u.origin === here.origin || (isLoopbackUrl(url) && port === (here.port || (here.protocol === "https:" ? "443" : "80")) && !remote) || (isLoopbackUrl(url) && port === "3000"));
  const frameSrc = !own || isDashboard || meta?.ok === false ? null : remote && isLoopbackUrl(url) ? meta?.remote || null : url;
  const host = own ? (isLoopbackUrl(url) ? `localhost:${port}` : `this mac :${port}`) : u.hostname.replace(/^www\./, "");
  const path = (u.pathname + u.search).replace(/\/$/, "") || "/";
  const title = meta?.title || (label && label !== url ? label : null) || (path !== "/" ? path.split("/").filter(Boolean).pop() : host);

  const open = () => {
    if (openLocalUrl(url)) return;
    // A tailnet url on the phone gets the in-app preview, same as a loopback one: a new tab from the
    // installed app lands in another Chrome task and Back never returns to the chat (§23).
    if (own && remote && window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
      window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: isLoopbackUrl(url) ? meta?.remote || url : url }));
      return;
    }
    window.open(url, "_blank", "noopener");
  };
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  };

  const tint = own ? "var(--sakura)" : "#7ab8e0";
  return (
    <div onClick={open} role="link" tabIndex={0} title={url}
      onKeyDown={(e) => { if (e.key === "Enter") open(); }}
      className="group/link my-1 w-full max-w-[460px] cursor-pointer overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-colors hover:border-white/25 hover:bg-white/[0.05]">
      {frameSrc && visible && (
        <div ref={boxRef} className="relative w-full overflow-hidden border-b border-white/[0.06] bg-black/40" style={{ aspectRatio: `${FRAME_W} / ${FRAME_H}` }}>
          {!loaded && <div className="absolute inset-0 animate-pulse bg-white/[0.04]" />}
          {(
            // pointer-events off and out of the tab order: it is a picture of the page, and the card's
            // click is the way in. sandbox without allow-top-navigation, so a page that redirects its
            // top window can't take the dashboard with it.
            <iframe src={frameSrc} title={title || url} loading="lazy" tabIndex={-1} aria-hidden
              sandbox="allow-scripts allow-same-origin"
              onLoad={() => setLoaded(true)}
              className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 transition-opacity duration-300"
              style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})`, opacity: loaded ? 1 : 0 }} />
          )}
        </div>
      )}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
          <Globe className="h-3.5 w-3.5" style={{ color: tint }} />
          {/* Up/down, for pages on this machine only — the one thing a dead dev server can't tell you
              until you have already clicked through to an error page. */}
          {own && meta?.ok !== undefined && (
            <span title={meta.ok ? "running" : "not responding"} className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-[#16161a]"
              style={{ background: meta.ok ? "#1f8a5c" : "#c4453c" }} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-neutral-100">{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-neutral-500">
            <span className="shrink-0" style={{ color: tint }}>{host}</span>
            {path !== "/" && <span className="min-w-0 truncate">{path}</span>}
            {own && meta?.ok === false && <span className="shrink-0 font-sans text-[#e07a70]">· not responding</span>}
          </span>
        </span>
        {frameSrc && (
          <button onClick={(e) => { e.stopPropagation(); setVisible((v) => !v); setLoaded(false); }} title={visible ? "Hide the live preview" : "Load a live preview of the page"}
            className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100">
            {visible ? "Hide" : "Preview"}
          </button>
        )}
        <button onClick={copy} title="Copy link"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-500 opacity-60 transition hover:bg-white/10 hover:text-neutral-200 group-hover/link:opacity-100">
          {copied ? <Check className="h-3.5 w-3.5 text-[#1f8a5c]" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-neutral-500 transition-colors group-hover/link:text-neutral-200" />
      </div>
    </div>
  );
}

export default memo(LinkCard);
