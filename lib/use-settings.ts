"use client";
import { useEffect, useState } from "react";

// Tiny localStorage-backed settings. SSR-safe: starts at `def`, hydrates from storage on mount.
export function useSetting<T>(key: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(def);
  useEffect(() => {
    try { const s = localStorage.getItem("bento:" + key); if (s != null) setV(JSON.parse(s) as T); } catch { /* ignore */ }
  }, [key]);
  const set = (nv: T) => { setV(nv); try { localStorage.setItem("bento:" + key, JSON.stringify(nv)); } catch { /* ignore */ } };
  return [v, set];
}
