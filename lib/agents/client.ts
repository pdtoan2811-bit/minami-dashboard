// Client-side types and fetch helpers for the agent view.
//
// Separate from the server modules on purpose: lib/agents/store.ts and friends import node:fs, so a
// component that pulled a type from them would drag the filesystem into the browser bundle. This file
// imports nothing but types, which TypeScript erases — so it's safe from either side.
import type { AgentDef, AgentTask } from "./types";
import type { FolderReport } from "./scaffold";

/** An agent as `/api/agents` returns it — the registry row joined to what it's doing right now. */
export type AgentRow = AgentDef & {
  live: boolean;
  busy: boolean;
  phase: string;
  label: string;
  runningTask: AgentTask | null;
  recentTasks: AgentTask[];
};

export type { AgentDef, AgentTask, FolderReport };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || (d as { error?: string })?.error) throw new Error((d as { error?: string })?.error || `${r.status}`);
  return d as T;
}

export const fetchAgents = () => json<{ agents: AgentRow[] }>("/api/agents");

export const fetchAgent = (id: string) =>
  json<{ agent: AgentDef; stats: { sessions: number; tokensIn: number; tokensOut: number; cost: number; lastActivity: number }; home: FolderReport; tasks: AgentTask[] }>(
    `/api/agents/${id}`,
  );

export const createAgent = (body: Record<string, unknown>) =>
  json<{ agent: AgentDef; scaffold: { created: string[]; skipped: string[] }; adopted: boolean }>("/api/agents", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

export const patchAgent = (id: string, body: Record<string, unknown>) =>
  json<{ agent: AgentDef }>(`/api/agents/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

export const removeAgent = (id: string) =>
  json<{ ok: boolean; keptFolder: string }>(`/api/agents/${id}`, { method: "DELETE" });

export const inspectFolder = (p: string) =>
  json<{ report: FolderReport }>(`/api/agents/inspect?path=${encodeURIComponent(p)}`);

export const startOnboarding = (id: string) =>
  json<{ ok: boolean; key: string }>(`/api/agents/${id}/onboard`, { method: "POST" });

export const fetchHistory = (id: string) =>
  json<{ sessions: (import("./history").AgentSession)[] }>(`/api/agents/${id}/history`);

export const fetchTasks = (id: string) => json<{ tasks: AgentTask[] }>(`/api/agents/${id}/tasks`);

export const assignTask = (id: string, body: Record<string, unknown>) =>
  json<{ task: AgentTask }>(`/api/agents/${id}/tasks`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

export const stopTask = (taskId: string) =>
  json<{ ok: boolean; task: AgentTask }>(`/api/agents/tasks/${taskId}`, { method: "DELETE" });

export const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

export const ago = (ms: number): string => {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
