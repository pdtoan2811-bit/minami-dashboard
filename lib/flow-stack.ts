// What a run of tool calls was working IN — the stack, read off the calls themselves.
//
// The flow view already answers "what was it doing" (lib/flow-model.ts's `Act`: read, changed, ran…).
// This answers the orthogonal question "what was it doing it TO", and it answers it in icons, because
// that is the one part of a node the eye can take in without reading. Scanning a fifty-ask spine for
// "where did the Python work happen" is a text search today; with a stack row it is a glance.
//
// ── why this is derived from the CALLS, not from the project ────────────────────────────────────
// `lib/tech-attach.ts` already knows a topic's stack, and reusing it here was the obvious move — but
// it returns the same answer for every milestone in the session, so it would draw an identical row on
// every node and carry exactly zero information *inside* this view. The calls are what differ from ask
// to ask, so the calls are what this reads. A milestone that only touched `.py` shows python even in a
// TypeScript repo, which is the true and useful answer.
//
// ── rules, not a model, and deliberately incomplete ─────────────────────────────────────────────
// Same contract as the rest of the semantic layer: pure, synchronous, correct while a turn is still
// streaming, and never inventing a fact. An extension or command with no confident mapping contributes
// NOTHING rather than a guess — a wrong logo is worse than no logo, because a reader believes it. The
// tables below are therefore a whitelist, and every slug in them is one `public/tech-icons.json` ships
// or `components/BrandIcon.tsx` has a lettermark for, so nothing here can render as a broken tile.
import type { FlowTool } from "./flow-model";

/** File extension → the stack it implies. `.tsx` is two facts, not one, which is why these are lists. */
const EXT_SLUGS: Record<string, string[]> = {
  tsx: ["react", "typescript"],
  jsx: ["react", "javascript"],
  ts: ["typescript"], mts: ["typescript"], cts: ["typescript"],
  js: ["javascript"], mjs: ["javascript"], cjs: ["javascript"],
  py: ["python"],
  go: ["go"],
  rs: ["rust"],
  rb: ["ruby"],
  php: ["php"],
  java: ["java"],
  kt: ["kotlin"],
  swift: ["swift"],
  dart: ["dart"],
  vue: ["vuedotjs"],
  svelte: ["svelte"],
  astro: ["astro"],
  scss: ["sass"], sass: ["sass"],
  tf: ["terraform"], tfvars: ["terraform"],
  ipynb: ["jupyter"],
};

/** Filenames that are their own signal, extension or not. Matched on the BASENAME. */
const FILE_SLUGS: [RegExp, string][] = [
  [/^dockerfile/i, "docker"],
  [/^docker-compose\.ya?ml$/i, "docker"],
  [/^(package|package-lock)\.json$/i, "nodedotjs"],
  [/^(pnpm-lock\.yaml|yarn\.lock)$/i, "nodedotjs"],
  [/^bun\.lockb?$/i, "bun"],
  [/^(requirements\.txt|pyproject\.toml|setup\.py)$/i, "python"],
  [/^cargo\.(toml|lock)$/i, "rust"],
  [/^go\.(mod|sum)$/i, "go"],
  [/^gemfile/i, "ruby"],
  [/^composer\.json$/i, "php"],
  [/^tailwind\.config\./i, "tailwindcss"],
  [/^next\.config\./i, "nextdotjs"],
  [/^vite\.config\./i, "vite"],
  [/^tsconfig(\.\w+)?\.json$/i, "typescript"],
];

/** Shell commands → the stack they drive. Tested against the WHOLE command, not just its head: the
 *  meaningful part is routinely downstream of a `cd`/`&&`/pipe, exactly as `VERIFY_RE` found. */
