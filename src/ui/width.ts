/**
 * Terminal column width of a string.
 *
 * Code-point count is not column count: a combining accent occupies no column of
 * its own, and CJK/emoji glyphs occupy two. Packs can be generated for any
 * language, so a Japanese word list must not tear the panel border apart.
 *
 * Ranges follow Unicode TR11 (East Asian Wide and Fullwidth) plus the standard
 * zero-width categories. This is the same approach `wcwidth` takes.
 */

/** Combining marks and other zero-width code points. */
const ZERO_WIDTH: Array<[number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x0816, 0x0819],
  [0x081b, 0x0823],
  [0x0900, 0x0902],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // zero-width space through RTL mark
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], // BOM
];

/** East Asian Wide and Fullwidth, plus the emoji blocks that render double-width. */
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2600, 0x27bf], // misc symbols and dingbats, incl. warning and tick marks
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f0ff], // playing cards, mahjong
  [0x1f300, 0x1f64f], // emoji: symbols and people
  [0x1f680, 0x1f6ff], // transport and map symbols
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], // CJK extension B and beyond
  [0x30000, 0x3fffd],
];

/**
 * The tables above MUST stay sorted and non-overlapping — the binary search below
 * silently returns wrong answers otherwise. `width.test.ts` asserts this.
 */
export const RANGE_TABLES = { ZERO_WIDTH, WIDE } as const;

function inRanges(code: number, ranges: Array<[number, number]>): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid] as [number, number];
    if (code < start) high = mid - 1;
    else if (code > end) low = mid + 1;
    else return true;
  }
  return false;
}

/** Columns occupied by a single code point: 0, 1, or 2. */
export function charWidth(code: number): number {
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0; // control characters
  if (inRanges(code, ZERO_WIDTH)) return 0;
  if (inRanges(code, WIDE)) return 2;
  return 1;
}

/** Columns occupied by a string, ignoring any ANSI colour sequences it contains. */
export function stringWidth(text: string): number {
  let total = 0;
  for (const char of text) total += charWidth(char.codePointAt(0) as number);
  return total;
}

/** Take the longest prefix of `text` that fits in `columns`. */
export function sliceToWidth(text: string, columns: number): { text: string; width: number } {
  let out = "";
  let width = 0;
  for (const char of text) {
    const w = charWidth(char.codePointAt(0) as number);
    if (width + w > columns) break;
    out += char;
    width += w;
  }
  return { text: out, width };
}
