// The module map rendered at /architecture.
//
// EVERY edge here was extracted from the source, not drawn from memory — static edges come from
// `from "..."` specifiers (@/ and relative), runtime edges from fetch()/EventSource() string
// literals naming an /api/ path. Regenerate after a refactor with:
//
//   python3 - <<'EOF'
//   import os,re,json
//   SKIP={"node_modules",".next",".next-dev",".next-uitest",".git","docs",".playwright-mcp"}
//   imp=re.compile(r'from\s+["\']([^"\']+)["\']')
//   api=re.compile(r'(?:fetch|EventSource)\(\s*[`"\']([^`"\']*?/api/[^`"\'?]*)')
//   for base in ("app","components","lib"):
//     for d,dirs,fs in os.walk(base):
//       dirs[:]=[x for x in dirs if x not in SKIP]
//       for f in fs:
//         if not f.endswith((".ts",".tsx")): continue
//         p=os.path.join(d,f); s=open(p,encoding="utf8",errors="replace").read()
//         print(p, sorted({m[2:] for m in imp.findall(s) if m.startswith("@/")}), sorted(set(api.findall(s))))
//   EOF
//
// Layers are columns; `row` is the vertical slot within a column. Both are hand-assigned rather
// than auto-laid-out, because a stable, readable arrangement beats a force-directed tangle that
// reshuffles on every render.

export type LayerId = "surface" | "component" | "route" | "core" | "runtime";

export type ModuleNode = {
  id: string;
  label: string;
  sub?: string;
  layer: LayerId;
  row: number;
  /** Highlighted as one of the three pipelines from docs/architecture.html. */
  pipeline?: "live" | "read" | "metrics";
};

/** kind: "import" = a static `from` specifier. "http" = a runtime fetch/EventSource call. */
export type ModuleEdge = { from: string; to: string; kind: "import" | "http"; label?: string };

export const LAYERS: { id: LayerId; label: string; hint: string }[] = [
  { id: "surface", label: "Surfaces", hint: "routes you can open" },
  { id: "component", label: "Components", hint: "client UI" },
  { id: "route", label: "API routes", hint: "server, node runtime" },
  { id: "core", label: "Core logic", hint: "lib/" },
  { id: "runtime", label: "Outside the app", hint: "disk, SDK, network" },
];