const CMD_SLUGS: [RegExp, string][] = [
  [/\b(?:npm|npx|pnpm|yarn|node)\b/, "nodedotjs"],
  [/\bbun\b/, "bun"],
  [/\bdeno\b/, "deno"],
  [/\bgh\s+(?:pr|repo|release|issue|api|run)\b/, "github"],
  [/\bgit\b/, "git"],
  [/\bdocker(?:-compose)?\b/, "docker"],
  [/\bkubectl\b/, "kubernetes"],
  [/\bterraform\b/, "terraform"],
  [/\b(?:python3?|pip3?|pytest|ruff|mypy|uv)\b/, "python"],
  [/\bcargo\b/, "rust"],
  [/\bgo\s+(?:run|build|test|mod|get)\b/, "go"],
  [/\bbundle\b|\bgem\s+install\b|\brails\b/, "ruby"],
  [/\bpsql\b|\bpg_dump\b/, "postgresql"],
  [/\bmysql\b/, "mysql"],
  [/\bredis-cli\b/, "redis"],
  [/\bsqlite3\b/, "sqlite"],
  [/\bbq\s|\bbigquery\b/, "googlebigquery"],
  [/\bgcloud\b/, "googlecloud"],
  [/\baws\s/, "amazonwebservices"],
  [/\bvercel\b/, "vercel"],
  // NOT a `\bplaywright\b` rule. Measured on this session: `find … -iname "*playwright*"` and
  // `grep -rn playwright` both matched, and neither is Playwright being *used* — the word appears in
  // paths far more often than as a command. Real Playwright use arrives as an MCP call or as
  // `npx playwright`, and both are already covered.
];

/** MCP server → brand. The server half of `mcp__<server>__<verb>`, lowercased and stripped of the
 *  `claude_ai_` prefix the hosted connectors carry. */
const MCP_SLUGS: Record<string, string> = {
  playwright: "playwright",
  slack: "slack",
  shopify: "shopify",
  gmail: "gmail",
  google_drive: "googledrive",
  google_calendar: "googlecalendar",
  notion: "notion",
  linear: "linear",
  jira: "jira",
  figma: "figma",
  github: "github",
  sentry: "sentry",
  stripe: "stripe",
};

const mcpServer = (name: string): string | null => {
  const m = /^mcp__(.+?)__/.exec(name);
  return m ? m[1].toLowerCase().replace(/^claude_ai_/, "") : null;
};

/** Every path-shaped value a tool call carries. Deliberately NOT `pattern` in general — Grep's pattern
 *  is a regex, and `\.tsx?$` is not evidence that any `.tsx` file exists — but Glob's pattern IS a path
 *  glob, and `**​/*.py` is exactly the signal this wants. */
function pathsOf(t: FlowTool): string[] {
  const i = (t.input || {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["file_path", "notebook_path", "path", "glob"]) {
    if (typeof i[k] === "string") out.push(i[k] as string);
  }
  if (t.name === "Glob" && typeof i.pattern === "string") out.push(i.pattern as string);
  return out;
}

function slugsForPath(p: string): string[] {
  const base = p.split("/").pop() || "";
  for (const [re, slug] of FILE_SLUGS) if (re.test(base)) return [slug];
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_SLUGS[ext] || [];
}

/**
 * The stack a set of tool calls worked in, most-used first.
 *
 * Ranked by how many calls touched each slug rather than by first appearance: a milestone that read one
 * `.py` while editing nine `.tsx` is a React milestone, and the icon row has room for about five things
 * — so the order decides what survives the cap, and it should be decided by weight, not by accident of
 * which call happened to run first.
 */
export function stackOf(tools: FlowTool[], cap = 5): string[] {
  const count = new Map<string, number>();
  const bump = (s: string) => count.set(s, (count.get(s) || 0) + 1);

  for (const t of tools) {
    for (const p of pathsOf(t)) for (const s of slugsForPath(p)) bump(s);

    const cmd = (t.input as { command?: unknown })?.command;
    if (typeof cmd === "string" && cmd) {
      // First match per table entry only — `npm run build` should count node once, not once per token.
      for (const [re, slug] of CMD_SLUGS) if (re.test(cmd)) bump(slug);
    }

    const server = mcpServer(t.name);
    if (server && MCP_SLUGS[server]) bump(MCP_SLUGS[server]);
  }

  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([s]) => s);
}
