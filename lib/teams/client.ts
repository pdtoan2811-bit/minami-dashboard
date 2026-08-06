// Browser-side types and fetchers for the Teams view.
//
// Separate from the server modules for the same reason lib/agents/client.ts is: store.ts, runs.ts and
// run.ts all import node:fs, so a component pulling a type from them would drag the filesystem into
// the browser bundle. This file imports nothing but types, which TypeScript erases.
import type { AgentDef } from "../agents/types";
import type { TemplateSummary } from "./templates";
import type { Product, TeamRun } from "./types";

export type ProductRow = Product & {
  template: TemplateSummary | null;
  runs: TeamRun[];
  running: number;
};

export type { AgentDef, Product, TeamRun, TemplateSummary };
export type { RunStage } from "./types";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || (d as { error?: string })?.error) throw new Error((d as { error?: string })?.error || `${r.status}`);
  return d as T;
}

export const fetchTeams = () =>
  json<{ templates: TemplateSummary[]; products: ProductRow[]; recordsRoot: string }>("/api/teams");

export const fetchProduct = (id: string) =>
  json<{
    product: Product;
    template: TemplateSummary | null;
    team: { role: string; agentId: string; agent: AgentDef | null }[];
    runs: TeamRun[];
  }>(`/api/teams/${id}`);

export const createProduct = (body: Record<string, unknown>) =>
  json<{ product: Product; createdAgents: string[]; hook: { file: string; action: string } | null }>("/api/teams", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

export const removeProduct = (id: string) =>
  json<{ ok: boolean; keptRecord: string; unhooked: boolean }>(`/api/teams/${id}`, { method: "DELETE" });

export const patchProduct = (id: string, body: Record<string, unknown>) =>
  json<{ product: Product }>(`/api/teams/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

export const startRun = (productId: string, brief: string, title?: string) =>
  json<{ run: TeamRun }>("/api/teams/runs", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId, brief, title }),
  });

export const fetchRun = (runId: string) =>
  json<{ run: TeamRun; dossier: string; dossierPath: string }>(`/api/teams/runs/${runId}`);

export const stopRun = (runId: string) =>
  json<{ ok: boolean; run: TeamRun }>(`/api/teams/runs/${runId}`, { method: "DELETE" });

export const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Stage dot colours, shared by the tile strip and the run page so one status can't read two ways. */
export const STAGE_TONE: Record<string, string> = {
  pending: "bg-white/15",
  queued: "bg-white/15",
  running: "bg-[var(--sakura)] animate-pulse",
  done: "bg-emerald-400/70",
  failed: "bg-red-400/70",
  stopped: "bg-amber-400/60",
};
