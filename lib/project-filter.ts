"use client";
// The shell's project filter (§30): one picker in the shell, honoured by every page that lists things
// belonging to a project. It is a filter, not a destination — "show me ecvision" should narrow the
// page you are on rather than send you to a project page that duplicates five others.
//
// Stored through useSetting so a change in the shell reaches every mounted reader at once (that hook's
// subscriber registry exists for exactly this: one key, readers on different components).
//
// Each store names projects its own way — Bento topics are folder names ("minami-dashboard"),
// automations use display names ("Minami Dashboard"), goals use vault note names ("ecvision"), to-dos
// carry a folder path. `projectKey` folds them all to one comparable form, so the filter matches
// across stores without a mapping table that would rot.
import { useSetting } from "./use-settings";

export const projectKey = (s?: string | null) =>
  (s || "").split("/").filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";

/** True when nothing is filtered, or when any of `names` belongs to the filtered project. */
export function matchesProject(filter: string, ...names: (string | null | undefined)[]) {
  if (!filter) return true;
  const f = projectKey(filter);
  return names.some((n) => {
    const k = projectKey(n);
    // A prefix, one way: filtering "ecvision" keeps the "ecvisionContent" folder, its sibling work.
    // Filtering "ecvisionContent" must not keep plain "ecvision", so only the item may extend the filter.
    return !!k && k.startsWith(f);
  });
}

export function useProjectFilter(): [string, (v: string) => void] {
  return useSetting<string>("projectFilter", "");
}
