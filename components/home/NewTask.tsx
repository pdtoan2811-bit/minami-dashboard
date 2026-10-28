"use client";
// Starting a task (§37). It used to be a one-line input on the topic tile, which was fine for "fix the
// favicon" and hopeless for what a task usually is: a few paragraphs, a list, two screenshots. So the
// tile's field is now a trigger, and this sheet is the writing surface:
//   - the chat Composer itself (paste / drop / 📎 photo, markdown tint, list continuation), so an
//     image here is byte-for-byte the same path-in-the-text a chat pane would send — /api/agent/send
//     inlines it for Claude, and the transcript shows the thumbnail afterwards;
//   - ⌘↵ starts, plain Enter is a newline — Enter-sends would fire a half-written brief at the first
//     paragraph break;
//   - the attached images as thumbnails under the text, each removable, so a long path isn't the only
//     sign that a screenshot is attached;
//   - the draft kept per project in localStorage, so closing the sheet (or a deploy blinking the page)
//     loses nothing. It is cleared only once the chat has actually started.
// On a phone the same sheet is also the bottom bar's ＋ (NewTaskButton below): the tile's trigger sits
// under Ask, Needs you, Where you left off, Today and the grid, then a tap to expand — five screens of
// scrolling before you can start anything. So there it opens from the thumb band, with the project as a
// chip you can change, and fills the screen (`dvh`, which follows the keyboard here because the
// viewport is `interactive-widget=resizes-content`).
// Portalled to <body>: the tile it opens from sits in a reflowing grid, and a `fixed` element under a
// transformed ancestor is positioned against that ancestor, not the viewport.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Composer from "@/components/Composer";
import { useBackLayer } from "@/lib/use-back";
import { dropImageRef, imageRefs, imageUrl } from "@/lib/image-refs";
import { K, mix, EASE, PillButton } from "@/app/today/ui";
import { startAsk } from "@/lib/ask";
import { useSetting } from "@/lib/use-settings";
import { useThreads, type ProjectRef } from "@/lib/use-threads";
import type { AgentMode } from "@/lib/use-agent";

const draftKey = (project: string) => `minami:newtask:${project}`;

/** The saved draft for a project, for the tile's trigger to show. Empty string when there is none. */
export function readDraft(project: string): string {
  try { return localStorage.getItem(draftKey(project)) ?? ""; } catch { return ""; }
}

