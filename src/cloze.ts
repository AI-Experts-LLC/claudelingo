/**
 * Blanking a word out of its own sentence.
 *
 * Shared by the pack loader and the card builder on purpose. They used to
 * disagree — the loader asked "does this sentence contain the word anywhere?"
 * with a substring test, while the builder blanked the first match with no word
 * boundary — so a sentence could pass the guard and then be asked with the answer
 * still in it: "Los sonidos son fuertes" became "Los ____idos son fuertes", which
 * shows `son` twice over and is unanswerable besides.
 *
 * One predicate, used by both: the word has to appear as a word.
 */

/** The gap a cloze leaves behind. */
export const BLANK = "____";

/**
 * Matches the term only where it stands alone.
 *
 * Unicode-aware rather than `\b`, which counts an accented letter as a boundary
 * and would blank the "es" inside "Este".
 */
function wordPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

/** Does this sentence use the word as a word, so it can be blanked? */
export function canCloze(text: string, term: string): boolean {
  if (!text || !term) return false;
  return wordPattern(term).test(text);
}

/**
 * The sentence with every occurrence of the word replaced by a gap.
 *
 * Every occurrence, not the first: a sentence that says the word twice would
 * otherwise print the answer beside its own blank.
 */
export function blankTerm(text: string, term: string): string {
  return text.replace(wordPattern(term), BLANK);
}
