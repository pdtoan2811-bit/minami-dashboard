"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Tiny localStorage-backed settings. SSR-safe: starts at `def`, hydrates from storage on mount.
// The setter accepts a value OR an updater fn — always merge/derive through the functional form when
// the new value depends on the old one, so concurrent updates from different effects don't clobber
// each other via a stale closure (that bug dropped freshly-added chat panes on a project switch).
export function useSetting<T>(key: string, def: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [v, setV] = useState<T>(def);
  // Held in a ref so the hydrate effect can fall back to it without listing `def` as a dependency —
  // callers pass object/array literals (`{}`, `[]`), which are a new identity every render and would
  // re-fire this on every unrelated state change.
  const defRef = useRef(def);
  defRef.current = def;
  useEffect(() => {
    // On a KEY CHANGE with nothing stored under the new key, reset to `def`. Not resetting looks
    // harmless and isn't: with a per-session key (`draft:live:<id>`, `permMode:<id>`) the hook kept
    // showing the PREVIOUS session's value, so switching to a chat with no saved draft displayed the
    // draft from the chat you just left — one conversation's state appearing under another's name.
    try {
      const s = localStorage.getItem("bento:" + key);
      setV(s != null ? (JSON.parse(s) as T) : defRef.current);
    } catch { setV(defRef.current); }
  }, [key]);
  // Stable identity, deliberately: an unmemoised setter is a new function on every render, so any
  // effect that lists it in its deps tears down and re-runs on every unrelated state change. That is
  // not merely wasteful — an effect holding drag state in a local (the panel divider did) silently
  // loses it mid-gesture, and the symptom is a resize that "didn't take".
  const set = useCallback((nv: T | ((prev: T) => T)) => {
    setV((prev) => {
      const val = typeof nv === "function" ? (nv as (p: T) => T)(prev) : nv;
      try { localStorage.setItem("bento:" + key, JSON.stringify(val)); } catch { /* ignore */ }
      return val;
    });
  }, [key]);
  return [v, set];
}
