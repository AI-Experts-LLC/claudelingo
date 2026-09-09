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
export declare const BLANK = "____";
/** Does this sentence use the word as a word, so it can be blanked? */
export declare function canCloze(text: string, term: string): boolean;
/**
 * The sentence with every occurrence of the word replaced by a gap.
 *
 * Every occurrence, not the first: a sentence that says the word twice would
 * otherwise print the answer beside its own blank.
 */
export declare function blankTerm(text: string, term: string): string;
