// The dossier: one markdown file per run, appended to by each stage in turn.
//
// This module writes only the header and the occasional system note. **The stages themselves are
// written by the agents**, with ordinary file tools, in their own words. That's the point of the
// design rather than an implementation detail: the handoff between two roles is a document a human can
// read and correct, not a payload this app defines a schema for. A schema would have to be filled in
// by a model anyway, and then nobody could read the run without the app.
//
// Which is also why nothing here parses meaning out of the file. The one question code asks is "did
// this stage's heading appear", because a stage that finished having written nothing leaves a hole
// every later stage reads over. Everything else about the content is between the agents and you.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Product, TeamRun, TeamTemplate } from "./types";

export const RUNS_DIR = process.env.MINAMI_RUNS_DIR || path.join(os.homedir(), ".minami", "runs");

export function runDir(runId: string): string {
  return path.join(RUNS_DIR, runId);
}

export function dossierPath(runId: string): string {
  return path.join(runDir(runId), "dossier.md");
}

/**
 * Write the dossier's opening: what was asked, where, and by whom. Every stage reads this, so it
 * carries the paths — an agent working in its own home has no other way to know where the workspace
 * or the record is.
 */
export function initDossier(run: TeamRun, product: Product, template: TeamTemplate): void {
  const when = new Date(run.createdAt).toISOString().slice(0, 16).replace("T", " ");
  const body = `# ${run.title}

> Run \`${run.id}\` · **${product.name}** · ${template.name} · started ${when}
> Workspace: ${product.workspace ? `\`${product.workspace}\`` : "_none — this product has no repo_"}
> Record: \`${product.recordPath}\`

Each role below appends **one** section, in order, and never edits another's. Read the whole file
before adding yours.

## The request

${run.brief}

---
`;
  fs.mkdirSync(runDir(run.id), { recursive: true });
  fs.writeFileSync(dossierPath(run.id), body);
}

export function readDossier(runId: string): string {
  try { return fs.readFileSync(dossierPath(runId), "utf8"); } catch { return ""; }
}

/**
 * A note from the runner rather than from an agent, marked as such.
 *
 * Attribution matters here more than it looks: the next stage reads this file as the record of what
 * the team decided, and an unlabelled machine-written line ("the QA stage failed") would be read as a
 * peer's finding. Prefixed and italicised so it's obviously not one.
 */
export function appendSystemNote(runId: string, text: string): void {
  try { fs.appendFileSync(dossierPath(runId), `\n_[runner] ${text}_\n`); } catch { /* the run still stands */ }
}

/** The `## ` headings currently in the file, in order. */
export function sections(md: string): string[] {
  return md
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim());
}

/**
 * Did this stage actually write its section?
 *
 * Compared loosely — case-insensitive, punctuation-tolerant — because the heading is copied by a model
 * from a brief, and failing a stage over a smart quote or a missing en-dash would be the kind of
 * brittleness that makes people stop trusting the status column. A near-miss is a match; silence
 * isn't.
 */
export function hasSection(md: string, section: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const want = norm(section);
  return sections(md).some((h) => {
    const got = norm(h);
    return got === want || got.startsWith(want) || want.startsWith(got);
  });
}
