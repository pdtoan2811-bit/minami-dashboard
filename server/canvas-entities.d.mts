// Types for the plain-ESM entity layer. .mjs because the receiver and CLI run it under bare node.
import type { Vocab } from "./canvas-vocab.mjs";
export function similarity(a: string, b: string): number;
export type EntityIndex = {
  observe(line: string): string[];
  rewrite(text: string): string;
  entities(): { name: string; count: number; variants: string[] }[];
  variantsOf(name: string): string[];
  prune(): void;
};
export function createEntityIndex(vocab?: Vocab): EntityIndex;
