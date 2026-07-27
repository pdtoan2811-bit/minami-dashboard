// Extract a curated set of brand/tech icons from simple-icons into public/tech-icons.json so the app
// can render them offline (no runtime dep, no network). Re-run after adding a slug to WANT:
//   node bin/build-tech-icons.mjs
import * as SI from "simple-icons";
import fs from "node:fs";

const bySlug = {};
for (const v of Object.values(SI)) if (v && v.slug && v.path) bySlug[v.slug] = v;

// simple-icons slugs we care about (git hosts, clouds, data stores, langs, frameworks, SaaS, office).
const WANT = [
  // git hosts & VCS
  "github", "gitlab", "bitbucket", "gitea", "git",
  // commerce / payments
  "shopify", "stripe", "paypal", "woocommerce", "square", "adyen", "klarna",
  // data warehouses / analytics
  "clickhouse", "googlebigquery", "snowflake", "databricks", "duckdb", "dbt", "apacheairflow", "apachespark", "tableau", "looker", "metabase",
  // clouds / hosting / infra
  "googlecloud", "amazonwebservices", "microsoftazure", "cloudflare", "vercel", "netlify", "digitalocean", "heroku", "railway", "render", "flydotio", "linode",
  "docker", "kubernetes", "terraform", "ansible", "githubactions", "nginx", "apache", "pulumi",
  // databases / stores / streaming
  "postgresql", "mysql", "mariadb", "mongodb", "redis", "sqlite", "supabase", "planetscale", "neon", "cockroachlabs",
  "elasticsearch", "apachekafka", "rabbitmq", "prometheus", "grafana", "datadog",
  // JS/TS frameworks & tooling
  "nextdotjs", "react", "vuedotjs", "svelte", "angular", "solid", "qwik", "nuxt", "remix", "astro", "vite", "webpack", "esbuild", "turborepo",
  "tailwindcss", "bootstrap", "mui", "chakraui", "sass", "redux", "prisma", "drizzle", "graphql", "trpc", "apollographql",
  "nestjs", "express", "fastify", "deno", "bun", "nodedotjs", "vitest", "jest", "cypress", "playwright", "storybook", "eslint", "prettier",
  // languages
  "typescript", "javascript", "python", "go", "rust", "ruby", "php", "java", "kotlin", "swift", "dart", "flutter", "cplusplus", "c", "csharp", "dotnet", "scala", "elixir", "r",
  // backend frameworks
  "django", "flask", "fastapi", "rubyonrails", "laravel", "spring", "dotnet",
  // AI / ML
  "openai", "anthropic", "claude", "huggingface", "langchain", "ollama", "pytorch", "tensorflow", "pandas", "numpy", "jupyter",
  // SaaS / observability / comms
  "firebase", "sentry", "posthog", "segment", "twilio", "sendgrid", "mailchimp", "algolia", "meilisearch", "auth0", "clerk", "okta",
  // office / productivity / collaboration
  "slack", "discord", "notion", "linear", "jira", "confluence", "trello", "asana", "clickup", "zoom", "googlemeet",
  "googledocs", "googlesheets", "googleslides", "googledrive", "googlecalendar", "gmail", "googleforms", "googlekeep",
  "figma", "miro", "loom", "obsidian", "airtable", "zapier", "make", "hubspot", "salesforce", "intercom", "zendesk",
  "microsoftexcel", "microsoftword", "microsoftoutlook", "microsoftteams", "microsoftsharepoint",
];

const out = {};
const missing = [];
for (const s of WANT) {
  const i = bySlug[s];
  if (i) out[s] = { title: i.title, hex: i.hex, path: i.path };
  else missing.push(s);
}

// Merge hand-authored icons for brands simple-icons doesn't ship (trademark removals like Slack,
// OpenAI, MS Office). Add them to bin/extra-icons.json as { slug: { title, hex, path } }.
// Anything still missing renders as a lettermark tile in the UI, so nothing ever breaks.
try {
  const extra = JSON.parse(fs.readFileSync("bin/extra-icons.json", "utf8"));
  for (const [slug, def] of Object.entries(extra)) if (def && def.path && def.hex) { out[slug] = def; }
} catch { /* no extras */ }

fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/tech-icons.json", JSON.stringify(out));
console.log(`wrote public/tech-icons.json — ${Object.keys(out).length} icons` + (missing.length ? `, still lettermark-only: ${missing.join(", ")}` : ""));
