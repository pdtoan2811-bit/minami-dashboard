"use client";
// Client-side loader for the brand/tech icon set (public/tech-icons.json), fetched once and cached
// for the whole app so the grid tiles and the chat attach bar share it.
import type { Icon } from "@/components/BrandIcon";

let cache: Record<string, Icon> | null = null;
let promise: Promise<Record<string, Icon>> | null = null;

export function loadTechIcons(): Promise<Record<string, Icon>> {
  if (cache) return Promise.resolve(cache);
  return (promise ||= fetch("/tech-icons.json").then((r) => r.json()).then((d) => (cache = d)).catch(() => ({})));
}
