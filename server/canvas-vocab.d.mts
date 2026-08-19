// Types for the plain-ESM vocabulary helper. It is .mjs because the receiver and CLI run it under
// bare node with no build step; this is what lets the Next route import it without `any`.
export type Vocab = { terms: string[]; fixes: Record<string, string> };
export function loadVocab(): Vocab;
export function saveVocab(v: Vocab): void;
export function asrPrompt(vocab: Vocab, extra?: string[]): string | undefined;
export function correctText(text: string, vocab: Vocab): string;
export function correctLines(lines: string[], vocab: Vocab): { corrected: string[]; changes: { from: string; to: string }[] };
export function learn(input: { term?: string; was?: string }): Vocab;