export const NODES: ModuleNode[] = [
  // ── surfaces ────────────────────────────────────────────────────────────
  { id: "app/page", label: "/", sub: "Bento grid + chat panes", layer: "surface", row: 0, pipeline: "read" },
  { id: "app/dashboard", label: "/dashboard", sub: "metrics cards", layer: "surface", row: 1, pipeline: "metrics" },
  { id: "app/settings", label: "/settings", sub: "local toggles", layer: "surface", row: 2 },
  { id: "app/layout", label: "layout.tsx", sub: "root shell", layer: "surface", row: 3 },
  { id: "app/architecture", label: "/architecture", sub: "this page", layer: "surface", row: 4 },

  // ── components ──────────────────────────────────────────────────────────
  { id: "c/Composer", label: "Composer", sub: "message input + mode", layer: "component", row: 0, pipeline: "live" },
  { id: "c/AskCard", label: "AskCard", sub: "AskUserQuestion wizard", layer: "component", row: 1, pipeline: "live" },
  { id: "c/BrowserPanel", label: "BrowserPanel", sub: "Playwright screenshots", layer: "component", row: 2, pipeline: "live" },
  { id: "c/Markdown", label: "Markdown", sub: "memoised renderer", layer: "component", row: 3 },
  { id: "c/FolderPicker", label: "FolderPicker", sub: "new-session cwd", layer: "component", row: 4 },
  { id: "c/AttachBar", label: "AttachBar", sub: "tech icons", layer: "component", row: 5 },
  { id: "c/BrandIcon", label: "BrandIcon", sub: "simple-icons", layer: "component", row: 6 },
  { id: "c/AccountStatus", label: "AccountStatus", sub: "fallback-account alert", layer: "component", row: 7 },
  { id: "c/AccountsPanel", label: "AccountsPanel", sub: "token-slayer pool", layer: "component", row: 8 },
  { id: "c/UsagePanel", label: "UsagePanel", sub: "per-machine totals", layer: "component", row: 9, pipeline: "metrics" },
  { id: "c/UsageHeatmap", label: "UsageHeatmap", sub: "calendar", layer: "component", row: 10, pipeline: "metrics" },
  { id: "c/RoutingFlow", label: "RoutingFlow", sub: "live turn feed", layer: "component", row: 11, pipeline: "metrics" },
  { id: "c/ModelRouting", label: "ModelRouting", sub: "pricing table", layer: "component", row: 12 },
  { id: "c/ProjectsPanel", label: "ProjectsPanel", sub: "cross-host checkpoints", layer: "component", row: 13, pipeline: "metrics" },
  { id: "c/Nav", label: "Nav", sub: "surface switcher", layer: "component", row: 14 },

  // ── api routes ──────────────────────────────────────────────────────────
  { id: "r/agent", label: "/api/agent/*", sub: "send · stream · stop\npermission · answer · mode · live", layer: "route", row: 0, pipeline: "live" },
  { id: "r/sessions", label: "/api/bento/sessions", sub: "grid list", layer: "route", row: 1, pipeline: "read" },
  { id: "r/session", label: "/api/bento/session/[id]", sub: "one transcript", layer: "route", row: 2, pipeline: "read" },
  { id: "r/enrich", label: "/api/bento/enrich", sub: "Haiku labels", layer: "route", row: 3 },
  { id: "r/attach", label: "/api/bento/attach*", sub: "tech detection", layer: "route", row: 4 },
  { id: "r/accounts", label: "/api/accounts", sub: "token-slayer bridge", layer: "route", row: 5 },
  { id: "r/fs", label: "/api/fs/list", sub: "folder browse", layer: "route", row: 6 },

  // ── core ────────────────────────────────────────────────────────────────
  { id: "l/manager", label: "agent/manager.ts", sub: "session registry · SDK query()", layer: "core", row: 0, pipeline: "live" },
  { id: "l/labels", label: "agent/labels.ts", sub: "activity phases + labels", layer: "core", row: 1, pipeline: "live" },
  { id: "l/useagent", label: "use-agent.ts", sub: "client SSE + reconnect", layer: "core", row: 2, pipeline: "live" },
  { id: "l/sessions", label: "claude-sessions.ts", sub: "incremental parser + caches", layer: "core", row: 3, pipeline: "read" },
  { id: "l/enrich", label: "bento-enrich.ts", sub: "semantic label cache", layer: "core", row: 4, pipeline: "read" },
  { id: "l/routing", label: "routing.ts", sub: "models + prices", layer: "core", row: 5 },
  { id: "l/sources", label: "sources.ts", sub: "machine labels", layer: "core", row: 6, pipeline: "metrics" },
  { id: "l/panels", label: "panels.ts", sub: "pluggable cards", layer: "core", row: 7 },
  { id: "l/techicons", label: "tech-icons.ts", sub: "icon lookup", layer: "core", row: 8 },
  { id: "l/techattach", label: "tech-attach.ts", sub: "repo sniffing", layer: "core", row: 9 },
  { id: "l/settings", label: "use-settings.ts", sub: "localStorage", layer: "core", row: 10 },
  { id: "l/notify", label: "use-notify.ts", sub: "away-tab alerts", layer: "core", row: 11 },

  // ── outside ─────────────────────────────────────────────────────────────
  { id: "x/sdk", label: "Agent SDK", sub: "spawns the claude CLI", layer: "runtime", row: 0, pipeline: "live" },
  { id: "x/jsonl", label: "~/.claude/projects", sub: "*.jsonl transcripts", layer: "runtime", row: 1, pipeline: "read" },
  { id: "x/bentocache", label: "~/.minami-bento", sub: "meta + turns + enrich cache", layer: "runtime", row: 2, pipeline: "read" },
  { id: "x/slayer", label: "token-slayer CLI", sub: "+ ~/.claude.json identity", layer: "runtime", row: 3 },
  { id: "x/metrics", label: "metrics server", sub: "Hetzner · Tailscale Funnel", layer: "runtime", row: 4, pipeline: "metrics" },
];

