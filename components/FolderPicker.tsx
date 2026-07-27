"use client";
// Modal filesystem browser. Two uses:
//  • folder mode (default): choose a working directory to start a new topic → "Start chat here".
//  • file mode (pickFiles): also lists files; clicking a file returns its path (used to attach a file
//    to a chat message). Bento is local, so it reads the machine's filesystem via /api/fs/list.
import { useEffect, useState } from "react";

type Dir = { name: string; path: string; git: boolean; pkg: boolean };
type FileEntry = { name: string; path: string };
type Data = { path: string; parent: string | null; home: string; dirs: Dir[]; files?: FileEntry[]; error?: string };

export default function FolderPicker({ onPick, onClose, pickFiles = false, start = "" }: { onPick: (p: string, label?: string) => void; onClose: () => void; pickFiles?: boolean; start?: string }) {
  const [path, setPath] = useState<string>(start);
  const [data, setData] = useState<Data | null>(null);
  const [manual, setManual] = useState(start);

  useEffect(() => {
    let a = true;
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (pickFiles) params.set("files", "1");
    fetch(`/api/fs/list?${params}`).then((r) => r.json()).then((d: Data) => { if (a) { setData(d); setManual(d.path); } }).catch(() => {});
    return () => { a = false; };
  }, [path, pickFiles]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="text-lg">{pickFiles ? "📎" : "📂"}</span>
          <h2 className="text-sm font-semibold text-neutral-100">{pickFiles ? "Attach a file" : "Start a new topic"}</h2>
          <button onClick={onClose} className="ml-auto rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-white/10">✕</button>
        </div>

        <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
          <button onClick={() => data?.parent && setPath(data.parent)} disabled={!data?.parent} className="rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10 disabled:opacity-30">↑ up</button>
          <button onClick={() => data && setPath(data.home)} className="rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10">~ home</button>
          <input value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setPath(manual.trim()); }}
            placeholder="/absolute/path" className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-neutral-200 outline-none focus:border-[var(--sakura)]/60" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {!data ? <p className="p-3 text-sm text-neutral-500">Reading…</p> : (
            <>
              {data.dirs.map((d) => (
                <button key={d.path} onClick={() => setPath(d.path)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/10">
                  <span className="text-neutral-500">{d.git ? "◆" : "▸"}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{d.name}</span>
                  {d.git && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-neutral-400">git</span>}
                  {d.pkg && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-neutral-400">npm</span>}
                </button>
              ))}
              {pickFiles && (data.files || []).map((f) => (
                <button key={f.path} onClick={() => onPick(f.path)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--sakura)]/10">
                  <span className="text-neutral-500">≡</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-300">{f.name}</span>
                </button>
              ))}
              {data.dirs.length === 0 && (!pickFiles || (data.files || []).length === 0) && <p className="p-3 text-sm text-neutral-500">{data.error ? "Can’t read this folder." : "Empty."}</p>}
            </>
          )}
        </div>

        {!pickFiles && (
          <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
            {/* CLI users: just start a session (defaults to home) without browsing to a folder. */}
            <button onClick={() => data && onPick(data.home, "CLI")} title="Start a session without choosing a folder (uses your home directory)"
              className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-white/10">No folder →</button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-500">{data?.path || "…"}</span>
            <button onClick={() => data?.path && onPick(data.path)} disabled={!data?.path}
              className="shrink-0 rounded-lg bg-[var(--sakura)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">Start chat here</button>
          </div>
        )}
      </div>
    </div>
  );
}
