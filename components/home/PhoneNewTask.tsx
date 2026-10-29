"use client";
// Starting a task on a phone (§37) — the version Thomas picked on 2026-10-28 (pitch `phone-new-task`,
// V3 "A tab of its own"). On the desk a task starts from a topic tile's trigger; on a phone that
// trigger sat five screens down and one tap behind expanding a tile, and a pill in Home's bottom bar
// (the first fix) still left Today, Autopilot and every chat with no way in. So:
//   - the ＋ is the middle tab of the shell's bottom nav, on every page (AppShell renders this);
//   - it opens a full screen, not a sheet: a brief is paragraphs and screenshots, and with the keyboard
//     up a sheet's rounded top and backdrop are just less room;
//   - the project is not asked first. It follows the words (the Ask line's `guessProject`), else the
//     shell's project filter, else wherever you last worked, and sits above the keyboard as a chip to
//     correct. A pick by hand sticks for the rest of that draft.
// One draft, not one per project: here the project can change under you while you type, and a draft
// that hopped between keys on every guess would be lost the first time the guess flipped back.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Composer from "@/components/Composer";
import { useBackLayer } from "@/lib/use-back";
import { dropImageRef, imageRefs, imageUrl } from "@/lib/image-refs";
import { K, mix } from "@/app/today/ui";
import { guessProject, startInBackground } from "@/lib/ask";
import { useProjectFilter } from "@/lib/project-filter";
import { useSetting } from "@/lib/use-settings";
import { useThreads } from "@/lib/use-threads";
import type { AgentMode } from "@/lib/use-agent";

const DRAFT = "minami:newtask:~phone";

/** The nav's middle tab. Renders the button in the bar and the full-screen composer when open. */
export function NewTaskTab() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="New task" className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium" style={{ color: K.ink }}>
        <span className="flex h-7 w-12 items-center justify-center rounded-xl text-[20px] leading-none text-white" style={{ background: "var(--accent-fill)" }}>＋</span>
        Task
      </button>
      {open && <PhoneNewTask onClose={() => setOpen(false)} />}
    </>
  );
}

function PhoneNewTask({ onClose }: { onClose: () => void }) {
  const d = useThreads();
  const [pf] = useProjectFilter();
  const [perm] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [model] = useSetting<string | null>("chatModel", null);
  const [text, setText] = useState(() => { try { return localStorage.getItem(DRAFT) ?? ""; } catch { return ""; } });
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const pickPhoto = useRef<(() => void) | null>(null);
  useBackLayer(true, onClose);

  useEffect(() => {
    try { if (text.trim()) localStorage.setItem(DRAFT, text); else localStorage.removeItem(DRAFT); } catch { /* private mode */ }
  }, [text]);

  const projects = d?.projects ?? [];
  const named = guessProject(text, projects);
  const fallback = projects.find((p) => p.project === pf) ?? (d?.threads[0] && projects.find((p) => p.project === d.threads[0].project)) ?? projects[0] ?? null;
  const target = (picked ? projects.find((p) => p.project === picked) : null) ?? named ?? fallback;
  const why = picked ? "" : named ? "you named it" : pf && target?.project === pf ? "your project filter" : "where you last worked";
  const imgs = imageRefs(text);

  // Closes at once; the start runs in the background (lib/ask.ts startInBackground) and the shell's
  // chip offers Open when it's ready — the old version held this screen up on "Starting…" for the
  // worktree, the send and the session-id poll, then yanked him to the board.
  const start = () => {
    const t = text.trim();
    if (!t || !target) return;
    try { localStorage.removeItem(DRAFT); } catch { /* */ }
    startInBackground(target, t, { mode: perm, model }, () => {
      try { if (!localStorage.getItem(DRAFT)) localStorage.setItem(DRAFT, t); } catch { /* */ }
    });
    onClose();
  };

  if (typeof document === "undefined") return null;
  // `h-dvh` follows the keyboard (the viewport is `interactive-widget=resizes-content`), so the chip row
  // and ＋ Image stay just above it instead of under it.
  return createPortal(
    <div role="dialog" aria-label="New task" className="fixed inset-x-0 top-0 z-[80] flex h-dvh flex-col px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]"
      style={{ background: K.bg }}>
      <div className="flex items-center gap-2 pb-2">
        <button onClick={onClose} aria-label="Close" className="-ml-1 flex h-10 w-10 items-center justify-center text-[18px]" style={{ color: K.muted }}>✕</button>
        <span className="flex-1 text-center text-[11px] font-semibold uppercase tracking-[0.09em]" style={{ color: K.faint }}>New task</span>
        <button onClick={start} disabled={!text.trim() || !target}
          className="h-9 rounded-full bg-[var(--accent-fill)] px-4 text-[14px] font-semibold text-white disabled:opacity-35">Start</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <Composer value={text} onChange={setText} onSubmit={start} sendOnMod roomy autoFocus pickPhotoRef={pickPhoto}
          maxHeight={Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.6)}
          placeholder={"What needs doing, and what does done look like?\n\nLists, links, screenshots — write as much as you like."} />
        {imgs.length > 0 && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {imgs.map((p) => (
              <div key={p} className="relative shrink-0 overflow-hidden rounded-xl" style={{ border: `1px solid ${K.line2}` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl(p)} alt={p.split("/").pop() || "image"} className="h-[72px] w-auto max-w-[160px] object-cover" />
                <button onClick={() => setText((t) => dropImageRef(t, p))} aria-label="Remove image"
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-[11px] text-white">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="relative flex flex-wrap items-center gap-x-1.5 gap-y-1 pb-2 text-[12.5px]" style={{ color: K.faint }}>
        Goes to
        <button onClick={() => setMenu((v) => !v)}
          className="flex max-w-[60%] items-center gap-1 rounded-xl bg-[var(--sakura)]/15 px-2.5 py-1.5 text-[13px] text-[var(--sakura)]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sakura)]" /><span className="truncate">{target?.project ?? "no project yet"}</span><span className="opacity-60">▾</span>
        </button>
        {why && <span>— {why}</span>}
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute bottom-full left-0 z-20 mb-1 max-h-[45dvh] w-64 overflow-y-auto rounded-xl border border-white/10 bg-neutral-900 p-1 shadow-2xl">
              {projects.map((p) => (
                <button key={p.project} onClick={() => { setPicked(p.project); setMenu(false); }}
                  className={`flex w-full rounded-lg px-3 py-2.5 text-left text-[14px] hover:bg-white/10 ${p.project === target?.project ? "text-[var(--sakura)]" : "text-neutral-200"}`}>
                  <span className="min-w-0 flex-1 truncate">{p.project}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => pickPhoto.current?.()} className="rounded-xl px-3 py-2 text-[13px]"
          style={{ background: mix(K.ink, 7), border: `1px solid ${K.line}`, color: K.ink }}>＋ Image</button>
        <span className="ml-auto text-[12px]" style={{ color: K.faint }}>{text.trim() ? "draft saved" : "opens as a chat once started"}</span>
      </div>
    </div>,
    document.body,
  );
}
