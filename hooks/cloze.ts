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
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, "giu");
}

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scripts written without spaces between words.
 *
 * In these the letter beside a word is usually the next word, so the pattern
 * above rejects almost every sentence: of a hundred generated Japanese examples
 * it kept two. A plain substring test is no better the other way, blanking the
 * 年 inside 来年. The platform's segmenter knows where the words are from a
 * dictionary, so a term in one of these scripts counts only where it starts and
 * ends on a word boundary the segmenter found.
 */
const UNSPACED =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Where the term stands as a word, as start and end offsets into the text. */
function spans(text: string, term: string): Array<[number, number]> {
  if (!text || !term) return [];

  if (!UNSPACED.test(term)) {
    return [...text.matchAll(wordPattern(term))].map((m) => [m.index, m.index + m[0].length]);
  }

  const edges = new Set<number>();
  for (const { index, segment } of segmenter.segment(text)) {
    edges.add(index);
    edges.add(index + segment.length);
  }

  return [...text.matchAll(new RegExp(escape(term), "giu"))]
    .map((m): [number, number] => [m.index, m.index + m[0].length])
    .filter(([start, end]) => edges.has(start) && edges.has(end));
}

/** Does this sentence use the word as a word, so it can be blanked? */
export function canCloze(text: string, term: string): boolean {
  return spans(text, term).length > 0;
}

/**
 * The sentence with every occurrence of the word replaced by a gap.
 *
 * Every occurrence, not the first: a sentence that says the word twice would
 * otherwise print the answer beside its own blank.
 */
export function blankTerm(text: string, term: string): string {
  let blanked = "";
  let from = 0;
  for (const [start, end] of spans(text, term)) {
    blanked += text.slice(from, start) + BLANK;
    from = end;
  }
  return blanked + text.slice(from);
}
