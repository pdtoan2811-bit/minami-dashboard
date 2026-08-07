"use client";
// The meeting canvas — the page Recall.ai streams as Minami's screen share.
//
// It renders exactly one thing: whatever CanvasDoc the producer last POSTed. No navigation, no
// chrome, no controls — anything clickable here is a lie, because the only people who see this page
// see it as pixels in someone else's video tile.
//
// Sizing: laid out for a 1280×720 share and scaled to fit whatever viewport it lands in, so the
// composition never reflows mid-call. A responsive grid would rearrange itself the moment Meet
// changed the share resolution, which on a client's screen looks like a bug.
import { useEffect, useRef, useState } from "react";
import { DEFAULT_SPAN, DEMO_DOC, DEMO_FULL, type CanvasDoc } from "@/lib/canvas-schema";
import { renderBlock } from "@/components/canvas/Blocks";

const BASE_W = 1280;
const BASE_H = 720;

export default function CanvasPage() {
  const [doc, setDoc] = useState<CanvasDoc>(DEMO_DOC);
  const [scale, setScale] = useState(1);
  const rev = useRef(DEMO_DOC.rev ?? 0);
  const stageRef = useRef<HTMLDivElement>(null);

  // Live updates. `rev` guards against out-of-order frames: a reconnect replays the seed frame, and
  // without the guard a stale seed could overwrite a newer doc mid-meeting.
  useEffect(() => {
    const demo = new URL(window.location.href).searchParams.get("demo");
    if (demo === "full") { setDoc(DEMO_FULL); return; }  // template gallery, frozen
    if (demo === "1") return;                            // frozen realistic demo, for design work

    const es = new EventSource("/api/canvas?stream=1");
    es.onmessage = (e) => {
      try {
        const next = JSON.parse(e.data) as CanvasDoc;
        if ((next.rev ?? 0) >= rev.current) {
          rev.current = next.rev ?? 0;
          setDoc(next);
        }
      } catch {
        /* a malformed frame must never blank a live screen share — keep the last good doc */
      }
    };
    // EventSource reconnects on its own; we only need to not treat that as fatal.
    es.onerror = () => {};
    return () => es.close();
  }, []);

  // Scale-to-fit, measured rather than assumed. The doc is produced by a model during a live call,
  // so its height is unknown and unbounded — assuming 720px and clipping means the last decisions of
  // a long meeting silently vanish off the bottom of a client's screen. We render at natural height,
  // measure, and shrink until it fits. One transform, no reflow, so this costs nothing per frame.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const h = el.scrollHeight || BASE_H;
      // Floor the shrink. Below ~0.72 the 15px body text renders under 11px, which on a shared
      // screen is decoration rather than information — better to let an over-long doc crop than to
      // make the whole canvas unreadable. Overflow here is a signal the producer sent too much.
      const raw = Math.min(window.innerWidth / BASE_W, window.innerHeight / h, 1);
      setScale(Math.max(raw, 0.72));
    };
    fit();
    // Content changes height when a new doc arrives, not just when the window resizes.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [doc]);

  const live = doc.status ?? "live";

  return (
    <main className="bg-bento grid h-dvh w-dvw place-items-center overflow-hidden">
      <div
        ref={stageRef}
        style={{ width: BASE_W, minHeight: BASE_H, transform: `scale(${scale})`, transformOrigin: "center" }}
        className="relative shrink-0 px-10 py-8"
      >
        <header className="mb-5 flex items-baseline justify-between gap-6">
          <div className="min-w-0">
            <h1 className="truncate text-[30px] font-semibold leading-tight text-white/95">
              {doc.title ?? "Meeting"}
            </h1>
            {doc.subtitle ? <p className="mt-0.5 truncate text-[14px] text-white/50">{doc.subtitle}</p> : null}
          </div>
          <span className="flex shrink-0 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5">
            <span
              className="size-2 rounded-full"
              style={{
                background: live === "live" ? "var(--sakura)" : "rgba(255,255,255,0.3)",
                boxShadow: live === "live" ? "0 0 0 3px rgba(232,133,155,0.18)" : "none",
              }}
            />
            <span className="text-[12px] font-medium capitalize text-white/70">{live}</span>
            <span className="text-[12px] text-white/30">·</span>
            <span className="text-[12px] text-white/50">Minami</span>
          </span>
        </header>

        <div className="grid grid-cols-6 gap-3.5">
          {doc.blocks.map((b, i) => {
            const span = b.span ?? DEFAULT_SPAN[b.kind] ?? 3;
            return (
              <div
                key={i}
                style={{ gridColumn: `span ${span} / span ${span}`, animationDelay: `${Math.min(i * 40, 320)}ms` }}
                className="min-w-0 [animation:bentoIn_var(--dur-3)_var(--ease-spring)_both]"
              >
                {renderBlock(b, i)}
              </div>
            );
          })}
        </div>

        {doc.reaction ? <Reaction kind={doc.reaction.kind} label={doc.reaction.label} /> : null}
      </div>
    </main>
  );
}

/** Celebration overlay.
 *
 *  Anchored bottom-centre, NOT centred. A centred modal covers whatever block happens to be in the
 *  middle — in testing it sat straight on top of the agenda — and hiding live meeting content to
 *  celebrate is precisely backwards. Bottom-centre overlaps the least-critical strip, reads as a
 *  toast rather than a takeover, and keeps the canvas legible while it's up. */
function Reaction({ kind, label }: { kind: "handshake" | "highfive" | "spark"; label?: string }) {
  const glyph = kind === "handshake" ? "🤝" : kind === "highfive" ? "🙌" : "✨";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 grid place-items-center">
      <div className="[animation:bentoIn_var(--dur-3)_var(--ease-spring)_both] flex items-center gap-3.5 rounded-2xl border border-white/10 bg-black/70 px-6 py-3.5 backdrop-blur-sm">
        <span className="text-[30px] leading-none">{glyph}</span>
        {label ? <span className="text-[16px] font-medium text-white/90">{label}</span> : null}
      </div>
    </div>
  );
}
