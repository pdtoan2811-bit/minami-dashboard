// The app's one map (§30). Every page the shell can reach is a line here and nowhere else: the
// desktop rail, the phone bar and "More" sheet all read this list. The nav used to be a hardcoded
// row in components/Nav.tsx that each new page either joined (crowding it) or skipped (Ideas,
// Meetings), which is how the dashboard ended up patchwork. A new page is now one entry in a group.
//
// Groups follow what Thomas is asking when he opens the app: WORK (what is running), DAY (what do I
// do now), AUTOPILOT (what runs without me, and toward what), LIBRARY (what I kept). Machine pages
// sit in the rail's footer so the daily nav stays about the work.

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** Paths that count as "here" besides `href` itself (old routes that redirect, sub-pages). */
  also?: string[];
  /** Hidden unless agent mode is on (Settings) — or you are already on the page. */
  agentMode?: boolean;
};
export type NavGroup = { id: string; label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  { id: "work", label: "Work", items: [
    { href: "/", label: "Bento", icon: "⊞" },
    { href: "/crew", label: "Crew", icon: "🜂", also: ["/agents", "/teams"], agentMode: true },
  ] },
  { id: "day", label: "Day", items: [
    { href: "/today", label: "Today", icon: "☀" },
    { href: "/growth", label: "Growth", icon: "↗" },
  ] },
  { id: "autopilot", label: "Autopilot", items: [
    { href: "/autopilot", label: "Goals & runners", icon: "◎", also: ["/goals", "/automations"] },
  ] },
  { id: "library", label: "Library", items: [
    { href: "/ideas", label: "Ideas", icon: "✦" },
    { href: "/meetings", label: "Meetings", icon: "◉" },
    { href: "/harness", label: "Harness browser", icon: "◍" },
  ] },
];

export const NAV_FOOTER: NavItem[] = [
  { href: "/dashboard", label: "Metrics", icon: "◧" },
  { href: "/settings", label: "Settings", icon: "⚙", also: ["/architecture"] },
];

// The phone's bottom bar: the four places reached daily, then More for the rest (§30).
export const PHONE_TABS: NavItem[] = [
  { href: "/", label: "Chats", icon: "⊞" },
  { href: "/today", label: "Today", icon: "☀" },
  { href: "/autopilot", label: "Autopilot", icon: "◎", also: ["/goals", "/automations"] },
  { href: "/ideas", label: "Ideas", icon: "✦" },
];

// Routes that are not app pages and must never get the shell. The canvas is Recall.ai's screen share
// in a live client meeting, /meet is the phone-as-microphone, /glance is the Flip's 360px cover
// screen, /preview and /browser are pop-outs: each owns the whole viewport by design.
export const BARE = ["/canvas", "/meet", "/glance", "/preview", "/browser"];

export const isBare = (p: string) => BARE.some((b) => p === b || p.startsWith(b + "/"));

export function isActive(it: NavItem, p: string) {
  if (it.href === "/") return p === "/";
  return [it.href, ...(it.also ?? [])].some((h) => p === h || p.startsWith(h + "/"));
}
