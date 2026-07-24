// MOCK DATA ONLY. The public repo never ships real numbers.
// Real values load at runtime from qone / the vault sync endpoint via env vars
// (see .env.example) and stay out of git.

export const tokenLog = {
  todayTokens: 128_400,
  todayCostUsd: 1.92,
  weekTokens: 812_300,
  weekCostUsd: 12.4,
  byDay: [
    { day: "Mon", tokens: 96_000 },
    { day: "Tue", tokens: 142_000 },
    { day: "Wed", tokens: 88_500 },
    { day: "Thu", tokens: 131_200 },
    { day: "Fri", tokens: 128_400 },
  ],
};

export const taskLog = [
  { id: "minami-3", title: "Build Minami Dashboard", project: "Minami", status: "in_progress", priority: "high" },
  { id: "qone-ops-1", title: "Sync protocol hardening", project: "Qone Ops", status: "done", priority: "med" },
  { id: "qmem-2", title: "Qmember onboarding flow", project: "Qmember", status: "todo", priority: "med" },
];

export const traceBack = [
  { id: "t1", chat: "Start Minami Dashboard", capture: "Minami Dashboard.md", where: "10-19 Projects/", at: "2026-07-24" },
  { id: "t2", chat: "Reconcile 3 orgs", capture: "org-map note", where: "20-29 Areas/", at: "2026-07-23" },
];

export const analytics = {
  activeProjects: 4,
  openTasks: 2,
  notesTotal: 187,
  captureRate7d: 14,
};

export const people = [
  { id: "p1", name: "Person A", relation: "Ownego", lastTouch: "2026-07-22" },
  { id: "p2", name: "Person B", relation: "Qikify", lastTouch: "2026-07-20" },
];
