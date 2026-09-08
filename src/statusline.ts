import { MAX_BOX } from "./srs.js";
import type { Pack, Progress, Word } from "./types.js";
import { ansi } from "./ui/ansi.js";
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
export const WORD_MS = 12_000;
/** Fraction of that spent hidden, before the meaning is revealed. */
const HIDDEN_FRACTION = 0.5;

/** How many candidates to rotate through, so the line is not one word forever. */
const ROTATION = 12;

export interface StatusLineOptions {
  /** Emit ANSI colour. Claude Code supports it; tests turn it off. */
  color?: boolean;
  /** Columns available. The line is trimmed to fit rather than wrapping. */
  width?: number;
}

interface Candidate {
  word: Word;
  /** Lower sorts first. */
  rank: number;
}

/**
 * Words worth putting in front of someone right now, most useful first: whatever
 * is overdue, then whatever is still being learned, then the next new word.
 */
function candidates(pack: Pack, progress: Progress, now: number): Candidate[] {
  const byId = new Map(pack.words.map((w) => [w.id, w] as const));
  const out: Candidate[] = [];

  for (const item of Object.values(progress.items)) {
    const word = byId.get(item.id);
    if (!word) continue;
    if (item.due <= now) out.push({ word, rank: item.due });
    else if (item.stage === "learning") out.push({ word, rank: now + item.due });
  }
  out.sort((a, b) => a.rank - b.rank);

  if (out.length < ROTATION) {
    // Top up with the next words the deck would teach, so a fresh install still
    // has something to show.
    for (const word of pack.words) {
      if (out.length >= ROTATION) break;
      if (!progress.items[word.id]) out.push({ word, rank: Number.MAX_SAFE_INTEGER });
    }
  }
  return out.slice(0, ROTATION);
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
export function statusLineState(pack: Pack, progress: Progress, now: number): StatusLineState {
  const pool = candidates(pack, progress, now);
  // `now` is wall-clock in practice, but this is a public export: a negative or
  // non-finite value must not index off the end of the pool.
  const slot = Number.isFinite(now) ? Math.abs(Math.floor(now / WORD_MS)) : 0;
  const chosen = pool.length ? pool[slot % pool.length] : undefined;
  const word = chosen ? chosen.word : null;
  return {
    word,
    revealed: Number.isFinite(now) && (Math.abs(now) % WORD_MS) / WORD_MS >= HIDDEN_FRACTION,
    learned: Object.keys(progress.items).length,
    total: pack.words.length,
    streak: progress.streak,
  };
}

/**
 * Trim to the terminal width, counting columns and leaving styling closed.
 *
 * Slicing by characters would cut through the colour escapes this very function's
 * callers just added, dropping the closing reset and leaving the terminal dim.
 */
function trim(text: string, width: number | undefined): string {
  if (!width || width <= 4) return text;
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

  if (!state.word) {
    return trim(`${dim(pack.englishName)} ${dim("· all caught up")} ${stats}`, options.width);
  }

  const item = progress.items[state.word.id];
  const level = item ? dim(` · box ${item.box}/${MAX_BOX}`) : dim(" · new");
  const term = cyan(`«${state.word.term}»`);
  const answer = state.revealed ? bold(state.word.gloss) : dim("?");

  return trim(`${term} ${dim("=")} ${answer}  ${stats}${streak}${level}`, options.width);
}
