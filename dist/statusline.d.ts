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
export declare const WORD_MS = 8000;
/** The card `next` handed out and is waiting to grade, if there is one. */
export interface PendingCard {
    question: string;
    choices: string[];
    /** `teach` cards are an introduction: there is nothing to get right. */
    kind?: string;
}
export interface StatusLineOptions {
    /** Emit ANSI colour. Claude Code supports it; tests turn it off. */
    color?: boolean;
    /** Columns available. The line is trimmed to fit rather than wrapping. */
    width?: number;
    /**
     * A question is outstanding, even if it could not be read.
     *
     * The drill reveals meanings on a timer and ranks the most overdue word first
     * — which is the very card `next` just handed out. So an *unreadable* pending
     * file (one written by an older version, or truncated) must still silence the
     * drill, or the panel answers the question on screen. Presence on disk is the
     * signal; being able to parse it is not.
     */
    outstanding?: boolean;
    /** The outstanding question, when it could be read. */
    pending?: PendingCard | null;
    /**
     * A pane is open and holds the deck.
     *
     * It keeps its card in memory and writes no pending file, so this is the only
     * way the line knows a question is on screen — and the drill must not answer
     * it. The `/lingo` commands would be refused by that pane anyway, so this
     * state points at the pane instead of naming one.
     */
    paneOpen?: boolean;
    /** A memory hook already in the cache. Never fetched from here. */
    hook?: string | null;
}
export interface StatusLineState {
    word: Word | null;
    /** True once the meaning is showing. */
    revealed: boolean;
    learned: number;
    total: number;
    streak: number;
    /** Where this word sits in the frequency list: #1 is the commonest. */
    rank: number;
}
/**
 * The word the clock says is up.
 *
 * It walks the pack itself, in frequency order, rather than the review queue:
 * the panel is a ticker of the language's most common words, running whether or
 * not anything is due, and it is the same list every time so you get a sense of
 * where you are in it. What is *scheduled* is the pane's business, and the
 * pane's alone — this is exposure, not a quiz.
 */
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
export type PanelOptions = StatusLineOptions;
/**
 * The rows to print, one per line.
 *
 * A pending card takes the panel over: while a question is outstanding the panel
 * shows *that*, and never the answer — the drill's reveal would hand over the
 * meaning of the very word being asked about.
 */
export declare function renderPanel(pack: Pack, progress: Progress, now: number, options?: PanelOptions): string[];
