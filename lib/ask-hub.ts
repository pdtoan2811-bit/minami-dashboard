// Client for the Ask Hub — the Cloudflare Worker that carries a Claude question to the OTHER founder
// over Slack (design + wire contract: ~/Minami/docs/ASK-HUB.md). The dashboard is one of the hub's
// renderers, not its owner: Claude calls the `ask_team` MCP tool, the tool posts the packet to the
// hub and long-polls; this module only lets the pane answer the same ask the Slack card shows, so
// whichever of the two is answered first wins — inside the hub, not here.
//
// Off unless MINAMI_ASK_HUB_URL is set. The pane still RENDERS an in-flight ask_team call from the
// tool-use stream without it (the packet is right there in the tool input), it just can't answer.

export type AskRole = "growth" | "eng";

// The `ask_team` tool's input, as Claude wrote it. Mirrors `Packet` in the contract; every field the
// card renders is required there, so the optional marks here only cover what the tool auto-fills.
export type AskTeamPacket = {
  to: AskRole;
  from?: AskRole;
  project?: string;
  branch?: string;
  why_you: string;
  situation: string;
  hinge: string;
  question: string;
  multi?: boolean;
  options: { label: string; consequence: string }[];
  recommended?: string;
  because?: string;
  reversible?: boolean;
  blocking?: boolean;
  thread?: string;
};

export type AskHubState = {
  id: string;
  status: "pending" | "answered" | "rerouted" | "closed";
  packet: AskTeamPacket;
  thread: string;
  answer?: { kind: "option" | "other" | "reply"; labels: string[]; text?: string };
  by?: { role: AskRole; name: string; via: "slack" | "dashboard" };
};

// MCP tools are named `mcp__<server>__<tool>`; the server name is whatever `claude mcp add` was given,
// so match on the tool suffix rather than pinning `ask-team`.
export const isAskTeamTool = (name: string): boolean => name.startsWith("mcp__") && name.endsWith("__ask_team");

export function askHubConfig(): { url: string; token: string; role: AskRole; name: string } | null {
  const url = (process.env.MINAMI_ASK_HUB_URL || "").replace(/\/+$/, "");
  const token = process.env.MINAMI_ASK_HUB_TOKEN || "";
  if (!url || !token) return null;
  const role: AskRole = process.env.MINAMI_ASK_ROLE === "eng" ? "eng" : "growth";
  // No personal default: a fresh clone answers as its role until the operator names themselves.
  const name = process.env.MINAMI_ASK_NAME || (role === "eng" ? "CTO" : "Growth/PM");
  return { url, token, role, name };
}

async function hub<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = askHubConfig();
  if (!cfg) throw new Error("ask hub is not configured (MINAMI_ASK_HUB_URL / MINAMI_ASK_HUB_TOKEN)");
  const res = await fetch(cfg.url + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}`, ...(init?.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ask hub ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// The pane knows the packet (from the tool call) but not the hub's id for it — that's returned to the
// MCP tool, which is a different process. So look it up among this box's pending asks by the one
// thing both sides have verbatim: the question text. Newest first, so a re-ask in the same thread
// with the same wording resolves to the live one.
export async function findPendingAsk(question: string): Promise<AskHubState | null> {
  const cfg = askHubConfig();
  if (!cfg) return null;
  const { asks } = await hub<{ asks: AskHubState[] }>(`/asks?from=${cfg.role}&status=pending`);
  const mine = asks.filter((a) => a.packet?.question === question);
  return mine[mine.length - 1] || null;
}

export async function answerAsk(id: string, labels: string[], text?: string): Promise<AskHubState> {
  const cfg = askHubConfig()!;
  return hub<AskHubState>(`/ask/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    body: JSON.stringify({ labels, text: text || undefined, by: { role: cfg.role, name: cfg.name } }),
  });
}
