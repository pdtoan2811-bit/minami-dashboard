export type Template = { slug: string; name: string; topics: string[]; note: string };
export function listTemplates(): Template[];
export function getTemplate(nameOrSlug: string): Template | null;
export function saveTemplate(name: string, topics: string[], note?: string): Template | null;
