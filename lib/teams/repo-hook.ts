// The one thing a product writes into your own repo: a marker-bounded block in its CLAUDE.md.
//
// Why there and not somewhere tidier. `CLAUDE.md` is loaded automatically by every Claude session
// whose cwd is that folder — a dashboard pane, a bare `claude` in a terminal, Minami spawning a
// headless session from Slack. So a team named there is a team that every one of those inherits,
// with no dependency on this app being involved or even running. Anywhere else (a .minami/ file, the
// product registry) and the knowledge stops at the dashboard's edge, which is exactly the
// folder-boundary problem the whole thing exists to solve.
//
// Bounded by markers so it can be rewritten in place when the team changes and removed cleanly when
// the product is deleted. Everything outside the markers is untouched — this edits a file a human owns.
import fs from "node:fs";
import path from "node:path";
import type { AgentDef } from "../agents/types";
import type { Product, TeamTemplate } from "./types";

const START = "<!-- minami:team start -->";
const END = "<!-- minami:team end -->";

/** Where `bin/team.mjs` lives, for the command written into the block. */
const DASHBOARD_DIR = process.env.MINAMI_DASHBOARD_DIR || process.cwd();

function block(product: Product, template: TeamTemplate, agents: Map<string, AgentDef>): string {
  const roster = template.roles
    .map((r) => {
      const a = agents.get(r.key);
      const where = r.needsWorkspace ? "works in this repo" : "works from the dossier only";
      return `| ${r.name} | \`${a?.id || r.key}\` | ${r.role} | ${where} |`;
    })
    .join("\n");

  const chain = template.chain.map((s) => s.role).join(" → ");

  return `${START}
## This repo has a team

**${product.name}** runs on the **${template.name}** template. A task assigned to the team is not one
conversation — it's one stage per role, each a separate session in that role's own folder with its own
memory and skills, passing a single dossier along:

\`\`\`
${chain}
\`\`\`

| Role | Agent | Owns | Workspace |
|---|---|---|---|
${roster}

- **Record:** \`${product.recordPath}\` — the durable, curated version. Read \`00-index.md\` there
  before assuming anything about this product's history; it's shorter than the code and more current
  than your memory.
- **Route work to the team:** \`node ${path.join(DASHBOARD_DIR, "bin", "team.mjs")} run ${product.id} "the task"\`
- **Watch it:** the dashboard's Teams view, or \`node ${path.join(DASHBOARD_DIR, "bin", "team.mjs")} run-status <runId>\`

A team run is unattended and takes minutes to tens of minutes. Don't start one for a task you could do
in this session — start one when the work genuinely wants a brief, a design, a test plan and a
sign-off that outlive the conversation.
${END}`;
}

/**
 * Write (or rewrite) the team block in the workspace's CLAUDE.md. Returns what it did, so the create
 * route can tell you a tracked file in your repo just changed rather than leaving you to find it in
 * `git status`.
 */
export function writeTeamBlock(
  product: Product,
  template: TeamTemplate,
  agents: Map<string, AgentDef>,
): { file: string; action: "created" | "updated" | "added" } | null {
  if (!product.workspace) return null;
  const file = path.join(product.workspace, "CLAUDE.md");
  const body = block(product, template, agents);

  let existing = "";
  try { existing = fs.readFileSync(file, "utf8"); } catch { /* no CLAUDE.md yet */ }

  if (!existing) {
    fs.writeFileSync(file, `# ${product.name}\n\n${body}\n`);
    return { file, action: "created" };
  }
  const from = existing.indexOf(START);
  const to = existing.indexOf(END);
  if (from >= 0 && to > from) {
    fs.writeFileSync(file, existing.slice(0, from) + body + existing.slice(to + END.length));
    return { file, action: "updated" };
  }
  // Appended rather than inserted at the top: the opening of a CLAUDE.md is the part a human wrote to
  // be read first, and pushing it below a generated block would be rude and confusing.
  fs.writeFileSync(file, `${existing.replace(/\s*$/, "")}\n\n${body}\n`);
  return { file, action: "added" };
}

/** Take the block out again, leaving the rest of the file exactly as it was. */
export function removeTeamBlock(workspace: string): boolean {
  const file = path.join(workspace, "CLAUDE.md");
  let existing = "";
  try { existing = fs.readFileSync(file, "utf8"); } catch { return false; }
  const from = existing.indexOf(START);
  const to = existing.indexOf(END);
  if (from < 0 || to <= from) return false;
  const next = (existing.slice(0, from) + existing.slice(to + END.length)).replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(file, next);
  return true;
}
