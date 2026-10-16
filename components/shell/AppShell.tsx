"use client";
// The app shell (§30): one frame around every page — the golden-hour ground, the grouped rail on a
// desktop, a top strip and a bottom bar on a phone, the bell's drawer, the + capture and the project
// filter. Before it, each page drew its own header with its own copy of the nav (or none: Ideas and
// Meetings were reachable only by URL), and half the pages were dark bento while the other half were
// the Today sky, so moving between them felt like changing apps.
//
// Layout is a FIXED rail plus padding on the content, not a flex row with a scrolling <main>: pages
// here scroll the document (Today, Ideas, Autopilot) or are an h-dvh column (Bento), and either keeps
// working unchanged when the only difference is a left inset. The insets are CSS variables
// (--shell-left / --shell-top / --shell-bottom) so a page with fixed chrome of its own — Bento's phone
// search bar — can sit above the shell's instead of under it.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Plus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NAV, NAV_FOOTER, PHONE_TABS, isActive, isBare, type NavItem } from "@/lib/nav";
import { useSetting } from "@/lib/use-settings";
import { useCompact } from "@/lib/use-media";
import { useEvents } from "@/lib/use-events";
import { useBackLayer } from "@/lib/use-back";
import { useProjectFilter } from "@/lib/project-filter";
import { K, mix, Sky } from "@/app/today/ui";
import { ShellContext, useShellData } from "./use-shell";
import { Drawer } from "./Drawer";
import { Capture } from "./Capture";

const RAIL_OPEN = 208, RAIL_SHUT = 64, PHONE_TOP = 48, PHONE_BAR = 64;

export function AppShell({ children }: { children: React.ReactNode }) {
  const p = usePathname() || "/";
  if (isBare(p)) return <>{children}</>;
  return <Frame path={p}>{children}</Frame>;
}

