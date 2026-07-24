// LIVE SNAPSHOT — safe-to-publish real data only.
// Generated from the private vault (git) + qone on 2026-07-24.
//
// This repo is PUBLIC and indexable, so sensitive strings (client / other-org
// task titles, real API spend, real people's names) are intentionally withheld.
// Only real aggregates and self-referential (Minami-build) items ship here.
// The full live pull — real spend, all task titles, the real network — needs a
// private or token-gated deploy.

export const tokenLog = {
  connected: false, // no per-session Claude usage source wired to Minami yet
};

export const taskLog = [
  { id: "minami-3", title: "Minami Dashboard — visual UI", project: "Minami", status: "in_progress", priority: "high" },
  { id: "minami-1", title: "Test Minami → qone wiring", project: "Minami", status: "done", priority: "high" },
  { id: "minami-2", title: "Verify durable qone auth", project: "Minami", status: "done", priority: "med" },
];

export const traceBack = [
  { id: "t1", chat: "Diagnose the blank dashboard page", capture: "minami-dashboard.md", where: "10-19 Projects/", at: "2026-07-24" },
  { id: "t2", chat: "Pivot to a real Next.js app on CI → Pages", capture: "minami-dashboard.md", where: "10-19 Projects/", at: "2026-07-24" },
  { id: "t3", chat: "How can anh send me images?", capture: "Sending Images To Minami.md", where: "60-69 Wiki/", at: "2026-07-24" },
  { id: "t4", chat: "Start the Minami Dashboard project", capture: "minami-dashboard.md", where: "10-19 Projects/", at: "2026-07-24" },
];

export const analytics = {
  activeProjects: 4,
  openTasks: 8,
  notesTotal: 23,
  captureRate7d: 23,
};

// Names withheld on the public deploy — relation labels only.
export const people = [
  { id: "p1", name: "Ownego teammate", relation: "Ownego / Qikify", lastTouch: "2026-07-24" },
  { id: "p2", name: "Qikify teammate", relation: "Ownego / Qikify", lastTouch: "2026-07-24" },
];
