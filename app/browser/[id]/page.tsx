"use client";
// The browser panel in its own OS window — `⧉` in the docked panel opens this.
//
// Worth it because the docked panel is always fighting the chat for width: a 1280×800 page rendered
// into ~40% of one pane in a 2×2 grid is a thumbnail. Popped out, it's a second monitor showing what
// Claude is looking at while you read the conversation in the main window.
//
// It attaches its OWN EventSource to the same server-side session rather than mirroring the parent tab.
// That works because `Session.subs` is a Set and `broadcast()` fans out to every subscriber
// (lib/agent/manager.ts) — so two windows on one session is already a supported case, and it means this
// window survives the parent tab being closed or reloaded. It also keeps the session alive: the idle
// reaper only fires when `subs.size === 0`.
//
// Read-only by design. The toolbar's "ask the agent" controls are hidden here (`live={false}`) — a
// second window quietly sending prompts into a session you're driving from another window is a good way
// to lose track of who asked for what.
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAgent, activityLabel, type AgentToolCall } from "@/lib/use-agent";
import { deriveBrowserState, isBrowserTool } from "@/lib/browser-view";
import BrowserPanel from "@/components/BrowserPanel";
import BrowserLightbox from "@/components/BrowserLightbox";

type DiskTurn = { role: "user" | "assistant"; text: string; tools: AgentToolCall[]; ts: number };

export default function PopOutBrowser() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const sessionId = params?.id && params.id !== "live" ? params.id : "";
  const cwd = search.get("cwd") || "";
  const agent = useAgent(sessionId ? "live:" + sessionId : "browser-popout");
  const [disk, setDisk] = useState<DiskTurn[]>([]);
  const [lightbox, setLightbox] = useState<number | null>(null);

  const attached = useRef(false);
  useEffect(() => {
    if (attached.current || !sessionId) return;
    attached.current = true;
    agent.attach(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // On-disk history, so the filmstrip isn't empty when this window opens mid-session (the live stream
  // only replays the in-flight turn, never past tool results — see manager.ts's subscribe()).
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const load = () => fetch(`/api/bento/session/${sessionId}`).then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.turns)) setDisk(d.turns); }).catch(() => {});
    load();
    // Only poll while this window is NOT streaming; once live, events carry the updates.
    if (agent.live) return () => { alive = false; };
    const iv = setInterval(load, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, agent.live]);

  const source = agent.live ? agent.turns : disk;
  const browser = useMemo(() => deriveBrowserState(source), [source]);
  const lastTool = source[source.length - 1]?.tools.at(-1);
  const busy = !!lastTool && isBrowserTool(lastTool.name) && !lastTool.done;
  const label = busy ? activityLabel(lastTool!.name, lastTool!.input) : browser.shots.at(-1)?.action;

  useEffect(() => {
    document.title = browser.title || browser.url || "Browser — Minami Bento";
  }, [browser.title, browser.url]);

  if (!sessionId) {
    return <main className="flex h-screen items-center justify-center bg-neutral-950 text-[12px] text-neutral-500">
      This window needs a session — reopen it from a chat&apos;s browser panel.
    </main>;
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <BrowserPanel
        state={browser} busy={busy} actionLabel={label} cwd={cwd}
        live={false} stacked={false}
        onOpenShot={setLightbox}
        onAsk={() => {}}
      />
      {lightbox !== null && browser.shots.length > 0 && (
        <BrowserLightbox
          shots={browser.shots} index={Math.min(lightbox, browser.shots.length - 1)} cwd={cwd}
          onIndex={setLightbox} onClose={() => setLightbox(null)}
        />
      )}
    </main>
  );
}
