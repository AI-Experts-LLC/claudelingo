import { MAX_BOX } from "./srs.js";
import type { Card, Pack, Progress, Word } from "./types.js";
import { ansi } from "./ui/ansi.js";
import { MASCOT_HEIGHT, owl } from "./ui/mascot.js";
import { truncateStyled } from "./ui/width.js";

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
export const WORD_MS = 8000;
/** Fraction of that spent hidden, before the meaning is revealed. */
const HIDDEN_FRACTION = 0.5;

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
export function statusLineState(pack: Pack, progress: Progress, now: number): StatusLineState {
  const words = pack.words;
  // `now` is wall-clock in practice, but this is a public export: a negative or
  // non-finite value must not index off the end of the list.
  const slot = Number.isFinite(now) ? Math.abs(Math.floor(now / WORD_MS)) : 0;
  const index = words.length ? slot % words.length : 0;
  const word = words[index] ?? null;
  return {
    word,
    revealed: Number.isFinite(now) && (Math.abs(now) % WORD_MS) / WORD_MS >= HIDDEN_FRACTION,
    learned: Object.keys(progress.items).length,
    total: words.length,
    streak: progress.streak,
    rank: word ? index + 1 : 0,
  };
}

/**
 * Trim to the terminal width, counting columns and leaving styling closed.
 *
 * Slicing by characters would cut through the colour escapes this very function's
 * callers just added, dropping the closing reset and leaving the terminal dim.
 */
function trim(text: string, width: number | undefined): string {
  // Guarding at `<= 4` let a caller asking for a 4-column line get a 49-column
  // one. The CLI never asks for that, but a public export should not overflow
  // whatever it was handed.
  if (!width || width <= 0) return text;
  return truncateStyled(text, width);
}

/**
 * Columns available for the line.
 *
 * Claude Code exports COLUMNS before running a status-line command, so the width
 * is there for the taking; the installed command is a bare `claudelingo
 * statusline` with no `--width`.
 */
export function defaultWidth(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const columns = Number(env.COLUMNS);
  if (!Number.isFinite(columns) || columns <= 0) return undefined;
  // A very narrow terminal still wants truncation; disabling it there would wrap
  // the line, which is worse than a short one.
  return Math.max(8, Math.floor(columns));
}

export function renderStatusLine(
  pack: Pack,
  progress: Progress,
  now: number,
  options: StatusLineOptions = {},
): string {
  const color = options.color ?? true;
  const dim = (s: string) => (color ? `${ansi.dim}${s}${ansi.reset}` : s);
  const cyan = (s: string) => (color ? `${ansi.cyan}${s}${ansi.reset}` : s);
  const bold = (s: string) => (color ? `${ansi.bold}${s}${ansi.reset}` : s);

  const state = statusLineState(pack, progress, now);
  const stats = dim(`${state.learned}/${state.total}`);
  const streak = state.streak > 0 ? dim(` · streak ${state.streak}`) : "";

  if (options.paneOpen) {
    return trim(`${dim("answer it in the pane")}  ${stats}${streak}`, options.width);
  }
  if (options.outstanding || options.pending) {
    return trim(`${dim("a question is waiting")} ${dim("· /lingo")}  ${stats}${streak}`, options.width);
  }
  if (!state.word) {
    return trim(`${dim(pack.englishName)} ${dim("· all caught up")} ${stats}`, options.width);
  }

  const item = progress.items[state.word.id];
  const level = item ? dim(` · box ${item.box}/${MAX_BOX}`) : dim(" · new");
  const term = cyan(`«${state.word.term}»`);
  const answer = state.revealed ? bold(state.word.gloss) : dim("?");

  return trim(`${term} ${dim("=")} ${answer}  ${stats}${streak}${level}`, options.width);
}

/* ── The panel ───────────────────────────────────────────────────────────────
 *
 * Claude Code renders one row per line a status-line command prints, so the whole
 * widget can live under the prompt rather than a single cramped line. What it
 * still cannot do is take a keystroke: Claude Code draws this, it does not route
 * input to it. So the panel shows state and *names the command that changes it* —
 * the chat bar directly above it is the input surface.
 *
 * Everything here stays read-only, for the same reason the single line is: a
 * running pane owns the deck, and a status line that wrote to it would fight that
 * pane's lock.
 */


/** Rows the panel occupies. Fixed, so the terminal below it never jumps. */
export const PANEL_ROWS = MASCOT_HEIGHT;

/** Below this many columns the owl gutter costs more than it gives. */
const OWL_MIN_WIDTH = 46;
/** Below this, a panel cannot say anything useful; fall back to the one-liner. */
const PANEL_MIN_WIDTH = 30;

