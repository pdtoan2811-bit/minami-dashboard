// Pluggable data source for the Metrics-page side panels (Task log, People, Trace-back, Analytics).
//
// These panels are personal by nature, so nothing is hard-coded. They load at request time from a
// JSON file you point to with the MINAMI_PANELS_FILE env var (absolute path). If it's unset or
// unreadable, every panel is simply empty and the UI shows a "connect a source" hint — the app still
// runs. Copy `panels.example.json` to your own file and wire it up:
//
//   MINAMI_PANELS_FILE=/absolute/path/to/panels.json
//
// The file's shape is the `Panels` type below; every field is optional. You can regenerate it from
// your own system (a task tracker, a notes vault, a CRM) with any script you like — this repo only
// reads it.
import fs from "node:fs";

export type Task = { id: string; title: string; project?: string; status?: string; priority?: string };
export type Person = { id: string; name: string; relation?: string; lastTouch?: string };
export type Trace = { id: string; chat: string; where?: string; at?: string };
export type Analytics = { activeProjects?: number; openTasks?: number; notesTotal?: number; captureRate7d?: number };

export type Panels = {
  taskLog?: Task[];
  people?: Person[];
  traceBack?: Trace[];
  analytics?: Analytics;
};

const EMPTY: Panels = {};

/** Read the panels JSON pointed to by MINAMI_PANELS_FILE. Returns {} on any error (never throws). */
export function getPanels(): Panels {
  const file = process.env.MINAMI_PANELS_FILE;
  if (!file) return EMPTY;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return (parsed && typeof parsed === "object") ? parsed as Panels : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** True when no MINAMI_PANELS_FILE is configured — the UI uses this to show the setup hint. */
export const panelsConfigured = () => Boolean(process.env.MINAMI_PANELS_FILE);
