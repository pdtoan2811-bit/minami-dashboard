// Types for the plain-ESM archive helper.
//
// It is .mjs because the standalone receiver and launcher run it under bare node with no build step,
// and a .ts file cannot be imported there. This declaration is what lets the Next route import it
// without `any` — without it TypeScript infers the parameter shape from nothing and collapses the
// array types to `never[]`.
import type { Graph } from "../lib/canvas-graph";

export function archiveMeeting(input: {
  title: string;
  startedAt: number;
  minutes: number;
  graph: Graph;
  transcript?: string[];
  cost?: number;
  meetingId?: string;
}): string | null;
