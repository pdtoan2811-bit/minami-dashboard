"use client";
import { useEffect, useState } from "react";

// Tiny localStorage-backed settings. SSR-safe: starts at `def`, hydrates from storage on mount.
// The setter accepts a value OR an updater fn — always merge/derive through the functional form when
// the new value depends on the old one, so concurrent updates from different effects don't clobber
// each other via a stale closure (that bug dropped freshly-added chat panes on a project switch).
export function useSetting<T>(key: string, def: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [v, setV] = useState<T>(def);
  useEffect(() => {
    try { const s = localStorage.getItem("bento:" + key); if (s != null) setV(JSON.parse(s) as T); } catch { /* ignore */ }
  }, [key]);
  const set = (nv: T | ((prev: T) => T)) => {
    setV((prev) => {
      const val = typeof nv === "function" ? (nv as (p: T) => T)(prev) : nv;
      try { localStorage.setItem("bento:" + key, JSON.stringify(val)); } catch { /* ignore */ }
      return val;
    });
  };
  return [v, set];
}
