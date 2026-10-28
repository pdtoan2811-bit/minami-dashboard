"use client";
// The Ask line's three small jobs (§37): say which project an ask will land in BEFORE it is sent,
// split a numbered multi-ask into separate chats, and start a chat without a panel open first.
// No model call anywhere here — a project name in the text and a numbered list are both literal, and
// a guess that shows itself before sending can be corrected with one tap.
import type { ProjectRef } from "@/lib/use-threads";

const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ");

/** The project the text names, longest name first ("ecvisionContent" beats "ecvision"). */
export function guessProject(text: string, projects: ProjectRef[]): ProjectRef | null {
  const t = " " + norm(text).replace(/[^a-z0-9 ]+/g, " ") + " ";
  const names = projects.flatMap((p) => {
    const n = norm(p.project);
    const spaced = norm(p.project.replace(/([a-z])([A-Z])/g, "$1 $2"));
    const joined = n.replace(/ /g, "");
    return [...new Set([n, spaced, joined])].map((k) => ({ k, p }));
  }).sort((a, b) => b.k.length - a.k.length);
  for (const { k, p } of names) if (k.length >= 4 && t.includes(" " + k + " ")) return p;
  return null;
}

/** A numbered list of 2+ asks → one string per ask, each carrying any lead-in line as context. */
export function splitAsks(text: string): string[] {
  const lines = text.split("\n");
  const items: string[] = [];
  const lead: string[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*\d+[.)]\s+(.*\S)/);
    if (m) items.push(m[1]);
    else if (items.length && l.trim()) items[items.length - 1] += "\n" + l.trim();
    else if (!items.length && l.trim()) lead.push(l.trim());
  }
  if (items.length < 2 || items.some((x) => x.length < 6)) return [];
  const ctx = lead.join(" ");
  return items.map((x) => (ctx ? `${ctx}\n\n${x}` : x));
}

/** Start a chat in a project and open it as a bento tab. Its own worktree when the folder is a repo,
 *  like a Today hand-off — a fresh ask beside other running chats would otherwise share their tree. */
export async function startAsk(p: ProjectRef, text: string, opts: { mode?: string; model?: string | null; open?: boolean } = {}): Promise<{ key: string; sid: string | null }> {
  let cwd = p.cwd;
  try {
    const w = await (await fetch("/api/worktree", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "isolate", cwd: p.cwd, label: "chat" }) })).json();
    if (w?.isolated?.dir) cwd = w.isolated.dir;
  } catch { /* the shared folder still works */ }
  const key = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const r = await fetch("/api/agent/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, cwd, message: text, mode: opts.mode, model: opts.model ?? undefined }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `send ${r.status}`);
  if (opts.open === false) return { key, sid: null };
  // Open it by session id, the way a notification link does (`minami:open-chat` waits for the list to
  // have it). The id arrives with the SDK's init a second or two after the send.
  let sid: string | null = (await r.json().catch(() => ({})))?.sessionId ?? null;
  for (let i = 0; !sid && i < 30; i++) {
    await new Promise((res) => setTimeout(res, 700));
    sid = (await (await fetch(`/api/threads?key=${encodeURIComponent(key)}`)).json().catch(() => ({})))?.sessionId ?? null;
  }
  if (sid) window.dispatchEvent(new CustomEvent("minami:open-chat", { detail: sid }));
  return { key, sid };
}
