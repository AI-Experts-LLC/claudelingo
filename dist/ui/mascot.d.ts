/**
 * A small owl that reacts to what is happening.
 *
 * Deliberately tiny and pure ASCII: the pane can be 30 columns wide, it has to
 * survive a terminal with no unicode, and every line here is measured by the same
 * column-aware code that draws the border. Six columns, three rows.
 */
export type Mood = "asleep" | "watching" | "asking" | "happy" | "oops" | "proud";
/** Widest line of any mood, so callers can reserve a fixed gutter. */
export declare const MASCOT_WIDTH: number;
export declare const MASCOT_HEIGHT = 3;
export declare function owl(mood: Mood): string[];
/** A short line of encouragement, chosen by how things are going. */
export declare function remark(mood: Mood, streak: number): string;
