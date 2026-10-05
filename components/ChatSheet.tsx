"use client";
// The phone's chat switcher (§23): a bottom sheet in place of the tab strip.
//
// On a 412px screen the tab strip held three 68px tabs truncated to "Verify di…", each with a 16×11px
// ✕, plus a second ✕ in the pane header (close chat) and a third beside ＋ (close the project) — three
// close glyphs meaning two different things, none of them thumb-sized. Here there is one list: every
// open chat as a full-width row with its own 44px close, then the topic's other chats to open, then
// "new chat". The sheet sits at the bottom because that is where the thumb already is.
import { X, Plus } from "lucide-react";

export type SheetChat = { key: string; title: string; sub: string; tint: string; busy: boolean; on: boolean };
export type SheetOther = { id: string; cwd: string; title: string; sub: string; dot: string };

export function ChatSheet({ open, others, full, onSelect, onClosePane, onOpen, onNew, onDismiss }: {
  open: SheetChat[];
  others: SheetOther[];
  /** All pane slots are taken: opening another chat swaps it into the CURRENT pane instead of adding. */
  full: boolean;
  onSelect: (i: number) => void;
  onClosePane: (i: number) => void;
  onOpen: (o: SheetOther) => void;
  onNew: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex flex-col justify-end" role="dialog" aria-label="Chats">
      <div className="absolute inset-0 bg-black/60" onClick={onDismiss} />
      <div className="relative flex max-h-[80dvh] flex-col rounded-t-2xl border-t border-white/10 bg-neutral-900 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl">
        {/* The grab bar is a button: tapping it dismisses, which is what people try on a sheet. */}
        <button onClick={onDismiss} aria-label="Close" className="flex w-full justify-center py-2.5"><span className="h-1 w-10 rounded-full bg-white/20" /></button>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-500">Open · {open.length}</p>
          {open.map((c, i) => (
            <div key={c.key} className={`flex items-center rounded-xl ${c.on ? "bg-[var(--sakura)]/[0.14]" : ""}`}>
              <button onClick={() => onSelect(i)} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 text-left">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.tint, opacity: c.busy ? 1 : 0.35 }} />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[15px] ${c.on ? "font-semibold text-neutral-50" : "text-neutral-200"}`}>{c.title}</span>
                  <span className="block truncate text-[12px] text-neutral-500">{c.sub}</span>
                </span>
              </button>
              {/* Closing is a view action — the session keeps running and stays in the list below. */}
              <button onClick={() => onClosePane(i)} aria-label={`Close ${c.title}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-neutral-400 active:bg-white/10"><X className="h-5 w-5" /></button>
            </div>
          ))}
          <button onClick={onNew} className="mt-1 flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-[var(--sakura)] active:bg-white/10">
            <Plus className="h-5 w-5" /> New chat
          </button>
          {others.length > 0 && (
            <>
              <p className="mt-3 px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-500">
                Other chats here{full ? " · replaces the current one" : ""}
              </p>
              {others.map((o) => (
                <button key={o.id} onClick={() => onOpen(o)} className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left active:bg-white/10">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.dot }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-neutral-300">{o.title}</span>
                    <span className="block truncate text-[12px] text-neutral-500">{o.sub}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
