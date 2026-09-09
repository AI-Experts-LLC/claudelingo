import { MAX_BOX } from "./srs.js";
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
export const WORD_MS = 12_000;
/** Fraction of that spent hidden, before the meaning is revealed. */
const HIDDEN_FRACTION = 0.5;
/** How many candidates to rotate through, so the line is not one word forever. */
const ROTATION = 12;
/**
 * Words worth putting in front of someone right now, most useful first: whatever
 * is overdue, then whatever is still being learned, then the next new word.
 */
function candidates(pack, progress, now) {
    const byId = new Map(pack.words.map((w) => [w.id, w]));
    const out = [];
    for (const item of Object.values(progress.items)) {
        const word = byId.get(item.id);
        if (!word)
            continue;
        if (item.due <= now)
            out.push({ word, rank: item.due });
        else if (item.stage === "learning")
            out.push({ word, rank: now + item.due });
    }
    out.sort((a, b) => a.rank - b.rank);
    if (out.length < ROTATION) {
        // Top up with the next words the deck would teach, so a fresh install still
        // has something to show.
        for (const word of pack.words) {
            if (out.length >= ROTATION)
                break;
            if (!progress.items[word.id])
                out.push({ word, rank: Number.MAX_SAFE_INTEGER });
        }
    }
    return out.slice(0, ROTATION);
}
/** The state behind the line, separated so it can be asserted without parsing text. */
export function statusLineState(pack, progress, now) {
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
function trim(text, width) {
    // Guarding at `<= 4` let a caller asking for a 4-column line get a 49-column
    // one. The CLI never asks for that, but a public export should not overflow
    // whatever it was handed.
    if (!width || width <= 0)
        return text;
    return truncateStyled(text, width);
}
/**
 * Columns available for the line.
 *
 * Claude Code exports COLUMNS before running a status-line command, so the width
 * is there for the taking; the installed command is a bare `claudelingo
 * statusline` with no `--width`.
 */
export function defaultWidth(env = process.env) {
    const columns = Number(env.COLUMNS);
    if (!Number.isFinite(columns) || columns <= 0)
        return undefined;
    // A very narrow terminal still wants truncation; disabling it there would wrap
    // the line, which is worse than a short one.
    return Math.max(8, Math.floor(columns));
}
export function renderStatusLine(pack, progress, now, options = {}) {
    const color = options.color ?? true;
    const dim = (s) => (color ? `${ansi.dim}${s}${ansi.reset}` : s);
    const cyan = (s) => (color ? `${ansi.cyan}${s}${ansi.reset}` : s);
    const bold = (s) => (color ? `${ansi.bold}${s}${ansi.reset}` : s);
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
function oneLine(text) {
    return text.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
}
function bar(fraction, cells) {
    const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
    return "█".repeat(filled) + "░".repeat(cells - filled);
}
/**
 * The rows to print, one per line.
 *
 * A pending card takes the panel over: while a question is outstanding the panel
 * shows *that*, and never the answer — the drill's reveal would hand over the
 * meaning of the very word being asked about.
 */
export function renderPanel(pack, progress, now, options = {}) {
    const width = options.width;
    if (width !== undefined && width < PANEL_MIN_WIDTH) {
        return [renderStatusLine(pack, progress, now, options)];
    }
    const color = options.color ?? true;
    const dim = (s) => (color ? `${ansi.dim}${s}${ansi.reset}` : s);
    const cyan = (s) => (color ? `${ansi.cyan}${s}${ansi.reset}` : s);
    const bold = (s) => (color ? `${ansi.bold}${s}${ansi.reset}` : s);
    const key = (s) => (color ? `${ansi.green}${s}${ansi.reset}` : s);
    const state = statusLineState(pack, progress, now);
    const pending = options.pending ?? null;
    const learned = `${state.learned}/${state.total}`;
    const streak = state.streak > 0 ? ` · streak ${state.streak}` : "";
    const item = state.word ? progress.items[state.word.id] : undefined;
    const box = item ? ` · box ${item.box}/${MAX_BOX}` : "";
    let head;
    let middle;
    let hint;
    if (options.paneOpen && !pending) {
        head = bold("a question is on the pane");
        middle = dim("answer it there — this line cannot take keys");
        hint = `${key("/lingo stats")}`;
    }
    else if (!pending && options.outstanding) {
        // Something is outstanding that we could not read. Saying so beats both
        // silence and the drill, which would reveal the answer to it.
        head = bold("a question is waiting");
        middle = dim("it could not be read from here");
        hint = `${key("/lingo")} ${dim("show it")}   ${key("/lingo skip")}`;
    }
    else if (pending) {
        head = bold(oneLine(pending.question));
        if (pending.kind === "teach") {
            // Nothing to get right — it is being shown a word, not tested on one.
            middle = dim("a new word — nothing to answer");
            hint = `${key("/lingo ok")} ${dim("got it")}   ${key("/lingo skip")}`;
        }
        else if (pending.choices.length) {
            middle = pending.choices
                .map((choice, i) => `${key(String(i + 1))} ${oneLine(choice)}`)
                .join("   ");
            hint =
                `${key("/lingo 1")}-${key(String(pending.choices.length))} ${dim("answer")}   ` +
                    `${key("/lingo skip")}`;
        }
        else {
            middle = dim("type the word after the command");
            hint = `${key("/lingo <answer>")}   ${key("/lingo skip")}`;
        }
    }
    else if (!state.word) {
        head = `${dim(pack.englishName)} ${dim("· all caught up")}`;
        middle = `${dim(bar(1, 10))} ${dim(learned + streak)}`;
        hint = `${key("/lingo stats")}   ${key("/lingo lang")}`;
    }
    else {
        // The same passive drill as the one-line form: the word alone first, so there
        // is a moment to retrieve it, then the meaning.
        head = `${cyan(`«${state.word.term}»`)} ${dim("=")} ${state.revealed ? bold(state.word.gloss) : dim("?")}`;
        middle = `${dim(bar(state.total ? state.learned / state.total : 0, 10))} ${dim(learned + streak + box)}`;
        hint = `${key("/lingo")} ${dim("quiz me")}   ${key("/lingo stats")}   ${key("/lingo lang")}`;
    }
    const body = [head, middle, hint];
    const gutter = width === undefined || width >= OWL_MIN_WIDTH;
    if (!gutter)
        return body.map((line) => trim(line, width));
    const mood = pending || options.outstanding || options.paneOpen
        ? "watching"
        : state.word
            ? "asking"
            : "asleep";
    const face = owl(mood);
    return body.map((line, i) => trim(`${dim(face[i] ?? "")}  ${line}`, width));
}
//# sourceMappingURL=statusline.js.map