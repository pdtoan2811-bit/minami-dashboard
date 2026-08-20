"use client";
// EDIT AND DELETE THE CARD YOU CLICKED — the manual half of the board.
//
// Minami writes the board and is often nearly right. "Nearly right" on a screen a customer is
// watching is a thing anh has to talk over, and until now his only options were undo (which takes the
// wrong card) or saying a correction out loud and hoping the judge caught it. This is the direct
// route: click the card, fix the words, done.
//
// ── Why this is a fixed bar and not a popover on the card ───────────────────────────────────────
// The camera pans and eases continuously — a panel anchored to a node would drift under the cursor
// mid-edit, and on a 40-card board it would routinely open half off-screen. A stable position costs a
// glance and cannot fight the layout. It sits above the dock so the two read as one control surface.
//
// ── Why an edit is PINNED ──────────────────────────────────────────────────────────────────────
// The server marks an edited card and tells the judge and the tidy pass to leave its words alone. A
// correction that silently reverts two chunks later is worse than no correction at all: it is a
// visible argument with the machine, in front of the room.

import { useEffect, useRef, useState } from "react";
import type { GNode } from "@/lib/canvas-graph";

export function CardActions({ node, onClose }: { node: GNode | null; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  // Reset whenever the selection changes, so opening a second card never shows the first one's text.
  useEffect(() => {
    setEditing(false);
    setErr(null);
    setLabel(node?.label ?? "");
    setDetail(node?.detail ?? "");
  }, [node?.id, node?.label, node?.detail]);

  useEffect(() => { if (editing) first.current?.focus(); }, [editing]);

  if (!node || node.kind === "topic") return null;

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/canvas/control", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setErr(d?.error ?? `failed (${res.status})`); return null; }
      return d;
    } catch {
      setErr("could not reach the board");
      return null;
    } finally { setBusy(false); }
  }

  const save = async () => {
    if (!label.trim()) { setErr("a card needs a line"); return; }
    // `from` identifies the card, `text` is the new label, `to` the new detail — the control route's
    // existing field names, reused rather than inventing a fourth shape for the same POST.
    const d = await call({ action: "edit", from: node.id, text: label.trim(), to: detail.trim() });
    if (d) onClose();
  };

  const remove = async () => {
    const d = await call({ action: "delete", text: node.id });
    if (d) onClose();
  };

  return (
    <div className="pointer-events-auto absolute bottom-[92px] left-1/2 z-40 w-[min(620px,88vw)] -translate-x-1/2">
      <div className="rounded-2xl border border-neutral-200 bg-white/97 p-3 shadow-[0_18px_50px_-18px_rgba(16,24,40,0.4)] backdrop-blur-xl">
        {editing ? (
          <>
            <input
              ref={first}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[15px] font-semibold text-neutral-900 placeholder:text-neutral-400 outline-none focus:border-neutral-500"
              placeholder="The line on the card"
            />
            <input
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
              className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[13.5px] text-neutral-900 placeholder:text-neutral-400 outline-none focus:border-neutral-500"
              placeholder="The supporting line (optional)"
            />
            <div className="mt-2 flex items-center gap-2">
              <button onClick={save} disabled={busy}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40">Save</button>
              <button onClick={() => setEditing(false)} disabled={busy}
                className="rounded-lg px-3 py-1.5 text-[13px] text-neutral-500 hover:text-neutral-800">Cancel</button>
              <span className="flex-1" />
              <span className="text-[11.5px] text-neutral-400">your words are kept — Minami will not rewrite them</span>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px] font-semibold text-neutral-900">{node.label}</div>
              {node.detail ? <div className="truncate text-[12.5px] text-neutral-500">{node.detail}</div> : null}
            </div>
            <button onClick={() => setEditing(true)} disabled={busy}
              className="shrink-0 rounded-lg border border-neutral-200 px-3 py-1.5 text-[13px] font-medium text-neutral-800 hover:border-neutral-400 disabled:opacity-40">Edit</button>
            <button onClick={remove} disabled={busy}
              className="shrink-0 rounded-lg border border-neutral-200 px-3 py-1.5 text-[13px] font-medium text-rose-600 hover:border-rose-300 hover:bg-rose-50 disabled:opacity-40">Delete</button>
            <button onClick={onClose} aria-label="Close"
              className="shrink-0 text-[15px] leading-none text-neutral-300 hover:text-neutral-700">×</button>
          </div>
        )}
        {err ? <div className="mt-1.5 text-[12px] text-rose-600">{err}</div> : null}
      </div>
    </div>
  );
}
