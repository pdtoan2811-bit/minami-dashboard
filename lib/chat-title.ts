// "Ecvision: Fix the pricing band" — how a chat is named on the phone (§5h). On the board a chat sits
// under its project's tile, so the title alone is enough; on the phone a chat is shown on its own (the
// inbox row, the bottom bar, the cover screen, a notification) and "Fix the pricing band" doesn't say
// which repo you're about to type into. Asked for in exactly this shape, 2026-10-07.

/** `minami-dashboard` → `Minami dashboard`, `ecvision` → `Ecvision`. camelCase is left alone. */
export function projectLabel(project: string): string {
  const p = (project || "").replace(/[-_]+/g, " ").trim();
  return p ? p[0].toUpperCase() + p.slice(1) : "";
}

/** The plain-text form, for places that can't style the two halves (a notification, aria-label). */
export function chatTitle(project: string, title: string): string {
  const label = projectLabel(project);
  if (!label) return title;
  // A title that already opens with the project ("Ecvision pricing…") doesn't need it twice.
  return title.toLowerCase().startsWith(label.toLowerCase()) ? title : `${label}: ${title}`;
}
