import { queryTerms } from "./bm25.ts";
import type { FindCandidate } from "./skills.ts";

const families = [
  ["Angular", /\bangular\b/iu],
  ["React", /\b(?:react|next[.-]?js)\b/iu],
  ["Svelte", /\bsvelte(?:kit)?\b/iu],
  ["Vue", /\b(?:vue|nuxt)(?:[.]?js)?\b/iu],
] as const;

export function frameworkFamilies(text: string): string[] {
  return families.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function candidateFamilies(candidate: FindCandidate): string[] {
  const named = frameworkFamilies(candidate.name);
  return named.length > 0 ? named : frameworkFamilies(candidate.description);
}

export function frontendTask(task: string): boolean {
  return /\bfront[\s-]*end\b/iu.test(task);
}

const genericTerms = new Set(queryTerms("frontend front end work development"));
const [frontendTerm] = queryTerms("frontend");
const [frontTerm, endTerm] = queryTerms("front end");

export function frameworkOptions(candidates: FindCandidate[], terms: string[]): string[] {
  const specific = terms.filter((term) => !genericTerms.has(term));
  const choices = new Set<string>();
  for (const candidate of candidates) {
    const prominent = [...candidate.matchedTerms.name, ...candidate.matchedTerms.description, ...candidate.matchedTerms.headings];
    const match = candidateFamilies(candidate);
    const frontend = [candidate.matchedTerms.name, candidate.matchedTerms.description, candidate.matchedTerms.headings].some(
      (field) => field.includes(frontendTerm!) || (field.includes(frontTerm!) && field.includes(endTerm!)),
    );
    if (
      match.length === 1 &&
      frontend &&
      (specific.length === 0 || (candidate.recommended === true && prominent.some((term) => specific.includes(term))))
    )
      choices.add(match[0]!);
  }
  return [...choices].sort();
}
