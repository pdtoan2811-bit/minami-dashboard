// The product registry — one JSON file per product under ~/.minami/products/.
//
// Same shape and the same reasoning as lib/agents/store.ts: on disk because the runner reads it with
// no browser to ask and must still know it after the restart a deploy causes, and one file per product
// so two panes creating products at once don't need a lock.
//
// A product is deliberately thin: a workspace, a role→agent map, and a path to the record. Everything
// that makes a product understandable lives in the record folder, where every other tool on the box —
// a bare `claude`, Minami in Slack, Obsidian — can read it without going through this app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, slugify } from "../agents/store";
import { ensureRoleAgent, grantWorkspace } from "./brains";
import { getTemplate, templateProblems } from "./templates";
import type { Product } from "./types";

export const PRODUCTS_DIR =
  process.env.MINAMI_PRODUCTS_DIR || path.join(os.homedir(), ".minami", "products");

/**
 * Where product records go by default. The vault, because it's already the cross-project truth on this
 * box: it syncs to every device, Minami reads it from Slack, and any Claude session anywhere can open
 * it. A record only the dashboard can see would be a fourth place to look.
 */
export const RECORDS_ROOT =
  process.env.MINAMI_RECORDS_DIR || path.join(os.homedir(), "secondBrain", "10-19 Projects");

function fileFor(id: string): string {
  return path.join(PRODUCTS_DIR, `${id}.json`);
}

function normalize(raw: Partial<Product>, id: string): Product | null {
  if (!raw?.templateId || typeof raw.templateId !== "string") return null;
  const roles = raw.roles && typeof raw.roles === "object" ? (raw.roles as Record<string, string>) : {};
  if (!Object.keys(roles).length) return null; // a product with no team can't run anything
  const record = typeof raw.recordPath === "string" && raw.recordPath ? raw.recordPath : "";
  if (!record || !path.isAbsolute(record)) return null;
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    templateId: raw.templateId,
    workspace: typeof raw.workspace === "string" && path.isAbsolute(raw.workspace) ? raw.workspace : undefined,
    recordPath: record,
    roles,
    createdAt: Number(raw.createdAt) || Date.now(),
    sync: raw.sync === true,
  };
}

export function listProducts(): Product[] {
  let names: string[];
  try { names = fs.readdirSync(PRODUCTS_DIR); } catch { return []; }
  const out: Product[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(PRODUCTS_DIR, n), "utf8")) as Partial<Product>;
      const p = normalize(raw, n.replace(/\.json$/, ""));
      if (p) out.push(p);
    } catch { /* unreadable or half-written — skip rather than break the whole list */ }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function getProduct(id: string): Product | null {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(id), "utf8")) as Partial<Product>;
    return normalize(raw, id);
  } catch { return null; }
}

function write(p: Product): Product {
  fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
  fs.writeFileSync(fileFor(p.id), JSON.stringify(p, null, 2) + "\n");
  return p;
}

export function updateProduct(id: string, patch: Partial<Product>): Product | null {
  const cur = getProduct(id);
  if (!cur) return null;
  const next = normalize({ ...cur, ...patch, id: cur.id, createdAt: cur.createdAt }, cur.id);
  return next ? write(next) : null;
}

/**
 * Forget a product. Like deleting an agent, this touches neither the record nor the role brains —
 * the record is the accumulated understanding of the product and the brains are shared with every
 * other product on the box. Only the registry row goes.
 */
export function deleteProduct(id: string): boolean {
  try { fs.unlinkSync(fileFor(id)); return true; } catch { return false; }
}

export type CreateProductInput = {
  name: string;
  templateId: string;
  workspace?: string;
  recordPath?: string;
  sync?: boolean;
};

/**
 * Create a product: resolve the template, make sure every role it names has a real agent, grant the
 * workspace to the roles that need it, and write the registry row.
 *
 * Roles are resolved to agent IDS at creation, not looked up per run. A run that resolved roles from
 * the template each time would silently repoint at a different agent the moment a template was
 * edited — mid-flight, for a product with months of history behind it.
 */
export function createProduct(input: CreateProductInput): { product: Product; createdAgents: string[] } {
  const template = getTemplate(input.templateId);
  if (!template) throw new Error(`no such template: ${input.templateId}`);
  const problems = templateProblems(template);
  if (problems.length) throw new Error(`template "${template.id}" is broken: ${problems.join("; ")}`);

  const name = input.name.trim();
  if (!name) throw new Error("name is required");

  let workspace: string | undefined;
  if (input.workspace) {
    workspace = expandHome(input.workspace);
    if (!path.isAbsolute(workspace)) throw new Error("workspace must be an absolute path");
    let st: fs.Stats | null = null;
    try { st = fs.statSync(workspace); } catch { /* reported below */ }
    if (!st?.isDirectory()) throw new Error(`workspace folder does not exist: ${workspace}`);
    try { workspace = fs.realpathSync(workspace); } catch { /* keep as given */ }
  }

  const base = slugify(name) || "product";
  let id = base;
  for (let n = 2; fs.existsSync(fileFor(id)); n++) id = `${base}-${n}`;

  const recordPath = input.recordPath ? expandHome(input.recordPath) : path.join(RECORDS_ROOT, name);
  if (!path.isAbsolute(recordPath)) throw new Error("record path must be absolute");
  // Created up front so the closing stage isn't the first thing to discover the vault moved. Its
  // contents are the closing agent's job, not ours — an index written by code would be a template
  // nobody maintains.
  fs.mkdirSync(recordPath, { recursive: true });

  const roles: Record<string, string> = {};
  const createdAgents: string[] = [];
  for (const spec of template.roles) {
    const { agent, created } = ensureRoleAgent(spec);
    if (created) createdAgents.push(agent.id);
    if (workspace && spec.needsWorkspace) grantWorkspace(agent, workspace);
    roles[spec.key] = agent.id;
  }

  const product = write({
    id, name, templateId: template.id, workspace, recordPath, roles,
    createdAt: Date.now(),
    sync: input.sync === true,
  });
  return { product, createdAgents };
}
