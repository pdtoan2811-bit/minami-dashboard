"use client";
// A slim bar showing what's attached to a topic: its git repo (link) and the tech it uses, as brand
// icons. Detected server-side from .git/config, package.json, and config files (see /api/bento/attach).
// Icons come from the local public/tech-icons.json (no network, no runtime dep).
import { useEffect, useState } from "react";
import BrandIcon, { type Icon } from "@/components/BrandIcon";
import { loadTechIcons } from "@/lib/tech-icons";

type Attach = { repo: { url: string; host: string; name: string } | null; tech: string[] };

// `inline` renders the bar bare (no border/padding) with the repo link shown in full, so it can sit
// inside the panel header next to the title; the default is a standalone row under the header.
export default function AttachBar({ cwd, project, inline }: { cwd: string; project?: string; inline?: boolean }) {
  const [icons, setIcons] = useState<Record<string, Icon>>({});
  const [attach, setAttach] = useState<Attach | null>(null);

  useEffect(() => { loadTechIcons().then(setIcons); }, []);
  useEffect(() => {
    if (!cwd) { setAttach(null); return; }
    let a = true;
    const p = project ? `&project=${encodeURIComponent(project)}` : "";
    fetch(`/api/bento/attach?cwd=${encodeURIComponent(cwd)}${p}`).then((r) => r.json()).then((d: Attach) => { if (a) setAttach(d); }).catch(() => {});
    return () => { a = false; };
  }, [cwd, project]);

  if (!attach || (!attach.repo && attach.tech.length === 0)) return null;
  const hostSlug = attach.repo ? attach.repo.host.replace(/\.(com|org|io)$/, "") : "";

  return (
    <div className={`flex items-center gap-2 ${inline ? "shrink-0" : "min-w-0 border-b border-white/[0.07] px-4 py-1.5"}`}>
      {attach.repo && (
        <a href={attach.repo.url} target="_blank" rel="noreferrer" title={attach.repo.url}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 py-0.5 pl-0.5 pr-2 text-[11px] text-neutral-300 transition-colors hover:border-white/25 hover:text-white">
          <BrandIcon slug={hostSlug} icons={icons} size={20} />
          <span className={inline ? "whitespace-nowrap" : "max-w-[180px] truncate"}>{attach.repo.name}</span>
        </a>
      )}
      {attach.tech.length > 0 && (
        <div className={`flex items-center gap-2 ${inline ? "shrink-0" : "min-w-0 overflow-x-auto"}`}>
          {attach.tech.map((s) => <BrandIcon key={s} slug={s} icons={icons} size={24} />)}
        </div>
      )}
    </div>
  );
}
