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
//     loses nothing. Starting clears it; a start that fails puts it back.
// Portalled to <body>: the tile it opens from sits in a reflowing grid, and a `fixed` element under a
// transformed ancestor is positioned against that ancestor, not the viewport.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Composer from "@/components/Composer";
import { useBackLayer } from "@/lib/use-back";
import { dropImageRef, imageRefs, imageUrl } from "@/lib/image-refs";
import { K, mix, EASE, PillButton } from "@/app/today/ui";

const draftKey = (project: string) => `minami:newtask:${project}`;

/** The saved draft for a project, for the tile's trigger to show. Empty string when there is none. */
export function readDraft(project: string): string {
  try { return localStorage.getItem(draftKey(project)) ?? ""; } catch { return ""; }
}

/** Put a failed start's text back as the draft — unless a newer draft has been begun since. */
export function restoreDraft(project: string, text: string) {
  try { if (!readDraft(project)) localStorage.setItem(draftKey(project), text); } catch { /* private mode */ }
}

export function NewTask({ project, open, onClose, onStart }: {
  project: string; open: boolean; onClose: () => void;
  /** Starts the chat. Throws on failure, so the sheet can stay open with the draft intact. */
  onStart: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const pickPhoto = useRef<(() => void) | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useBackLayer(open, onClose);

  useEffect(() => { if (open) setText(readDraft(project)); }, [open, project]);
  useEffect(() => {
    if (!open) return;
    try { if (text.trim()) localStorage.setItem(draftKey(project), text); else localStorage.removeItem(draftKey(project)); } catch { /* private mode */ }
  }, [text, open, project]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);

  const imgs = imageRefs(text);
  const words = text.trim() ? text.trim().split(/\s+/).length - imgs.length : 0;

  // Closes at once and hands the start to the background (lib/ask.ts startInBackground), so the board
  // is usable while the worktree and session spin up. The draft is cleared now and put back by the
  // caller's onFail — kept until success instead, it would reappear in the sheet for the NEXT task.
  const start = () => {
    const t = text.trim();
    if (!t) return;
    try { localStorage.removeItem(draftKey(project)); } catch { /* */ }
    setText(""); onClose();
    onStart(t);
  };

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center md:items-start md:pt-[10vh]">
      <div onClick={onClose} className="absolute inset-0" style={{ background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)" }} />
      <div role="dialog" aria-label={`New task in ${project}`}
        className="relative flex max-h-[92dvh] w-full max-w-[680px] flex-col p-5 max-md:rounded-t-[28px] max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))] md:max-h-[80vh] md:rounded-[28px]"
        style={{ background: `linear-gradient(160deg, ${mix(K.paper, 94)}, ${mix(K.bg, 96)})`, border: `1px solid ${K.line2}`, boxShadow: "0 24px 70px rgba(0,0,0,.55)", animation: `shell-rise 320ms ${EASE}` }}>

        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.09em]" style={{ color: K.faint }}>New task</span>
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold" style={{ color: K.ink }}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sakura)]" />{project}
          </span>
          <button onClick={onClose} className="ml-auto self-center px-1 text-[15px]" style={{ color: K.muted }} aria-label="Close">✕</button>
        </div>

        {/* The whole card is the text box: a click anywhere in the empty space below the first line
            lands the caret, instead of only the one-line strip the textarea occupies when empty. */}
        <div ref={box} onClick={(e) => { if (e.target === e.currentTarget) box.current?.querySelector("textarea")?.focus(); }}
          className="min-h-[180px] flex-1 cursor-text overflow-y-auto rounded-[18px] px-4 py-3.5"
          style={{ background: mix(K.bg, 70), border: `1px solid ${K.line2}` }}>
          <Composer value={text} onChange={setText} onSubmit={start} sendOnMod roomy autoFocus
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

        <p className="mt-2 min-h-[18px] text-[12.5px]" style={{ color: K.faint }}>
          {text.trim()
            ? `${words} word${words === 1 ? "" : "s"}${imgs.length ? ` · ${imgs.length} image${imgs.length === 1 ? "" : "s"}` : ""} · draft saved`
            : "Starts a new chat in its own worktree, in the background — carry on meanwhile."}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => pickPhoto.current?.()} className="rounded-full px-3 py-1.5 text-[13px]"
            style={{ background: mix(K.ink, 7), border: `1px solid ${K.line}`, color: K.ink }}>＋ Image</button>
          <span className="flex-1" />
          <span className="hidden text-[11px] md:inline" style={{ color: K.faint, fontFamily: "var(--today-mono)" }}>⌘↵ to start · Esc to close</span>
          <PillButton tone="accent" small disabled={!text.trim()} onClick={start}>Start task</PillButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
