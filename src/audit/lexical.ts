/**
 * Shared lexical primitives for the demand-clustering features (opportunities.ts,
 * contentArchitecture.ts). One copy so the stop-word list, tokenizer and the
 * Jaccard similarity used for greedy clustering can't drift between them.
 */
import { STOP as TEXT_STOP, tokens } from '../core/text.js';

// SEOCoral fork: English + Spanish stop words, accent folding and plural stemming (core/text.ts).
export const STOP = TEXT_STOP;

export const tokenize = (s: string): string[] => tokens(s);

export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};