function Frame({ path, children }: { path: string; children: React.ReactNode }) {
  const compact = useCompact();
  const [shut, setShut] = useSetting<boolean>("railShut", false);
  const [agentMode] = useSetting<boolean>("agentMode", false);
  const [fullscreen, setFullscreen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [capture, setCapture] = useState(false);
  const [more, setMore] = useState(false);
  const data = useShellData();
  const { unread } = useEvents();
  const needs = data?.needs.length ?? 0;
  const ctx = useMemo(() => ({ setFullscreen }), []);

  // Agent mode is opt-in and hidden means hidden — unless you are already on the page.
  const show = useCallback((it: NavItem) => !it.agentMode || agentMode || isActive(it, path), [agentMode, path]);

  // A route change closes whatever the shell had open: the drawer and the sheet both navigate.
  useEffect(() => { setMore(false); setDrawer(false); }, [path]);
  // Pages open the drawer by event (Bento's Day strip), so none of them needs a handle on the shell.
  useEffect(() => {
    const on = () => setDrawer(true);
    window.addEventListener("minami:open-drawer", on);
    return () => window.removeEventListener("minami:open-drawer", on);
  }, []);

  const left = compact ? 0 : shut ? RAIL_SHUT : RAIL_OPEN;
  const top = compact && !fullscreen ? PHONE_TOP : 0;
  const bottom = compact && !fullscreen ? PHONE_BAR : 0;

  // On <html>, not a wrapper: fixed elements inside pages (Bento's phone bar, sheets) resolve these
  // from wherever they are, and the safe-area part has to be added where it is used.
  useEffect(() => {
    const s = document.documentElement.style;
    s.setProperty("--shell-left", `${left}px`);
    s.setProperty("--shell-top", `${top}px`);
    s.setProperty("--shell-bottom", bottom ? `calc(${bottom}px + env(safe-area-inset-bottom))` : "0px");
  }, [left, top, bottom]);

  const bell = (
    <button onClick={() => setDrawer(true)} title={needs ? `${needs} waiting on you` : "Needs you · updates"} aria-label="Needs you"
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10"
      style={{ background: needs ? mix(K.accent, 26) : mix(K.ink, 6), border: `1px solid ${needs ? mix(K.accentBright, 40) : K.line}` }}>
      <Bell className="h-4 w-4" />
      {needs > 0 && <span className="absolute -right-1 -top-1 min-w-[17px] rounded-full px-1 text-center text-[10px] font-semibold leading-[17px] text-white" style={{ background: K.accent }}>{needs > 9 ? "9+" : needs}</span>}
      {/* Updates (deploys, builds) are not things that need him, so they don't raise the count — a dot. */}
      {!needs && unread > 0 && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full" style={{ background: K.accent2 }} />}
    </button>
  );
  const plus = (
    <button onClick={() => setCapture(true)} title="Capture an idea, to-do or goal" aria-label="Capture"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10" style={{ background: mix(K.ink, 6), border: `1px solid ${K.line}` }}>
      <Plus className="h-4 w-4" />
    </button>
  );

  return (
    <ShellContext.Provider value={ctx}>
      {/* Inter is applied here rather than in globals.css so the bare routes keep their own type: the
          meeting canvas is a customer-facing screen and must not change with the app's look. */}
      <div style={{ fontFamily: "var(--today-sans), var(--today-sans-vi), -apple-system, BlinkMacSystemFont, system-ui, sans-serif" }}>
      {/* Below everything (-z-10), because a fixed sky painted over pages whose tiles aren't positioned
          (Bento's grid). Not by lifting the content with a z-index instead: that makes the content a
          stacking context, and every page modal inside it (folder picker, lightbox) would then sit
          under the rail. */}
      <div className="fixed inset-y-0 right-0 -z-10" style={{ left }}><div className="relative h-full w-full overflow-hidden"><Sky panes={path === "/today"} /></div></div>
      {!compact && (
        <aside className="fixed inset-y-0 left-0 z-40 flex flex-col overflow-hidden transition-[width] duration-300" style={{ width: left,
          background: `linear-gradient(180deg, ${mix(K.paper, 62)}, ${mix(K.bg, 70)})`, borderRight: `1px solid ${K.line}`,
          backdropFilter: "blur(22px) saturate(160%)", WebkitBackdropFilter: "blur(22px) saturate(160%)" }}>
          <div className={`flex items-center gap-2 pb-3 pt-4 ${shut ? "justify-center px-0" : "px-4"}`}>
            {!shut && <Link href="/" className="flex items-center gap-2 text-[16px] font-semibold tracking-tight"><span>🌸</span>Minami</Link>}
            <button onClick={() => setShut(!shut)} title={shut ? "Expand the rail" : "Collapse the rail"} aria-label={shut ? "Expand the rail" : "Collapse the rail"}
              className={`rounded-lg p-1.5 transition-colors hover:bg-white/10 ${shut ? "" : "ml-auto"}`} style={{ color: K.faint }}>
              {shut ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </div>
          <div className={`flex gap-2 pb-3 ${shut ? "flex-col items-center" : "px-4"}`}>{plus}{bell}</div>
          {!shut && <div className="px-3 pb-2"><ProjectPicker projects={data?.projects ?? []} /></div>}
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {NAV.map((g) => {
              const items = g.items.filter(show);
              if (!items.length) return null;
              return (
                <div key={g.id} className="pt-3">
                  {shut ? <div className="mx-auto mb-1 h-px w-6" style={{ background: K.line }} />
                    : <p className="px-3 pb-1" style={{ fontFamily: "var(--today-mono)", fontSize: 10.5, letterSpacing: "0.08em", color: K.faint }}>{g.label.toUpperCase()}</p>}
                  {items.map((it) => <RailItem key={it.href} it={it} on={isActive(it, path)} shut={shut} />)}
                </div>
              );
            })}
          </nav>
          <div className="px-2 pb-4 pt-2" style={{ borderTop: `1px solid ${K.line}` }}>
            {NAV_FOOTER.map((it) => <RailItem key={it.href} it={it} on={isActive(it, path)} shut={shut} />)}
          </div>
        </aside>
      )}

      {compact && !fullscreen && (
        <header className="fixed inset-x-0 top-0 z-40 flex items-center gap-2 px-3" style={{ height: PHONE_TOP,
          background: mix(K.bg, 82), borderBottom: `1px solid ${K.line}`, backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" }}>
          <Link href="/" className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight"><span>🌸</span>Minami</Link>
          <div className="ml-auto min-w-0 max-w-[45%]"><ProjectPicker projects={data?.projects ?? []} small /></div>
          {plus}{bell}
        </header>
      )}

      <div className="relative" style={{ paddingLeft: left, paddingTop: top, paddingBottom: bottom ? `calc(${bottom}px + env(safe-area-inset-bottom))` : 0 }}>
        {children}
      </div>

      {compact && !fullscreen && (
        <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch px-1 pb-[env(safe-area-inset-bottom)]" style={{ height: `calc(${PHONE_BAR}px + env(safe-area-inset-bottom))`,
          background: mix(K.bg, 88), borderTop: `1px solid ${K.line}`, backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" }}>
          {PHONE_TABS.map((it) => <TabItem key={it.href} it={it} on={isActive(it, path)} />)}
          <button onClick={() => setMore(true)} className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium"
            style={{ color: more || [...NAV.flatMap((g) => g.items), ...NAV_FOOTER].some((it) => !PHONE_TABS.some((t) => t.href === it.href) && isActive(it, path)) ? K.ink : K.faint }}>
            <span className="text-[18px] leading-none">⋯</span>More
          </button>
        </nav>
      )}
      {compact && <MoreSheet open={more} onClose={() => setMore(false)} path={path} show={show} />}

      <Drawer open={drawer} onClose={() => setDrawer(false)} data={data} />
      <Capture open={capture} onClose={() => setCapture(false)} />
      </div>
    </ShellContext.Provider>
  );
}

function RailItem({ it, on, shut }: { it: NavItem; on: boolean; shut: boolean }) {
  return (
    <Link href={it.href} title={it.label} aria-current={on ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-xl py-2 text-[14px] transition-colors ${shut ? "justify-center px-0" : "px-3"} ${on ? "font-semibold" : "hover:bg-white/[0.06]"}`}
      style={{ background: on ? mix(K.accent, 30) : undefined, color: on ? K.ink : K.muted, boxShadow: on ? `inset 0 0 0 1px ${mix(K.accentBright, 30)}` : undefined }}>
      <span className="w-5 text-center text-[15px] leading-none">{it.icon}</span>
      {!shut && <span className="truncate">{it.label}</span>}
    </Link>
  );
}

function TabItem({ it, on }: { it: NavItem; on: boolean }) {
  return (
    <Link href={it.href} aria-current={on ? "page" : undefined} className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium" style={{ color: on ? K.ink : K.faint }}>
      <span className="flex h-7 w-12 items-center justify-center rounded-full text-[16px] leading-none" style={{ background: on ? mix(K.accent, 34) : undefined }}>{it.icon}</span>
      {it.label}
    </Link>
  );
}

function MoreSheet({ open, onClose, path, show }: { open: boolean; onClose: () => void; path: string; show: (it: NavItem) => boolean }) {
  useBackLayer(open, onClose);
  if (!open) return null;
  const rest = [...NAV.flatMap((g) => g.items), ...NAV_FOOTER].filter((it) => show(it) && !PHONE_TABS.some((t) => t.href === it.href));
  return (
    <div className="fixed inset-0 z-[80]">
      <div onClick={onClose} className="absolute inset-0" style={{ background: "rgba(0,0,0,.45)" }} />
      <div className="absolute inset-x-0 bottom-0 rounded-t-[28px] px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
        style={{ background: K.paper, border: `1px solid ${K.line2}` }}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full" style={{ background: K.line2 }} />
        {rest.map((it) => (
          <Link key={it.href} href={it.href} className="flex min-h-12 items-center gap-3 rounded-2xl px-4 text-[15px]"
            style={{ background: isActive(it, path) ? mix(K.accent, 30) : undefined }}>
            <span className="w-6 text-center text-[17px]">{it.icon}</span>{it.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

function ProjectPicker({ projects, small }: { projects: string[]; small?: boolean }) {
  const [pf, setPf] = useProjectFilter();
  // The current filter stays selectable even after it drops out of the 14-day list, or the select
  // would show "All projects" while the pages are still filtered.
  const list = pf && !projects.includes(pf) ? [pf, ...projects] : projects;
  return (
    <label className={`flex w-full items-center gap-1.5 rounded-full ${small ? "px-2.5 py-1" : "px-3 py-1.5"}`}
      style={{ background: pf ? mix(K.accent, 26) : mix(K.ink, 6), border: `1px solid ${pf ? mix(K.accentBright, 40) : K.line}` }} title="Filter every page to one project">
      <span className="text-[11px]" style={{ color: K.faint }}>▾</span>
      <select value={pf} onChange={(e) => setPf(e.target.value)} className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-[13px] outline-none" style={{ color: pf ? K.ink : K.muted }}>
        <option value="" style={{ background: K.paper }}>All projects</option>
        {list.map((p) => <option key={p} value={p} style={{ background: K.paper }}>{p}</option>)}
      </select>
      {pf && <button onClick={(e) => { e.preventDefault(); setPf(""); }} aria-label="Clear the project filter" className="text-[12px]" style={{ color: K.muted }}>✕</button>}
    </label>
  );
}
