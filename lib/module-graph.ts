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
  { id: "app/browser", label: "/browser/[id]", sub: "popped-out browser panel", layer: "surface", row: 5, pipeline: "live" },

  // ── components ──────────────────────────────────────────────────────────
  { id: "c/Composer", label: "Composer", sub: "message input + mode", layer: "component", row: 0, pipeline: "live" },
  { id: "c/AskCard", label: "AskCard", sub: "AskUserQuestion wizard", layer: "component", row: 1, pipeline: "live" },
  { id: "c/BrowserPanel", label: "BrowserPanel", sub: "browser window for a\nheadless browser", layer: "component", row: 2, pipeline: "live" },
  { id: "c/BrowserLightbox", label: "BrowserLightbox", sub: "full-size viewer\n(portalled to body)", layer: "component", row: 15, pipeline: "live" },
  { id: "c/Markdown", label: "Markdown", sub: "memoised renderer\n(chat + thought tones)", layer: "component", row: 3 },
  { id: "c/ThoughtBlock", label: "ThoughtBlock", sub: "reasoning passes,\nseam-split", layer: "component", row: 16, pipeline: "live" },
  { id: "c/AutopilotTile", label: "AutopilotTile", sub: "what got automated,\nin the grid", layer: "component", row: 19 },
  { id: "c/BentoRail", label: "BentoRail", sub: "the grid, collapsed\nto a vertical rail", layer: "component", row: 17 },
  { id: "c/ProjectIcon", label: "ProjectIcon", sub: "3D icon, shared by\ngrid and rail", layer: "component", row: 18 },
  { id: "c/Segmented", label: "Segmented", sub: "the one segmented control\n(was 9 hand-rolled copies)", layer: "component", row: 20 },
  { id: "c/FolderPicker", label: "FolderPicker", sub: "new-session cwd", layer: "component", row: 4 },
  { id: "c/AttachBar", label: "AttachBar", sub: "tech icons", layer: "component", row: 5 },
  { id: "c/BrandIcon", label: "BrandIcon", sub: "simple-icons", layer: "component", row: 6 },
  { id: "c/AccountStatus", label: "AccountStatus", sub: "fallback-account alert", layer: "component", row: 7 },
  { id: "c/AccountsPanel", label: "AccountsPanel", sub: "token-slayer pool", layer: "component", row: 8 },
  { id: "c/PreferredAccountPanel", label: "PreferredAccountPanel", sub: "pick preferred account", layer: "component", row: 9 },
  { id: "c/UsagePanel", label: "UsagePanel", sub: "per-machine totals", layer: "component", row: 9, pipeline: "metrics" },
  { id: "c/UsageHeatmap", label: "UsageHeatmap", sub: "calendar", layer: "component", row: 10, pipeline: "metrics" },
  { id: "c/RoutingFlow", label: "RoutingFlow", sub: "live turn feed", layer: "component", row: 11, pipeline: "metrics" },
  { id: "c/ModelRouting", label: "ModelRouting", sub: "pricing table", layer: "component", row: 12 },
  { id: "c/ProjectsPanel", label: "ProjectsPanel", sub: "cross-host checkpoints", layer: "component", row: 13, pipeline: "metrics" },
  { id: "c/Nav", label: "Nav", sub: "surface switcher", layer: "component", row: 14 },
  { id: "c/NotifBell", label: "NotificationBell", sub: "deploy · build · merge alerts", layer: "component", row: 15 },

  // ── api routes ──────────────────────────────────────────────────────────
  { id: "r/agent", label: "/api/agent/*", sub: "send · stream · stop\npermission · answer · mode · live", layer: "route", row: 0, pipeline: "live" },
  { id: "r/sessions", label: "/api/bento/sessions", sub: "grid list", layer: "route", row: 1, pipeline: "read" },
  { id: "r/session", label: "/api/bento/session/[id]", sub: "transcript page · ?before=", layer: "route", row: 2, pipeline: "read" },
  { id: "r/enrich", label: "/api/bento/enrich", sub: "Haiku labels", layer: "route", row: 3 },
  { id: "r/attach", label: "/api/bento/attach*", sub: "tech detection", layer: "route", row: 4 },
  { id: "r/accounts", label: "/api/accounts", sub: "token-slayer bridge", layer: "route", row: 5 },
  { id: "r/fs", label: "/api/fs/list", sub: "folder browse", layer: "route", row: 6 },
  { id: "r/fsmkdir", label: "/api/fs/mkdir", sub: "create a topic's folder", layer: "route", row: 8 },
  { id: "r/events", label: "/api/events", sub: "tails the alert log", layer: "route", row: 9 },
  { id: "r/paste", label: "/api/fs/paste", sub: "writes a pasted image\n(fixed root, no path input)", layer: "route", row: 10 },
  { id: "r/fsimage", label: "/api/fs/image", sub: "serves an image for\nthumbnails (magic-byte gated)", layer: "route", row: 11 },
  { id: "r/browserfile", label: "/api/agent/browser/file", sub: "serves <cwd>/.playwright-mcp/*\n(full-res shots, console logs)", layer: "route", row: 7, pipeline: "live" },

  // ── core ────────────────────────────────────────────────────────────────
  { id: "l/manager", label: "agent/manager.ts", sub: "session registry · SDK query()", layer: "core", row: 0, pipeline: "live" },
  { id: "l/labels", label: "agent/labels.ts", sub: "activity phases + labels", layer: "core", row: 1, pipeline: "live" },
  { id: "l/useagent", label: "use-agent.ts", sub: "client SSE + reconnect", layer: "core", row: 2, pipeline: "live" },
  { id: "l/sessions", label: "claude-sessions.ts", sub: "windowed parser + caches", layer: "core", row: 3, pipeline: "read" },
  { id: "l/enrich", label: "bento-enrich.ts", sub: "semantic label cache", layer: "core", row: 4, pipeline: "read" },
  { id: "l/routing", label: "routing.ts", sub: "models + prices", layer: "core", row: 5 },
  { id: "l/sources", label: "sources.ts", sub: "machine labels", layer: "core", row: 6, pipeline: "metrics" },
  { id: "l/panels", label: "panels.ts", sub: "pluggable cards", layer: "core", row: 7 },
  { id: "l/techicons", label: "tech-icons.ts", sub: "icon lookup", layer: "core", row: 8 },
  { id: "l/techattach", label: "tech-attach.ts", sub: "repo sniffing", layer: "core", row: 9 },
  { id: "l/settings", label: "use-settings.ts", sub: "localStorage", layer: "core", row: 10 },
  { id: "l/preferredacct", label: "preferred-account.ts", sub: "~/.minami/account.json", layer: "core", row: 12 },
  { id: "l/notify", label: "use-notify.ts", sub: "away-tab alerts", layer: "core", row: 11 },
  { id: "l/useevents", label: "use-events.ts", sub: "poll + two-cursor unread", layer: "core", row: 13 },
  { id: "l/events", label: "events.ts", sub: "reads the alert log\n(never writes it)", layer: "core", row: 14 },
  { id: "l/images", label: "agent/images.ts", sub: "image paths in a message\n→ inline blocks", layer: "core", row: 15 },
  { id: "l/browserview", label: "browser-view.ts", sub: "parses browser_* results\ninto panel state", layer: "core", row: 12, pipeline: "live" },

  // ── outside ─────────────────────────────────────────────────────────────
  { id: "x/sdk", label: "Agent SDK", sub: "spawns the claude CLI", layer: "runtime", row: 0, pipeline: "live" },
  { id: "x/jsonl", label: "~/.claude/projects", sub: "*.jsonl transcripts", layer: "runtime", row: 1, pipeline: "read" },
  { id: "x/bentocache", label: "~/.minami-bento", sub: "meta + turns + enrich cache", layer: "runtime", row: 2, pipeline: "read" },
  { id: "x/slayer", label: "token-slayer CLI", sub: "+ ~/.claude.json identity", layer: "runtime", row: 3 },
  { id: "x/metrics", label: "metrics server", sub: "Hetzner · Tailscale Funnel", layer: "runtime", row: 4, pipeline: "metrics" },
  // Written only by bin/deploy.sh and bin/task.mjs — processes that outlive the server, which is the
  // entire reason the alert log is a file instead of an in-memory queue. See KNOWLEDGE.md §10.
  { id: "l/autopilot", label: "autopilot/runner", sub: "always-on merge · resolve · deploy\n(off by default)", layer: "core", row: 19 },
  { id: "c/AutopilotPanel", label: "AutopilotPanel", sub: "the switch, in plain words", layer: "component", row: 20 },
  { id: "r/autopilot", label: "/api/autopilot", sub: "the switch + what the runner sees", layer: "route", row: 12 },
  { id: "x/autopilotcfg", label: "~/.minami/autopilot.json", sub: "its switch — on disk, because a\ntimer in the server reads it", layer: "runtime", row: 6 },
  { id: "x/events", label: "~/.minami/events.jsonl", sub: "alert log · deploy.sh + task.mjs write", layer: "runtime", row: 5 },

  // ── Standing agents (KNOWLEDGE.md §14) ──────────────────────────────────
  // The agent layer meets the live pipeline at exactly one point — l/agents-runner → l/manager — and
  // the read pipeline at one more — l/agents-history → l/sessions. Everything else here is its own.
  { id: "app/agents", label: "app/agents", sub: "roster + agent detail\n(opt-in view)", layer: "surface", row: 6 },
  { id: "c/AgentChat", label: "agents/AgentChat", sub: "one pane per agent\n(key: agent:<id>:chat)", layer: "component", row: 24, pipeline: "live" },
  { id: "c/AgentTile", label: "agents/AgentTile", sub: "bento tile, grouped by who", layer: "component", row: 25 },
  { id: "l/agents-store", label: "agents/store.ts", sub: "the registry · HQ uniqueness\n· realpath resolution", layer: "core", row: 21 },
  { id: "l/agents-runner", label: "agents/runner.ts", sub: "unattended runs · write-back\n· handoffs (polls, never subscribes)", layer: "core", row: 22 },
  { id: "l/agents-history", label: "agents/history.ts", sub: "attribution: home vs task", layer: "core", row: 23, pipeline: "read" },
  { id: "l/agents-scaffold", label: "agents/scaffold.ts", sub: "scaffold or adopt a brain\n(never overwrites)", layer: "core", row: 24 },
  { id: "r/agents", label: "/api/agents/**", sub: "roster · create · patch\n· inspect · onboard · tasks", layer: "route", row: 16 },
  { id: "x/agentsdir", label: "~/.minami/agents/*.json", sub: "the roster — on disk, because the\nrunner spawns without a browser", layer: "runtime", row: 7 },
  { id: "x/agenthome", label: "an agent's home folder", sub: "CLAUDE.md · MEMORY.md · notes\n— the substance, not the registry", layer: "runtime", row: 8 },

  // ── File preview (KNOWLEDGE.md §5g) ─────────────────────────────────────
  { id: "c/FilePanel", label: "FilePanel", sub: "any file type, paged\n(shares the browser's slot)", layer: "component", row: 22, pipeline: "live" },
  { id: "l/fileview", label: "file-view.ts", sub: "transcript → files touched\n(created vs changed)", layer: "core", row: 18, pipeline: "live" },
  { id: "r/fsfile", label: "/api/fs/file", sub: "sliced text · binary sniff\n· raw allow-list", layer: "route", row: 15 },

  // ── Flow view: the step graph + its brake (KNOWLEDGE.md §5f) ────────────
  { id: "c/FlowStrip", label: "FlowStrip", sub: "the in-chat door", layer: "component", row: 22, pipeline: "live" },
  { id: "c/FlowCanvas", label: "FlowCanvas", sub: "step graph in the bento\n(React Flow, no minimap)", layer: "component", row: 21, pipeline: "live" },
  { id: "l/flowmodel", label: "flow-model.ts", sub: "transcript → step graph\n(TodoWrite + TaskCreate)", layer: "core", row: 16, pipeline: "live" },
  { id: "r/hold", label: "/api/agent/hold", sub: "arms the canUseTool brake", layer: "route", row: 13, pipeline: "live" },

  // ── Density: how much chrome a box may spend (KNOWLEDGE.md §5e) ─────────
  { id: "l/density", label: "density.ts", sub: "measured tiers + context\n(roomy · snug · tight · micro)", layer: "core", row: 20 },
  // Shared so "the browser matches the file preview" is a fact about the code, not a thing to re-check.
  { id: "c/PanelTabs", label: "PanelTabs", sub: "one tab row, worn by\nthe file AND browser panels", layer: "component", row: 23 },
];