/**
 * Flatten anything that would become a second row.
 *
 * The panel's height is its promise — "always three rows, so the conversation
 * above it never jumps" — and a newline in a question breaks that however
 * carefully the caller sanitised. This is the only place that guarantees it: the
 * CLI used to clean the pending file as well, which left a line no test could
 * prove was doing anything.
 */
function oneLine(text: string): string {
  return text.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
}

function bar(fraction: number, cells: number): string {
  const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

export type PanelOptions = StatusLineOptions;

/**
 * The rows to print, one per line.
 *
 * A pending card takes the panel over: while a question is outstanding the panel
 * shows *that*, and never the answer — the drill's reveal would hand over the
 * meaning of the very word being asked about.
 */
export function renderPanel(
  pack: Pack,
  progress: Progress,
  now: number,
  options: PanelOptions = {},
): string[] {
  const width = options.width;
  if (width !== undefined && width < PANEL_MIN_WIDTH) {
    return [renderStatusLine(pack, progress, now, options)];
  }

  const color = options.color ?? true;
  const dim = (s: string) => (color ? `${ansi.dim}${s}${ansi.reset}` : s);
  const cyan = (s: string) => (color ? `${ansi.cyan}${s}${ansi.reset}` : s);
  const bold = (s: string) => (color ? `${ansi.bold}${s}${ansi.reset}` : s);
  const key = (s: string) => (color ? `${ansi.green}${s}${ansi.reset}` : s);
  const green = (s: string) => (color ? `${ansi.green}${s}${ansi.reset}` : s);

  const state = statusLineState(pack, progress, now);
  const pending = options.pending ?? null;

  const learned = `${state.learned}/${state.total}`;
  const streak = state.streak > 0 ? ` · streak ${state.streak}` : "";
  const item = state.word ? progress.items[state.word.id] : undefined;
  const box = item ? ` · box ${item.box}/${MAX_BOX}` : "";

  let head: string;
  let middle: string;
  let hint: string;

  if (options.paneOpen && !pending) {
    head = bold("a question is on the pane");
    middle = dim("answer it there — this line cannot take keys");
    hint = `${key("/lingo stats")}`;
  } else if (!pending && options.outstanding) {
    // Something is outstanding that we could not read. Saying so beats both
    // silence and the drill, which would reveal the answer to it.
    head = bold("a question is waiting");
    middle = dim("it could not be read from here");
    hint = `${key("/lingo")} ${dim("show it")}   ${key("/lingo skip")}`;
  } else if (pending) {
    head = bold(oneLine(pending.question));
    if (pending.kind === "teach") {
      // Nothing to get right — it is being shown a word, not tested on one.
      middle = dim("a new word — nothing to answer");
      hint = `${key("/lingo ok")} ${dim("got it")}   ${key("/lingo skip")}`;
    } else if (pending.choices.length) {
      middle = pending.choices
        .map((choice, i) => `${key(String(i + 1))} ${oneLine(choice)}`)
        .join("   ");
      hint =
        `${key("/lingo 1")}-${key(String(pending.choices.length))} ${dim("answer")}   ` +
        `${key("/lingo skip")}`;
    } else {
      middle = dim("type the word after the command");
      hint = `${key("/lingo <answer>")}   ${key("/lingo skip")}`;
    }
  } else if (!state.word) {
    head = `${dim(pack.englishName)} ${dim("· all caught up")}`;
    middle = `${dim(bar(1, 10))} ${dim(learned + streak)}`;
    hint = `${key("/lingo stats")}   ${key("/lingo lang")}`;
  } else {
    // A ticker, not a quiz. The word appears alone, you get a moment to reach
    // for it, then the meaning arrives — and on to the next one, for ever. The
    // quiz proper lives where answers can actually be taken: the pane, and
    // `/lingo quiz` in the chat.
    head = `${cyan(`«${state.word.term}»`)} ${dim("=")} ${
      state.revealed ? bold(state.word.gloss) : dim("?")
    }`;
    const rank = state.rank ? dim(` · #${state.rank}`) : "";
    middle = `${dim(bar(state.total ? state.learned / state.total : 0, 10))} ${dim(
      learned + streak + box,
    )}${rank}`;
    hint = `${key("/lingo quiz")}   ${key("/lingo stats")}   ${key("/lingo lang")}`;
  }

  const body = [head, middle, hint];
  const gutter = width === undefined || width >= OWL_MIN_WIDTH;
  if (!gutter) return body.map((line) => trim(line, width));

  const mood =
    pending || options.outstanding || options.paneOpen
      ? "watching"
      : state.revealed
        ? "happy"
        : state.word
          ? "watching"
          : "asleep";
  const face = owl(mood, Math.floor(Math.abs(now) / 2000));
  return body.map((line, i) => trim(`${dim(face[i] ?? "")}  ${line}`, width));
}
