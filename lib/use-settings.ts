"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Tiny localStorage-backed settings. SSR-safe: starts at `def`, hydrates from storage on mount.
// The setter accepts a value OR an updater fn — always merge/derive through the functional form when
// the new value depends on the old one, so concurrent updates from different effects don't clobber
// each other via a stale closure (that bug dropped freshly-added chat panes on a project switch).

// ── every mounted reader of a key, so a write reaches the OTHER components reading it ─────────────
//
// Without this, each call site holds a private useState and only the component that called the setter
// re-renders. That reads as "the toggle does nothing": flipping Agent view in Settings wrote
// `bento:agentMode` and updated the Settings page, while the `Nav` sitting inches away kept its stale
// copy until it happened to remount — a reload or a route change. The setting was never broken, only
// invisible, which is worse: you toggle it twice and conclude the feature is dead. Every key read in
// two places at once has the same shape (`showToolLogs` is written in Settings and read by every open
// pane), so this is a class fix, not a patch for one toggle.
//
// A module-level registry rather than a Context: these keys are read by components on different pages
// and inside panes that mount and unmount constantly, and a provider high enough to cover them all
// would re-render that whole tree on every keystroke (`draft:live:<id>` goes through this hook too).
const subscribers = new Map<string, Set<(raw: string | null) => void>>();

function broadcast(key: string, raw: string | null, self: (raw: string | null) => void): void {
  const set = subscribers.get(key);
  if (!set) return;
  // Snapshot: an `apply` may unmount a component mid-loop, mutating the set we're iterating.
  for (const fn of [...set]) if (fn !== self) fn(raw); // the writer already has the value
}

export function useSetting<T>(key: string, def: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [v, setV] = useState<T>(def);
  // Held in a ref so the hydrate effect can fall back to it without listing `def` as a dependency —
  // callers pass object/array literals (`{}`, `[]`), which are a new identity every render and would
  // re-fire this on every unrelated state change.
  const defRef = useRef(def);
  defRef.current = def;
  // Mirrors the current value so the setter can resolve an updater fn WITHOUT React's functional
  // form. That matters here: the setter also has to write storage and notify siblings, and doing
  // either inside a state updater is illegal — updaters must be pure, React may invoke them twice in
  // StrictMode, and calling setState on another component from inside one warns ("cannot update a
  // component while rendering a different component"). The ref is updated eagerly everywhere the
  // value changes, so it is never staler than the closure it replaces.
  const vRef = useRef(v);
  vRef.current = v;

  useEffect(() => {
    // On a KEY CHANGE with nothing stored under the new key, reset to `def`. Not resetting looks
    // harmless and isn't: with a per-session key (`draft:live:<id>`, `permMode:<id>`) the hook kept
    // showing the PREVIOUS session's value, so switching to a chat with no saved draft displayed the
    // draft from the chat you just left — one conversation's state appearing under another's name.
    try {
      const s = localStorage.getItem("bento:" + key);
      const next = s != null ? (JSON.parse(s) as T) : defRef.current;
      vRef.current = next;
      setV(next);
    } catch { vRef.current = defRef.current; setV(defRef.current); }
  }, [key]);

  // This instance's adopt-a-foreign-write callback. Identity-stable for the life of the hook so
  // broadcast() can skip the writer, and so the subscriber set doesn't churn on every render.
  const applyRef = useRef<(raw: string | null) => void>(() => {});
  // The identity actually held in the subscriber set — read by broadcast() to skip this instance.
  const selfRef = useRef<(raw: string | null) => void>(() => {});
  applyRef.current = (raw: string | null) => {
    try {
      const next = raw != null ? (JSON.parse(raw) as T) : defRef.current;
      vRef.current = next;
      setV(next);
    } catch { vRef.current = defRef.current; setV(defRef.current); }
  };

  useEffect(() => {
    // Registered indirectly through the ref so the registered identity never changes while the
    // behaviour stays current — re-registering on every render would defeat the writer-skip above.
    const apply = (raw: string | null) => applyRef.current(raw);
    const set = subscribers.get(key) || new Set<(raw: string | null) => void>();
    set.add(apply);
    subscribers.set(key, set);
    selfRef.current = apply;
    // Cross-TAB. The `storage` event fires only in the tabs that did NOT do the write, which is
    // exactly the set that needs it. Without it two open dashboards drift apart, and the stale one's
    // next write silently reverts the change you made in the other.
    const onStorage = (e: StorageEvent) => { if (e.key === "bento:" + key) apply(e.newValue); };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      set.delete(apply);
      if (!set.size) subscribers.delete(key);
    };
  }, [key]);

  // Stable identity, deliberately: an unmemoised setter is a new function on every render, so any
  // effect that lists it in its deps tears down and re-runs on every unrelated state change. That is
  // not merely wasteful — an effect holding drag state in a local (the panel divider did) silently
  // loses it mid-gesture, and the symptom is a resize that "didn't take".
  const set = useCallback((nv: T | ((prev: T) => T)) => {
    const val = typeof nv === "function" ? (nv as (p: T) => T)(vRef.current) : nv;
    vRef.current = val;
    setV(val);
    let raw: string | null = null;
    try { raw = JSON.stringify(val); localStorage.setItem("bento:" + key, raw); } catch { /* ignore */ }
    broadcast(key, raw, selfRef.current);
  }, [key]);

  return [v, set];
}
