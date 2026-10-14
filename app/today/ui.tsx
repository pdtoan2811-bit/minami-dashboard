"use client";
// The Today material (§26), shared by /today and /ideas: ecvision's onboarding look — the golden-hour
// sky, frosted glass, pill buttons, mono eyebrows. Colours are ecvision's dark-ground kit tokens
// (kit.css, origin/develop 2026-10-12), not approximations.
import { useMemo, useState } from "react";
import Link from "next/link";
import { inter, interVi, mono } from "./fonts";

// ── tokens (kit.css: [data-ground="dark"] + [data-brand="ecvision"] dark) ───────────────────────────
export const K = {
  bg: "#0b0e12", paper: "#161b23", ink: "#ffffff", muted: "rgba(255,255,255,.68)", faint: "rgba(255,255,255,.45)",
  line: "rgba(255,255,255,.12)", line2: "rgba(255,255,255,.22)", accent: "#346aff", accentBright: "#90aeff", accent2: "#6fe3ff",
  cat1: "#2985f0", cat3: "#c38400", cat4: "#db6393", cat6: "#ec3a3e",
};
export const mix = (c: string, p: number, onto = "transparent") => `color-mix(in srgb, ${c} ${p}%, ${onto})`;
export const EASE = "cubic-bezier(.22,.61,.21,1)";
export const hhmm = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

// `backticks` from the heartbeat → inline code
export function Inline({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/g).map((p, i) => p.length > 2 && p.startsWith("`") && p.endsWith("`")
    ? <code key={i} className="rounded px-1 py-px text-[0.88em]" style={{ fontFamily: "var(--today-mono)", background: "rgba(255,255,255,.08)" }}>{p.slice(1, -1)}</code> : p)}</>;
}

