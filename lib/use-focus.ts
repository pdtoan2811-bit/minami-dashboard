"use client";
// The phone's focus set, client side (lib/focus.ts is the store, §23). Optimistic: a pin shows in the
// dock the moment you tap, and a refusal from the server (the set filled up on another device) rolls it
// back. Polled slowly so a pin made on the Flip shows up on the N5 without a reload.
import { useCallback, useEffect, useState } from "react";
import { onPageVisible, pageHidden } from "@/lib/page-visible";

// Pinned TASKS, not sessions — three, not five (2026-10-09): pins are the few tasks you juggle by hand;
// everything active below them sorts itself, so a big pin set only duplicated the automatic list.
export const FOCUS_MAX = 3;
const STORE_MAX = 8; // lib/focus.ts's cap on stored session ids

type PinResult = { ok: boolean; full?: boolean; focus: string[] };

async function post(body: object): Promise<PinResult | null> {
  try {
    const r = await fetch("/api/agent/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return null; }
}

export function useFocus() {
  const [focus, setFocus] = useState<string[]>([]);
  const load = useCallback(() => {
    fetch("/api/agent/focus", { cache: "no-store" }).then((r) => r.json()).then((d) => { if (Array.isArray(d?.focus)) setFocus(d.focus); }).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(() => { if (!pageHidden()) load(); }, 30_000);
    const off = onPageVisible(load);
    return () => { clearInterval(iv); off(); };
  }, [load]);

  /** Resolves `full` when the set is full and nothing was swapped out — the caller decides what to offer. */
  const pin = useCallback(async (id: string, swapOut?: string): Promise<"ok" | "full" | "error"> => {
    setFocus((f) => (f.includes(id) ? f : [...f.filter((x) => x !== swapOut), id].slice(-STORE_MAX)));
    const r = await post({ id, on: true, swapOut });
    if (!r) { load(); return "error"; }
    setFocus(r.focus);
    return r.ok ? "ok" : r.full ? "full" : "error";
  }, [load]);

  const unpin = useCallback(async (id: string) => {
    setFocus((f) => f.filter((x) => x !== id));
    const r = await post({ id, on: false });
    if (r) setFocus(r.focus); else load();
  }, [load]);

  return { focus, pin, unpin };
}
