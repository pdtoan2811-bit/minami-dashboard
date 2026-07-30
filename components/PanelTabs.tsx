"use client";

// The side slot's tab strip — ONE implementation, worn by both the file preview and the browser.
//
// "Make the browser match the file preview" is a request that a screenshot can satisfy and a codebase
// can't: two hand-built tab rows drift the first time either is touched. So the row is a component and
// both panels wear it, which makes "they match" a fact about the code rather than a thing someone
// remembers to check.
//
// Why tabs at all, replacing FilePanel's vertical rail and its <340px `<select>` stand-in:
//   · The rail cost a fixed 144px of WIDTH in a panel that is often ~290px wide — half the reading area
//     spent on a list, which is why it had to be hidden below 340px in the first place.
//   · Hiding it below 340px meant the panel had two different navigation models depending on its width,
//     and the narrow one (a native <select>) hid the file list behind a click and showed no state at
//     all — you couldn't see that three files had been touched without opening it.
//   · A tab row costs ~24px of HEIGHT at any width, shows every entry at once, and is the same gesture
//     in both panels.
//
// Truncation is the one thing a horizontal row does worse, and it's handled rather than ignored: the
// row scrolls, the active tab is scrolled into view, and each label keeps its `title`.

import { useEffect, useRef, type ReactNode } from "react";

export type PanelTab = {
  key: string;
  label: string;
  /** Long-form label for the tooltip — a file's full path, a request's URL. */
  title?: string;
  /** Small trailing count. `0`/undefined renders nothing rather than a "0" nobody needs to read. */
  count?: number;
  /** Tints the count when it means trouble (console errors, a failed request). */
  alert?: boolean;
  icon?: ReactNode;
  /** A 2px leading bar — the file panel's created/changed verb tint. */
  tint?: string;
};

export function PanelTabs({ tabs, active, onPick, right }: {
  tabs: PanelTab[];
  active: string;
  onPick: (key: string) => void;
  /** Controls pinned to the right of the row, outside the scroll area. */
  right?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the selected tab reachable. A chat that touches fifteen files pushes the newest ones past the
  // right edge, and the panel selects the most-recently-touched file by default — so without this the
  // common case is a strip whose selection is off-screen.
  useEffect(() => {
    const el = activeRef.current;
    if (!el || !scroller.current) return;
    // `nearest` rather than `center`: it only scrolls when the tab is genuinely out of view, so
    // clicking around a short list doesn't slide the row under the cursor on every click.
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  if (!tabs.length) return null;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.07] bg-black/20 px-1.5 py-1">
      <div ref={scroller} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button key={t.key} ref={on ? activeRef : undefined} onClick={() => onPick(t.key)} title={t.title || t.label}
              className={`flex max-w-[11rem] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors ${
                on ? "bg-white/10 text-neutral-100" : "text-neutral-500 hover:bg-white/5 hover:text-neutral-300"}`}>
              {t.tint && <span className="h-3 w-0.5 shrink-0 rounded-full" style={{ background: t.tint }} />}
              {t.icon}
              <span className="min-w-0 truncate">{t.label}</span>
              {!!t.count && (
                <span className={`shrink-0 tabular-nums text-[9px] ${t.alert ? "text-[#ef7c7c]" : "text-neutral-500"}`}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
      {right && <div className="flex shrink-0 items-center gap-0.5">{right}</div>}
    </div>
  );
}