export function Ground({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${inter.variable} ${interVi.variable} ${mono.variable} relative min-h-dvh`} style={{ fontFamily: "var(--today-sans), var(--today-sans-vi), ui-sans-serif, system-ui", color: K.ink, background: K.bg }}>
      <Sky fixed />
      <div className="relative">{children}</div>
    </div>
  );
}

// The onboarding's golden-hour sky, reduced to what reads at a glance: the base gradient (cat-1 over
// cat-6 on the dark ground), an afterglow, three receding glass panes and film grain.
const GRAIN = `url("data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .55 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>')}")`;
export function Sky({ fixed }: { fixed?: boolean }) {
  const panes = useMemo(() => [
    { inset: "14% 9% 9% 11%", rot: -1.6, o: 1 }, { inset: "20% 7% 21% 27%", rot: -0.8, o: .85 }, { inset: "24% 6% 28% 33%", rot: 0, o: .7 },
  ], []);
  return (
    <div aria-hidden className={`${fixed ? "fixed" : "absolute"} inset-0 overflow-hidden`} style={{ background: `linear-gradient(to bottom, ${mix(K.cat1, 24, K.bg)}, ${mix(K.cat6, 16, K.bg)})` }}>
      <div className="absolute inset-x-0 bottom-0 h-[60%]" style={{ background: `radial-gradient(ellipse 50% 50% at 50% 100%, ${mix(K.cat3, 18)} 0%, ${mix(K.cat6, 12)} 40%, transparent 80%)` }} />
      <div className="absolute inset-0 hidden sm:block" style={{ perspective: 1400 }}>
        {panes.map((p, i) => (
          <div key={i} className="absolute rounded-[34px]" style={{ inset: p.inset, opacity: p.o, transform: `rotateY(-9deg) rotateZ(${p.rot}deg)`,
            background: `linear-gradient(155deg, ${mix(K.ink, 12)} 0%, ${mix(K.cat3, 6)} 34%, ${mix(K.cat4, 7)} 62%, ${mix(K.cat1, 8)} 100%)`,
            border: `1px solid ${mix(K.ink, 22)}`, boxShadow: `0 30px 80px rgba(0,0,0,.45)` }} />
        ))}
      </div>
      <div className="absolute inset-0" style={{ backgroundImage: GRAIN, opacity: .08 }} />
    </div>
  );
}

export function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <div className="relative z-10 flex items-center px-5 pb-4 pt-5 sm:px-11 sm:pt-9">
      <Link href="/today" className="text-[17px] font-semibold tracking-tight">Minami</Link>
      <div className="ml-auto flex items-center gap-1 text-[14px]" style={{ color: K.muted }}>{right}</div>
    </div>
  );
}

export function Glass({ children, className = "", elevated }: { children: React.ReactNode; className?: string; elevated?: boolean }) {
  return (
    <div className={`rounded-[30px] ${className}`} style={{
      background: `linear-gradient(160deg, ${mix(K.ink, 10)}, ${mix(K.paper, 55)})`, border: `1px solid ${K.line2}`,
      backdropFilter: "blur(22px) saturate(175%)", WebkitBackdropFilter: "blur(22px) saturate(175%)",
      boxShadow: elevated ? "0 24px 70px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.12)" : "0 10px 34px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.08)" }}>
      {children}
    </div>
  );
}

export function Pills({ n, current, filled, max = 12 }: { n: number; current?: number; filled?: number; max?: number }) {
  const count = Math.min(n, max);
  return (
    <div className="flex items-center justify-center gap-1.5">
      {Array.from({ length: count }, (_, i) => {
        const on = current !== undefined ? i <= current : i < (filled ?? 0);
        const wide = current !== undefined && i === current;
        return <span key={i} className="h-1 rounded-full transition-all duration-500 motion-reduce:transition-none"
          style={{ width: wide ? 28 : 8, background: on ? K.accent : K.line2 }} />;
      })}
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p style={{ fontFamily: "var(--today-mono)", fontSize: 11, letterSpacing: "0.08em", color: K.muted }}>{children}</p>;
}

export function Title({ children, size = "l" }: { children: React.ReactNode; size?: "l" | "m" }) {
  return <h1 className={`text-center font-bold ${size === "l" ? "text-[30px] sm:text-[40px]" : "text-[23px] sm:text-[28px]"}`}
    style={{ lineHeight: size === "l" ? 1.07 : 1.18, letterSpacing: "-0.025em", textWrap: "balance" as never }}>{children}</h1>;
}

export function PillButton({ children, tone, cap, small, disabled, onClick, type = "button" }: { children: React.ReactNode; tone: "accent" | "paper"; cap?: boolean; small?: boolean; disabled?: boolean; onClick?: () => void; type?: "button" | "submit" }) {
  const accent = tone === "accent";
  return (
    <button type={type} disabled={disabled} onClick={onClick}
      className={`group relative flex items-center justify-center rounded-full font-semibold transition-all hover:-translate-y-px active:scale-[.98] disabled:pointer-events-none disabled:opacity-50 ${small ? "min-h-[36px] px-4 text-[13.5px]" : "min-h-[46px] w-full px-5 text-[15px]"} ${cap ? (small ? "pr-11" : "pr-12") : ""}`}
      style={{ transitionDuration: "320ms", transitionTimingFunction: EASE, lineHeight: 1.2,
        color: accent ? "#fff" : K.ink, background: accent ? K.accent : K.paper,
        border: `1px solid ${accent ? "transparent" : K.line2}`,
        boxShadow: accent ? `0 0 0 1px ${mix(K.accentBright, 45)}, 0 1px 3px rgba(0,0,0,.2)` : "0 1px 2px rgba(0,0,0,.25)" }}>
      {children}
      {cap && <span className={`absolute right-1.5 flex items-center justify-center rounded-full text-[14px] ${small ? "h-6 w-6" : "h-8 w-8"}`} style={{ background: "rgba(255,255,255,.18)" }}>→</span>}
    </button>
  );
}

export function OptionPill({ label, desc, on, rec, n, disabled, onClick }: { label: string; desc?: string; on: boolean; rec: boolean; n: number; disabled?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled} className="group relative w-full rounded-[24px] px-6 py-3 text-center transition-all hover:-translate-y-px active:scale-[.98]"
      style={{ transitionDuration: "320ms", transitionTimingFunction: EASE,
        background: on ? K.accent : K.paper, border: `1px solid ${on ? "transparent" : K.line2}`,
        boxShadow: on ? `0 0 0 1px ${mix(K.accentBright, 45)}, 0 1px 3px rgba(0,0,0,.2)` : "0 1px 2px rgba(0,0,0,.25)" }}>
      <span className="absolute left-5 top-[15px] hidden sm:block" style={{ fontFamily: "var(--today-mono)", fontSize: 10.5, color: on ? "rgba(255,255,255,.7)" : K.faint }}>{n}</span>
      <span className="block text-[15px] font-semibold leading-tight">{label}
        {rec && <span className="ml-2 inline-block -translate-y-px rounded-full px-1.5 py-px align-middle text-[9.5px] font-medium tracking-[0.06em]"
          style={{ fontFamily: "var(--today-mono)", background: on ? "rgba(255,255,255,.2)" : mix(K.accent, 26), color: on ? "#fff" : K.accentBright }}>SUGGESTED</span>}</span>
      {desc && <span className="mt-1 block text-[12.5px] font-normal leading-snug" style={{ color: on ? "rgba(255,255,255,.82)" : K.muted }}>{desc}</span>}
    </button>
  );
}

export function Chip({ children, on, dot, onClick }: { children: React.ReactNode; on: boolean; dot?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex shrink-0 items-center gap-2 rounded-full px-3.5 py-2 text-[13.5px] sm:px-4 font-semibold transition-all hover:-translate-y-px"
      style={{ transitionDuration: "320ms", transitionTimingFunction: EASE, background: on ? K.accent : mix(K.paper, 75), border: `1px solid ${on ? "transparent" : K.line2}`, color: K.ink }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: on ? "#fff" : dot }} />}{children}
    </button>
  );
}

export function TextButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className="text-[13px] hover:text-white disabled:opacity-60" style={{ color: K.muted }}>{children}</button>;
}

export function Fold({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Glass className="overflow-hidden">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-5 py-3.5 text-left">
        <span className="text-[15px] font-semibold">{label}</span>
        <span className="tabular-nums" style={{ color: K.faint, fontFamily: "var(--today-mono)", fontSize: 11 }}>{count}</span>
        <span className="ml-auto text-[12px] transition-transform" style={{ color: K.faint, transform: open ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </Glass>
  );
}