export const EDGES: ModuleEdge[] = [
  // surfaces → components (static imports)
  { from: "app/page", to: "c/Composer", kind: "import" },
  { from: "app/page", to: "c/AskCard", kind: "import" },
  { from: "app/page", to: "c/BrowserPanel", kind: "import" },
  { from: "app/page", to: "c/Markdown", kind: "import" },
  { from: "app/page", to: "c/FolderPicker", kind: "import" },
  { from: "app/page", to: "c/AttachBar", kind: "import" },
  { from: "app/page", to: "c/BrandIcon", kind: "import" },
  { from: "app/page", to: "c/Nav", kind: "import" },
  { from: "app/dashboard", to: "c/AccountsPanel", kind: "import" },
  { from: "app/dashboard", to: "c/UsagePanel", kind: "import" },
  { from: "app/dashboard", to: "c/UsageHeatmap", kind: "import" },
  { from: "app/dashboard", to: "c/RoutingFlow", kind: "import" },
  { from: "app/dashboard", to: "c/ModelRouting", kind: "import" },
  { from: "app/dashboard", to: "c/ProjectsPanel", kind: "import" },
  { from: "app/dashboard", to: "c/Nav", kind: "import" },
  { from: "app/settings", to: "c/Nav", kind: "import" },
  { from: "app/layout", to: "c/AccountStatus", kind: "import" },

  // surfaces / components → core
  { from: "app/page", to: "l/useagent", kind: "import" },
  { from: "app/page", to: "l/techicons", kind: "import" },
  { from: "app/page", to: "l/settings", kind: "import" },
  { from: "app/page", to: "l/notify", kind: "import" },
  { from: "app/dashboard", to: "l/panels", kind: "import" },
  { from: "app/settings", to: "l/settings", kind: "import" },
  { from: "c/AskCard", to: "l/useagent", kind: "import" },
  { from: "c/AttachBar", to: "l/techicons", kind: "import" },
  { from: "c/AttachBar", to: "c/BrandIcon", kind: "import" },
  { from: "l/techicons", to: "c/BrandIcon", kind: "import" },
  { from: "c/ModelRouting", to: "l/routing", kind: "import" },
  { from: "c/RoutingFlow", to: "l/routing", kind: "import" },
  { from: "c/RoutingFlow", to: "l/sources", kind: "import" },
  { from: "c/UsagePanel", to: "l/routing", kind: "import" },
  { from: "c/UsagePanel", to: "l/sources", kind: "import" },

  // client → API over HTTP/SSE (runtime, not an import)
  { from: "l/useagent", to: "r/agent", kind: "http", label: "SSE + POST" },
  { from: "l/useagent", to: "r/session", kind: "http" },
  { from: "app/page", to: "r/sessions", kind: "http", label: "5s poll" },
  { from: "app/page", to: "r/session", kind: "http" },
  { from: "app/page", to: "r/agent", kind: "http", label: "/live 1.5s" },
  { from: "app/page", to: "r/enrich", kind: "http" },
  { from: "app/page", to: "r/attach", kind: "http" },
  { from: "c/AttachBar", to: "r/attach", kind: "http" },
  { from: "c/FolderPicker", to: "r/fs", kind: "http" },
  { from: "c/AccountStatus", to: "r/accounts", kind: "http", label: "30s poll" },
  { from: "c/AccountsPanel", to: "r/accounts", kind: "http" },
  { from: "c/UsagePanel", to: "x/metrics", kind: "http", label: "SSE" },
  { from: "c/UsageHeatmap", to: "x/metrics", kind: "http" },
  { from: "c/RoutingFlow", to: "x/metrics", kind: "http" },
  { from: "c/ProjectsPanel", to: "x/metrics", kind: "http", label: "/projects" },

  // API routes → core
  { from: "r/agent", to: "l/manager", kind: "import" },
  { from: "r/sessions", to: "l/sessions", kind: "import" },
  { from: "r/session", to: "l/sessions", kind: "import" },
  { from: "r/enrich", to: "l/sessions", kind: "import" },
  { from: "r/enrich", to: "l/enrich", kind: "import" },
  { from: "r/attach", to: "l/techattach", kind: "import" },

  // core → core
  { from: "l/manager", to: "l/labels", kind: "import" },
  { from: "l/useagent", to: "l/labels", kind: "import" },
  { from: "l/sessions", to: "l/labels", kind: "import" },
  { from: "l/sessions", to: "l/enrich", kind: "import" },
  { from: "l/sessions", to: "l/routing", kind: "import" },

  // core → the world
  { from: "l/manager", to: "x/sdk", kind: "import" },
  { from: "x/sdk", to: "x/jsonl", kind: "http", label: "writes" },
  { from: "l/sessions", to: "x/jsonl", kind: "http", label: "reads" },
  { from: "l/sessions", to: "x/bentocache", kind: "http" },
  { from: "l/enrich", to: "x/bentocache", kind: "http" },
  { from: "r/accounts", to: "x/slayer", kind: "http", label: "execFile" },
];
