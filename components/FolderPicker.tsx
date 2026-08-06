"use client";
// Modal filesystem browser. Two uses:
//  • folder mode (default): choose a working directory to start a new topic → "Start chat here".
//  • file mode (pickFiles): also lists files; clicking a file returns its path (used to attach a file
//    to a chat message). Bento is local, so it reads the machine's filesystem via /api/fs/list.
//
// Folder mode opens on **Recent**, not on the filesystem. Browsing to a folder is the honest way to
// reach a NEW topic, but it's the wrong default for the common case: nearly every "new topic" is
// another chat in a folder you already work in, and making that a directory walk from `~` every time
// charged the frequent case the cost of the rare one. The ranked list (lib/topic-rank.ts) answers
// "where am I working" directly; Browse is one tab away and unchanged.
import { useEffect, useState } from "react";
import { ProjectIcon } from "@/components/ProjectIcon";
import type { RecentTopic } from "@/lib/topic-rank";

type Dir = { name: string; path: string; git: boolean; pkg: boolean };
type FileEntry = { name: string; path: string };
type Data = { path: string; parent: string | null; home: string; dirs: Dir[]; files?: FileEntry[]; error?: string };

// Local rather than imported: the existing copies live in `app/page.tsx` and `lib/agents/client.ts`,
// and reaching into the agents subsystem from a core shell component would add a module-map edge that
// misrepresents what depends on what. Six lines is the cheaper of the two prices.
const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
function ago(ts: number): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function FolderPicker({ onPick, onClose, pickFiles = false, start = "", recents = [] }: { onPick: (p: string, label?: string) => void; onClose: () => void; pickFiles?: boolean; start?: string; recents?: RecentTopic[] }) {
  const [path, setPath] = useState<string>(start);
  // Recent is the default only when there IS one — a fresh install, or a box whose every topic is too
  // thin to rank, must not open on an empty panel with the real picker hidden behind a tab.
  const showRecent = !pickFiles && recents.length > 0;
  const [tab, setTab] = useState<"recent" | "browse">(showRecent ? "recent" : "browse");
  const [data, setData] = useState<Data | null>(null);
  const [manual, setManual] = useState(start);
  const [busy, setBusy] = useState(false);
  const [mkErr, setMkErr] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0); // bump to refetch the same path after creating something

  useEffect(() => {
    let a = true;
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (pickFiles) params.set("files", "1");
    fetch(`/api/fs/list?${params}`).then((r) => r.json()).then((d: Data) => { if (a) { setData(d); setManual(d.path); } }).catch(() => {});
    return () => { a = false; };
  }, [path, pickFiles, nudge]);

  // Escape dismisses the picker — and must not reach the page underneath, where the window-level
  // handler reads Escape as "close the whole chat panel". Registered in CAPTURE so it runs before that
  // handler whatever the mount order, and it marks the event handled (`preventDefault`) as well as
  // stopping it, since the page also treats a defaultPrevented Escape as already spoken for. Same
  // pattern, and the same reason, as components/BrowserLightbox.tsx.
  //
  // This covers the attach picker too: that's this component with `pickFiles`, mounted from inside a
  // pane, so before this it was one keystroke from "attach a file" to "the conversation is gone".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // The list route reports a missing directory by echoing the requested path back WITH an `error`, so
  // `data.path` alone never meant "this folder is real". Trusting it is what let you start a topic in a
  // folder that didn't exist: the picker closed happily, and the session died later in the SDK spawn
  // with a cryptic message and no folder, no transcript, and no tile to show for it.
  const missing = !!data?.error;
  const canStart = !!data?.path && !missing;

  const createFolder = async (target: string) => {
    setBusy(true); setMkErr(null);
    try {
      const r = await fetch("/api/fs/mkdir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) });
      const d = await r.json();
      if (d?.error) { setMkErr(d.error); return; }
      // Navigate to it if we're not already sitting there; otherwise just refetch so the (now real)
      // folder loses its error state and "Start chat here" comes alive.
      if (d.path === path) setNudge((n) => n + 1); else setPath(d.path);
    } catch (e) {
      setMkErr(String((e as Error)?.message || e));
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      {/* FIXED height, not `max-h`. Sized to content, this box changed height on every tab switch and
          every step into a different folder — and because it's centred, a height change moves it
          vertically too, so the row under the cursor slid out from under it and the tabs you were
          aiming at drifted. One dimension for every state: the list inside scrolls instead. Capped in
          rem as well as vh so a tall monitor doesn't stretch it into a column of empty space. */}
      <div onClick={(e) => e.stopPropagation()} className="flex h-[70vh] max-h-[34rem] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="text-lg">{pickFiles ? "📎" : "📂"}</span>
          <h2 className="text-sm font-semibold text-neutral-100">{pickFiles ? "Attach a file" : "Start a new topic"}</h2>
          <button onClick={onClose} className="ml-auto rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-white/10">✕</button>
        </div>

        {/* Two ways to answer one question, so neither is buried in the other. Rendered only when a
            ranked list exists — otherwise this is the plain picker it has always been. */}
        {showRecent && (
          <div className="flex items-center gap-1 border-b border-white/[0.07] px-3 py-2">
            {([["recent", "Recent"], ["browse", "Browse"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${tab === id ? "bg-[var(--sakura)]/15 text-[var(--sakura)]" : "text-neutral-400 hover:bg-white/10 hover:text-neutral-200"}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {tab === "recent" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {recents.map((t) => (
              <button key={t.cwd} onClick={() => onPick(t.cwd, t.name)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/10">
                <ProjectIcon name={t.name} icon={t.icon} size={26} active={t.active} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm text-neutral-100">{t.name}</span>
                    {/* A topic with a turn in flight is the one you most likely meant. */}
                    {t.active && <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] text-emerald-300">live</span>}
                  </span>
                  {/* `why` is the rank made legible — "4 chats over 3 days" is the actual reason this
                      sits above a bigger single-day folder. Without it the order looks arbitrary. */}
                  <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{t.why} · {shortPath(t.cwd)}</span>
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-neutral-600">{ago(t.last)}</span>
              </button>
            ))}
          </div>
        ) : (<>

        <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
          <button onClick={() => data?.parent && setPath(data.parent)} disabled={!data?.parent} className="rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10 disabled:opacity-30">↑ up</button>
          <button onClick={() => data && setPath(data.home)} className="rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10">~ home</button>
          <input value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setPath(manual.trim()); }}
            placeholder="/absolute/path" className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-neutral-200 outline-none focus:border-[var(--sakura)]/60" />
          {/* Create a sub-folder in the folder you're looking at — the discoverable half of "give this
              topic its own folder". The banner below covers the other half (a path typed by hand). */}
          {!pickFiles && !missing && data && (
            <button onClick={() => {
              const name = window.prompt(`New folder inside ${data.path}`)?.trim();
              if (name) createFolder(`${data.path.replace(/\/$/, "")}/${name}`);
            }} disabled={busy} title="Create a new folder here"
              className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10 disabled:opacity-40">＋ folder</button>
          )}
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
              {/* A missing folder used to render as the same vague "Can't read this folder." as a
                  permissions problem, while the Start button stayed enabled underneath. Name the actual
                  problem and offer the fix. */}
              {missing && (
                <div className="m-2 rounded-lg border border-[var(--sakura)]/30 bg-[var(--sakura)]/[0.06] p-3">
                  <p className="text-xs text-neutral-200">
                    {/^ENOENT/.test(data.error || "") ? "This folder doesn’t exist yet." : "Can’t read this folder."}
                  </p>
                  <p className="mt-1 break-all font-mono text-[10px] text-neutral-500">{data.path}</p>
                  {/^ENOENT/.test(data.error || "") && !pickFiles && (
                    <button onClick={() => createFolder(data.path)} disabled={busy}
                      className="mt-2 rounded-md bg-[var(--sakura)] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                      {busy ? "Creating…" : "Create this folder"}
                    </button>
                  )}
                  {mkErr && <p className="mt-2 text-[11px] text-red-400">{mkErr}</p>}
                </div>
              )}
              {!missing && data.dirs.length === 0 && (!pickFiles || (data.files || []).length === 0) && <p className="p-3 text-sm text-neutral-500">Empty.</p>}
            </>
          )}
        </div>

        {!pickFiles && (
          <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
            {/* CLI users: just start a session (defaults to home) without browsing to a folder. */}
            <button onClick={() => data && onPick(data.home, "CLI")} title="Start a session without choosing a folder (uses your home directory)"
              className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-white/10">No folder →</button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-500">{data?.path || "…"}</span>
            <button onClick={() => canStart && onPick(data!.path)} disabled={!canStart}
              title={missing ? "That folder doesn’t exist yet — create it first" : "Start a chat in this folder"}
              className="shrink-0 rounded-lg bg-[var(--sakura)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">Start chat here</button>
          </div>
        )}
        </>)}
      </div>
    </div>
  );
}