export function NewTask({ project: initial, projects, open, onClose, onStart }: {
  project: string; open: boolean; onClose: () => void;
  /** Given, the project becomes a chip that can be changed (the phone's ＋, which has no tile to belong to). */
  projects?: ProjectRef[];
  /** Starts the chat. Throws on failure, so the sheet can stay open with the draft intact. */
  onStart: (text: string, project: string) => Promise<void>;
}) {
  const [project, setProject] = useState(initial);
  const [menu, setMenu] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pickPhoto = useRef<(() => void) | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useBackLayer(open, onClose);

  useEffect(() => { if (open) { setProject(initial); setText(readDraft(initial)); setErr(null); setMenu(false); } }, [open, initial]);
  // Switching project carries what's written across (the draft moves with it); an empty sheet picks up
  // that project's own left-behind draft instead.
  const switchTo = (next: string) => {
    setMenu(false);
    if (next === project) return;
    if (text.trim()) { try { localStorage.removeItem(draftKey(project)); } catch { /* */ } }
    else setText(readDraft(next));
    setProject(next);
  };
  useEffect(() => {
    if (!open) return;
    try { if (text.trim()) localStorage.setItem(draftKey(project), text); else localStorage.removeItem(draftKey(project)); } catch { /* private mode */ }
  }, [text, open, project]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, busy, onClose]);

  const imgs = imageRefs(text);
  const words = text.trim() ? text.trim().split(/\s+/).length - imgs.length : 0;

  const start = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    try {
      await onStart(t, project);
      try { localStorage.removeItem(draftKey(project)); } catch { /* */ }
      setText(""); onClose();
    } catch (e) { setErr(`Couldn't start: ${(e as Error).message || e}. Your draft is kept.`); }
    finally { setBusy(false); }
  };

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center md:items-start md:pt-[10vh]">
      <div onClick={() => !busy && onClose()} className="absolute inset-0" style={{ background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)" }} />
      <div role="dialog" aria-label={`New task in ${project}`}
        className="relative flex max-h-[92dvh] w-full max-md:h-[92dvh] max-w-[680px] flex-col p-5 max-md:rounded-t-[28px] max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))] md:max-h-[80vh] md:rounded-[28px]"
        style={{ background: `linear-gradient(160deg, ${mix(K.paper, 94)}, ${mix(K.bg, 96)})`, border: `1px solid ${K.line2}`, boxShadow: "0 24px 70px rgba(0,0,0,.55)", animation: `shell-rise 320ms ${EASE}` }}>

        <div className={`mb-3 flex gap-2 ${projects?.length ? "items-center" : "items-baseline"}`}>
          <span className="text-[11px] font-semibold uppercase tracking-[0.09em]" style={{ color: K.faint }}>New task</span>
          {projects?.length ? (
            <span className="relative min-w-0">
              <button onClick={() => setMenu((v) => !v)} disabled={busy} title="Which project this task is for — tap to change"
                className="flex min-w-0 max-w-full items-center gap-1.5 rounded-xl px-2.5 py-1 text-[15px] font-semibold pointer-coarse:py-1.5"
                style={{ color: K.ink, background: mix(K.ink, 7), border: `1px solid ${K.line}` }}>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sakura)]" /><span className="truncate">{project}</span><span className="text-[11px] opacity-60">▾</span>
              </button>
              {menu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1 max-h-[50dvh] w-64 overflow-y-auto rounded-xl border border-white/10 bg-neutral-900 p-1 shadow-2xl">
                    {projects.map((p) => (
                      <button key={p.project} onClick={() => switchTo(p.project)}
                        className={`flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[14px] hover:bg-white/10 ${p.project === project ? "text-[var(--sakura)]" : "text-neutral-200"}`}>
                        <span className="min-w-0 flex-1 truncate">{p.project}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold" style={{ color: K.ink }}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sakura)]" />{project}
            </span>
          )}
          <button onClick={onClose} disabled={busy} className="ml-auto self-center px-1 text-[15px]" style={{ color: K.muted }} aria-label="Close">✕</button>
        </div>

        {/* The whole card is the text box: a click anywhere in the empty space below the first line
            lands the caret, instead of only the one-line strip the textarea occupies when empty. */}
        <div ref={box} onClick={(e) => { if (e.target === e.currentTarget) box.current?.querySelector("textarea")?.focus(); }}
          className="min-h-[180px] flex-1 cursor-text overflow-y-auto rounded-[18px] px-4 py-3.5"
          style={{ background: mix(K.bg, 70), border: `1px solid ${K.line2}` }}>
          <Composer value={text} onChange={setText} onSubmit={start} sendOnMod roomy autoFocus disabled={busy}
            maxHeight={Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.45)} pickPhotoRef={pickPhoto}
            placeholder={"What needs doing, and what does done look like?\n\nWrite as much as you like — lists, links, context. Paste or drop screenshots straight in."} />
        </div>

        {imgs.length > 0 && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {imgs.map((p) => (
              <div key={p} className="group relative shrink-0 overflow-hidden rounded-xl" style={{ border: `1px solid ${K.line2}` }} title={p.split("/").pop()}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl(p)} alt={p.split("/").pop() || "image"} className="h-[72px] w-auto max-w-[160px] object-cover" />
                <button onClick={() => setText((t) => dropImageRef(t, p))} aria-label="Remove image"
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">✕</button>
              </div>
            ))}
          </div>
        )}

        <p className="mt-2 min-h-[18px] text-[12.5px]" style={{ color: err ? "#ef7c7c" : K.faint }}>
          {err ?? (text.trim()
            ? `${words} word${words === 1 ? "" : "s"}${imgs.length ? ` · ${imgs.length} image${imgs.length === 1 ? "" : "s"}` : ""} · draft saved`
            : projects?.length ? "Starts a new chat in its own worktree and opens it." : "Starts a new chat in its own worktree. It shows up as a card here once it replies.")}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => pickPhoto.current?.()} disabled={busy} className="rounded-full px-3 py-1.5 text-[13px]"
            style={{ background: mix(K.ink, 7), border: `1px solid ${K.line}`, color: K.ink }}>＋ Image</button>
          <span className="flex-1" />
          <span className="hidden text-[11px] md:inline" style={{ color: K.faint, fontFamily: "var(--today-mono)" }}>⌘↵ to start · Esc to close</span>
          <PillButton tone="accent" small disabled={!text.trim() || busy} onClick={start}>{busy ? "Starting…" : "Start task"}</PillButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The phone's way in (§37): a ＋ in the bottom bar that opens the sheet for the topic you're looking at,
 *  else wherever you were last working. Same start path as the tile's trigger. */
export function NewTaskButton({ prefer, topics = [], className = "" }: {
  prefer?: string | null; className?: string;
  /** Every bento topic. The threads feed only knows projects with a task this week, which on a phone
   *  left three to pick from. */
  topics?: ProjectRef[];
}) {
  const d = useThreads();
  const [perm] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [model] = useSetting<string | null>("chatModel", null);
  const [open, setOpen] = useState(false);
  const seen = new Set<string>();
  const projects = [...(d?.projects ?? []), ...topics].sort((a, b) => b.at - a.at).filter((p) => !seen.has(p.project) && !!seen.add(p.project));
  const initial = (prefer && projects.some((p) => p.project === prefer) ? prefer : null) ?? d?.threads[0]?.project ?? projects[0]?.project ?? "";
  return (
    <>
      <button onClick={() => setOpen(true)} disabled={!initial} aria-label="New task"
        className={`flex min-h-11 shrink-0 items-center gap-1 rounded-xl bg-[var(--accent-fill)] px-3 text-[13px] font-semibold text-white disabled:opacity-40 ${className}`}>
        <span className="text-[16px] leading-none">＋</span>Task
      </button>
      {initial && (
        <NewTask project={initial} projects={projects} open={open} onClose={() => setOpen(false)}
          onStart={async (t, name) => {
            const p = projects.find((x) => x.project === name);
            if (!p) throw new Error(`no folder known for ${name}`);
            await startAsk(p, t, { mode: perm, model });
          }} />
      )}
    </>
  );
}
