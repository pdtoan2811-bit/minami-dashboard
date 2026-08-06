// The template registry.
//
// Templates are code rather than JSON on disk for one reason: they're the thing that has to be right
// before anything else works, and a broken one should fail `npm run build:check`, not a run at 2am.
// Adding a template is a data edit here — nothing in the engine knows any role name.
import type { RoleSpec, TeamTemplate } from "../types";
import { CONTENT_STUDIO } from "./content-studio";
import { SOLO_FOUNDER } from "./solo-founder";
import { TECH_PRODUCT } from "./tech-product";

/** Ordered: the default first. */
export const TEMPLATES: TeamTemplate[] = [TECH_PRODUCT, SOLO_FOUNDER, CONTENT_STUDIO];

export const DEFAULT_TEMPLATE = TECH_PRODUCT.id;

export function getTemplate(id: string): TeamTemplate | null {
  return TEMPLATES.find((t) => t.id === id) || null;
}

export function roleOf(t: TeamTemplate, key: string): RoleSpec | null {
  return t.roles.find((r) => r.key === key) || null;
}

/**
 * What's structurally wrong with a template, if anything.
 *
 * Checked when a product is created rather than at import: a typo in one template's chain shouldn't
 * take the whole dashboard down at boot, and the failure it would otherwise cause — a run that dies
 * three stages in with "agent undefined" — is expensive and confusing at exactly the wrong moment.
 */
export function templateProblems(t: TeamTemplate): string[] {
  const out: string[] = [];
  const keys = new Set(t.roles.map((r) => r.key));
  for (const s of t.chain) {
    if (!keys.has(s.role)) out.push(`stage "${s.key}" names role "${s.role}", which this template doesn't define`);
  }
  if (!t.chain.length) out.push("the chain is empty");
  const stageKeys = new Set(t.chain.map((s) => s.key));
  if (stageKeys.size !== t.chain.length) out.push("two stages share a key");
  return out;
}

/** What a template looks like on the wire. */
export type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  roles: { key: string; name: string; icon: string; role: string; needsWorkspace: boolean }[];
  chain: { key: string; role: string; section: string }[];
};

/**
 * A template minus the bodies.
 *
 * Personas and skills are thousands of words each and the browser needs none of them — the picker
 * shows a name, a line, and the chain. Sending the full objects would put ~40kB of prompt text into
 * every poll of a page that renders five words of it.
 */
export function summarize(t: TeamTemplate): TemplateSummary {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    roles: t.roles.map((r) => ({ key: r.key, name: r.name, icon: r.icon, role: r.role, needsWorkspace: r.needsWorkspace })),
    chain: t.chain.map((s) => ({ key: s.key, role: s.role, section: s.section })),
  };
}

export { CONTENT_STUDIO, SOLO_FOUNDER, TECH_PRODUCT };
