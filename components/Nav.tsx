"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Bento", icon: "⊞" },
  { href: "/dashboard", label: "Metrics", icon: "◧" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function Nav() {
  const p = usePathname();
  return (
    <nav className="flex items-center gap-0.5 rounded-xl border border-white/10 bg-white/[0.04] p-0.5">
      {ITEMS.map((it) => {
        const active = it.href === "/" ? p === "/" : p.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} title={it.label}
            className={`rounded-lg px-2 py-1 text-xs transition-colors ${active ? "bg-white/10 text-neutral-100" : "text-neutral-500 hover:text-neutral-200"}`}>
            <span className="mr-1">{it.icon}</span><span className="hidden sm:inline">{it.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
