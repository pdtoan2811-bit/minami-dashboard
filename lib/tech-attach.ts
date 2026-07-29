// Server-only: figure out what's attached to a topic — its git repo and the tech/brand icons it uses.
// Detection reads .git/config, package.json, and config files; on top of that, a curated assignment
// store (~/.minami-bento/icons.json, maintained by the `bento-icons` skill) can add or lead icons
// that can't be auto-detected (Slack, Google Docs, a company tool…). Assigned icons come first.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Attach = { repo: { url: string; host: string; name: string } | null; tech: string[]; icon?: string };
/** `icon` is the topic's 3D glyph (a filename in /public/icons), NOT a tech slug — it's what the tile
 *  and the rail aim at. Same store, because it's the same act of curation. */
export type IconStore = Record<string, { icons?: string[]; primary?: string; icon?: string }>;

const STORE = path.join(os.homedir(), ".minami-bento", "icons.json");

// npm dependency (exact or prefix) → tech-icons slug.
const DEP_SLUG: [string, string][] = [
  ["next", "nextdotjs"], ["react", "react"], ["vue", "vuedotjs"], ["svelte", "svelte"], ["@angular", "angular"],
  ["solid-js", "solid"], ["@builder.io/qwik", "qwik"], ["@remix-run", "remix"], ["nuxt", "nuxt"], ["astro", "astro"],
  ["vite", "vite"], ["webpack", "webpack"], ["esbuild", "esbuild"], ["turbo", "turborepo"],
  ["tailwindcss", "tailwindcss"], ["bootstrap", "bootstrap"], ["@mui", "mui"], ["@chakra-ui", "chakraui"], ["sass", "sass"],
  ["@reduxjs", "redux"], ["prisma", "prisma"], ["drizzle-orm", "drizzle"], ["graphql", "graphql"], ["@trpc", "trpc"], ["@apollo", "apollographql"],
  ["@nestjs", "nestjs"], ["express", "express"], ["fastify", "fastify"], ["typescript", "typescript"],
  ["vitest", "vitest"], ["jest", "jest"], ["cypress", "cypress"], ["@playwright", "playwright"], ["@storybook", "storybook"], ["eslint", "eslint"], ["prettier", "prettier"],
  ["@clickhouse", "clickhouse"], ["clickhouse", "clickhouse"], ["@google-cloud/bigquery", "googlebigquery"], ["@google-cloud", "googlecloud"],
  ["@aws-sdk", "amazonwebservices"], ["aws-sdk", "amazonwebservices"], ["@azure", "microsoftazure"],
  ["@shopify", "shopify"], ["shopify", "shopify"], ["stripe", "stripe"], ["@paypal", "paypal"], ["twilio", "twilio"], ["@sendgrid", "sendgrid"],
  ["pg", "postgresql"], ["postgres", "postgresql"], ["mysql", "mysql"], ["mysql2", "mysql"], ["mariadb", "mariadb"],
  ["mongodb", "mongodb"], ["mongoose", "mongodb"], ["ioredis", "redis"], ["redis", "redis"], ["better-sqlite3", "sqlite"],
  ["@supabase", "supabase"], ["@planetscale", "planetscale"], ["@neondatabase", "neon"], ["snowflake-sdk", "snowflake"], ["@databricks", "databricks"], ["duckdb", "duckdb"],
  ["kafkajs", "apachekafka"], ["amqplib", "rabbitmq"], ["@elastic/elasticsearch", "elasticsearch"], ["meilisearch", "meilisearch"], ["algoliasearch", "algolia"],
  ["firebase", "firebase"], ["@sentry", "sentry"], ["posthog", "posthog"], ["@segment", "segment"], ["analytics-node", "segment"],
  ["openai", "openai"], ["@anthropic-ai", "anthropic"], ["langchain", "langchain"], ["ollama", "ollama"], ["@huggingface", "huggingface"],
  ["@clerk", "clerk"], ["@auth0", "auth0"], ["next-auth", "auth0"],
];

// filename present in the project root → slug.
const FILE_SLUG: [string, string][] = [
  ["Dockerfile", "docker"], ["docker-compose.yml", "docker"], ["docker-compose.yaml", "docker"], ["compose.yaml", "docker"],
  ["vercel.json", "vercel"], ["netlify.toml", "netlify"], ["fly.toml", "flydotio"], ["render.yaml", "render"],
  ["go.mod", "go"], ["Cargo.toml", "rust"], ["Gemfile", "ruby"], ["composer.json", "php"], ["deno.json", "deno"], ["deno.jsonc", "deno"],
  ["bun.lockb", "bun"], ["requirements.txt", "python"], ["pyproject.toml", "python"], ["manage.py", "django"],
  ["pom.xml", "java"], ["build.gradle", "java"], ["Package.swift", "swift"], ["pubspec.yaml", "flutter"],
];

function readAssignments(): IconStore {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}

function parseGit(cwd: string): { url: string; host: string; name: string } | null {
  try {
    const cfg = fs.readFileSync(path.join(cwd, ".git", "config"), "utf8");
    const m = cfg.match(/url\s*=\s*(.+)/);
    if (!m) return null;
    let raw = m[1].trim().replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://").replace(/\.git$/, "");
    const u = new URL(raw);
    const name = u.pathname.replace(/^\//, "");
    return { url: `https://${u.host}/${name}`, host: u.host, name };
  } catch { return null; }
}

function detect(cwd: string): { repo: Attach["repo"]; slugs: string[] } {
  const slugs = new Set<string>();
  const repo = parseGit(cwd);
  if (repo) { const h = repo.host.replace(/\.(com|org|io)$/, ""); slugs.add(h); }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const [needle, slug] of DEP_SLUG) if (deps.some((d) => d === needle || d.startsWith(needle))) slugs.add(slug);
  } catch { /* none */ }
  try {
    const names = new Set(fs.readdirSync(cwd));
    for (const [file, slug] of FILE_SLUG) if (names.has(file)) slugs.add(slug);
    if ([...names].some((n) => n.endsWith(".tf"))) slugs.add("terraform");
    if (names.has(".github")) { try { if (fs.existsSync(path.join(cwd, ".github", "workflows"))) slugs.add("githubactions"); } catch { /* perm */ } }
  } catch { /* perm */ }
  return { repo, slugs: [...slugs] };
}

// Detect + merge the curated assignment store. Assigned icons lead, then detected, deduped.
export function getAttach(cwd: string, project?: string): Attach {
  if (!cwd || !path.isAbsolute(cwd)) return { repo: null, tech: [] };
  const { repo, slugs } = detect(cwd);
  const store = readAssignments();
  const key = project || cwd.split("/").filter(Boolean).pop() || "";
  const assigned = store[key]?.icons || store[cwd]?.icons || [];
  const primary = store[key]?.primary || store[cwd]?.primary;
  const ordered = [...(primary ? [primary] : []), ...assigned, ...slugs];
  const tech = [...new Set(ordered)].slice(0, 10);
  return { repo, tech, icon: store[key]?.icon || store[cwd]?.icon };
}
