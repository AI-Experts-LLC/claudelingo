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
/**
 * The tables above MUST stay sorted and non-overlapping — the binary search below
 * silently returns wrong answers otherwise. `width.test.ts` asserts this.
 */
export declare const RANGE_TABLES: {
    readonly ZERO_WIDTH: [number, number][];
    readonly WIDE: [number, number][];
};
/** Columns occupied by a single code point: 0, 1, or 2. */
export declare function charWidth(code: number): number;
/**
 * Columns occupied by a string.
 *
 * This does NOT strip ANSI sequences — `visibleWidth` in render.ts is the one that
 * does, and every caller measuring a rendered line uses that.
 */
export declare function stringWidth(text: string): number;
/** Take the longest prefix of `text` that fits in `columns`. */
export declare function sliceToWidth(text: string, columns: number): {
    text: string;
    width: number;
};
/**
 * Truncate to a column budget while keeping ANSI styling intact.
 *
 * Escapes cost no columns but are not characters you can slice around: cutting one
 * in half leaves a bare `ESC[` that the terminal swallows along with whatever
 * follows, and dropping the closing reset leaves everything after the line styled.
 * So the string is split into escape and visible tokens first and reassembled —
 * index arithmetic over the raw string gets this wrong in ways that only show up
 * at particular widths.
 */
export declare function truncateStyled(text: string, columns: number, ellipsis?: string): string;