export const EDGES: ModuleEdge[] = [
  // surfaces → components (static imports)
  { from: "app/page", to: "c/Composer", kind: "import" },
  // page.tsx measures each pane and PROVIDES the tier; Composer is the one leaf that consumes it.
  { from: "app/page", to: "l/density", kind: "import" },
  { from: "c/Composer", to: "l/density", kind: "import" },
  { from: "c/FilePanel", to: "c/PanelTabs", kind: "import" },
  { from: "c/BrowserPanel", to: "c/PanelTabs", kind: "import" },
  { from: "app/page", to: "c/AskCard", kind: "import" },
  { from: "app/page", to: "c/BrowserPanel", kind: "import" },
  { from: "app/page", to: "c/BrowserLightbox", kind: "import" },
  { from: "app/page", to: "l/browserview", kind: "import" },
  { from: "app/browser", to: "c/BrowserPanel", kind: "import" },
  { from: "app/browser", to: "c/BrowserLightbox", kind: "import" },
  { from: "app/browser", to: "l/browserview", kind: "import" },
  { from: "app/browser", to: "l/useagent", kind: "import" },
  { from: "app/browser", to: "r/session", kind: "http" },
  { from: "c/BrowserPanel", to: "l/browserview", kind: "import" },
  { from: "c/BrowserPanel", to: "c/BrowserLightbox", kind: "import" },
  { from: "c/BrowserLightbox", to: "l/browserview", kind: "import" },
  // The panel loads full-resolution screenshots and console logs straight off disk at runtime, rather
  // than relying on the (downscaled, reload-lossy) base64 in the transcript.
  { from: "c/BrowserLightbox", to: "r/browserfile", kind: "http" },
  { from: "app/page", to: "c/Markdown", kind: "import" },
  { from: "app/page", to: "c/ThoughtBlock", kind: "import" },
  { from: "c/ThoughtBlock", to: "c/Markdown", kind: "import" },
  { from: "app/page", to: "c/Segmented", kind: "import" },
  { from: "app/settings", to: "c/Segmented", kind: "import" },
  { from: "app/page", to: "c/BentoRail", kind: "import" },
  { from: "app/page", to: "c/AutopilotTile", kind: "import" },
  { from: "c/AutopilotTile", to: "r/autopilot", kind: "http" },
  { from: "c/AutopilotTile", to: "r/events", kind: "http" },
  { from: "app/settings", to: "c/AutopilotPanel", kind: "import" },
  { from: "c/AutopilotPanel", to: "r/autopilot", kind: "http" },
  { from: "r/autopilot", to: "l/autopilot", kind: "import" },
  { from: "l/autopilot", to: "x/autopilotcfg", kind: "import" },
  { from: "l/autopilot", to: "l/manager", kind: "import" },
  { from: "l/autopilot", to: "x/events", kind: "import" },

  // Standing agents. `l/agents-runner → l/manager` is the whole of the join to the live pipeline:
  // an assigned task is an ordinary session with an `agent:<id>:<taskId>` key.
  { from: "app/agents", to: "c/AgentChat", kind: "import" },
  { from: "app/agents", to: "c/AgentTile", kind: "import" },
  { from: "app/agents", to: "r/agents", kind: "http", label: "poll 4s" },
  { from: "c/AgentChat", to: "l/useagent", kind: "import" },
  { from: "r/agents", to: "l/agents-store", kind: "import" },
  { from: "r/agents", to: "l/agents-runner", kind: "import" },
  { from: "r/agents", to: "l/agents-history", kind: "import" },
  { from: "r/agents", to: "l/agents-scaffold", kind: "import" },
  { from: "l/agents-store", to: "x/agentsdir", kind: "import" },
  { from: "l/agents-scaffold", to: "x/agenthome", kind: "import" },
  { from: "l/agents-runner", to: "l/manager", kind: "import" },
  { from: "l/agents-runner", to: "l/sessions", kind: "import" },
  { from: "l/agents-runner", to: "x/agenthome", kind: "import", label: "activity log" },
  { from: "l/agents-history", to: "l/sessions", kind: "import" },
  { from: "app/page", to: "c/ProjectIcon", kind: "import" },
  { from: "c/BentoRail", to: "c/ProjectIcon", kind: "import" },
  { from: "app/page", to: "c/FolderPicker", kind: "import" },
  { from: "app/page", to: "c/AttachBar", kind: "import" },
  { from: "app/page", to: "c/BrandIcon", kind: "import" },
  { from: "app/page", to: "c/Nav", kind: "import" },
  { from: "app/page", to: "c/NotifBell", kind: "import" },
  { from: "c/NotifBell", to: "l/useevents", kind: "import" },
  { from: "l/useevents", to: "l/notify", kind: "import" },
  { from: "l/useevents", to: "r/events", kind: "http", label: "poll 8s" },
  { from: "r/events", to: "l/events", kind: "import" },
  { from: "c/Composer", to: "r/paste", kind: "http", label: "paste image" },
  { from: "app/page", to: "r/fsimage", kind: "http", label: "thumbnails" },
  { from: "r/paste", to: "l/images", kind: "import" },
  { from: "r/fsimage", to: "l/images", kind: "import" },
  { from: "r/agent", to: "l/images", kind: "import" },
  { from: "l/events", to: "x/events", kind: "http", label: "read" },
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
  { from: "c/FolderPicker", to: "r/fsmkdir", kind: "http" },
  { from: "c/AccountStatus", to: "r/accounts", kind: "http", label: "30s poll" },
  { from: "c/AccountsPanel", to: "r/accounts", kind: "http" },
  { from: "c/PreferredAccountPanel", to: "r/accounts", kind: "http", label: "GET + PUT" },
  { from: "app/settings", to: "c/PreferredAccountPanel", kind: "import" },
  { from: "r/accounts", to: "l/preferredacct", kind: "import" },
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

  // File preview. The panel fetches CONTENT from the route rather than reading it out of the
  // transcript, because a transcript records that a file was written, not what is in it now.
  { from: "app/page", to: "c/FilePanel", kind: "import" },
  { from: "app/page", to: "l/fileview", kind: "import" },
  { from: "c/FilePanel", to: "r/fsfile", kind: "http", label: "slice / raw" },
  { from: "c/FilePanel", to: "r/fsimage", kind: "http", label: "images" },
  { from: "c/FilePanel", to: "c/Markdown", kind: "import" },

  // Flow view. The brake is drawn as a full round trip on purpose: the button is in the component,
  // but the only place it can be ENFORCED is canUseTool inside the manager — see KNOWLEDGE.md §5f.
  { from: "app/page", to: "c/FlowCanvas", kind: "import" },
  { from: "app/page", to: "c/FlowStrip", kind: "import" },
  { from: "c/FlowCanvas", to: "r/session", kind: "http", label: "transcript" },
  { from: "c/FlowCanvas", to: "l/flowmodel", kind: "import" },
  { from: "c/FlowCanvas", to: "r/hold", kind: "http", label: "arm/release" },
  { from: "r/hold", to: "l/manager", kind: "import" },
];
