import type { Pack, Progress, Word } from "./types.js";
/**
 * The status line Claude Code draws under your prompt.
 *
 * It cannot take keystrokes — Claude Code renders the line, it does not forward
 * input to it — so this is deliberately a *passive* drill: the word appears alone
 * for a few seconds, giving you a moment to retrieve it, then the meaning appears.
 * Trying and then seeing the answer is most of what makes recall stick, and it is
 * the whole of what a display-only surface can offer.
 *
 * It is also strictly read-only. A running pane owns the deck; a status line that
 * wrote to it would fight that pane's lock and corrupt the schedule.
 */
/** How long one word holds the line before the next takes over. */
export declare const WORD_MS = 12000;
export interface StatusLineOptions {
    /** Emit ANSI colour. Claude Code supports it; tests turn it off. */
    color?: boolean;
    /** Columns available. The line is trimmed to fit rather than wrapping. */
    width?: number;
}
export interface StatusLineState {
    word: Word | null;
    /** True once the meaning is showing. */
    revealed: boolean;
    learned: number;
    total: number;
    streak: number;
}
/** The state behind the line, separated so it can be asserted without parsing text. */
export declare function statusLineState(pack: Pack, progress: Progress, now: number): StatusLineState;
/**
 * Columns available for the line.
 *
 * Claude Code exports COLUMNS before running a status-line command, so the width
 * is there for the taking; the installed command is a bare `claudelingo
 * statusline` with no `--width`.
 */
export declare function defaultWidth(env?: NodeJS.ProcessEnv): number | undefined;
export declare function renderStatusLine(pack: Pack, progress: Progress, now: number, options?: StatusLineOptions): string;
/** Rows the panel occupies. Fixed, so the terminal below it never jumps. */
export declare const PANEL_ROWS = 3;
/** The card `next` handed out and is waiting to grade, if there is one. */
export interface PendingCard {
    question: string;
    choices: string[];
    /** `teach` cards are an introduction: there is nothing to get right. */
    kind?: string;
}
export interface PanelOptions extends StatusLineOptions {
    /** The outstanding question, read from the pending file by the caller. */
    pending?: PendingCard | null;
}
/**
 * The rows to print, one per line.
 *
 * A pending card takes the panel over: while a question is outstanding the panel
 * shows *that*, and never the answer — the drill's reveal would hand over the
 * meaning of the very word being asked about.
 */
export declare function renderPanel(pack: Pack, progress: Progress, now: number, options?: PanelOptions): string[];
