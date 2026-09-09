/**
 * A small owl that reacts to what is happening.
 *
 * Deliberately tiny and pure ASCII: the pane can be 30 columns wide, it has to
 * survive a terminal with no unicode, and every line here is measured by the same
 * column-aware code that draws the border. Six columns, three rows.
 */
export type Mood = "asleep" | "watching" | "asking" | "happy" | "oops" | "proud";

const OWLS: Record<Mood, string[]> = {
  // Claude is idle; so is the owl.
  asleep: [" ,___,", " (-.-)", " /)_)"],
  // A card is up and waiting for an answer.
  watching: [" ,___,", " (o.o)", " /)_)"],
  // Offering a quiz, head tilted.
  asking: [" ,___,", " (o.-)", " /)_)"],
  happy: [" ,___,", " (^.^)", " /)_)"],
  oops: [" ,___,", " (o.O)", " /)_)"],
  // A streak worth noticing.
  proud: [" ,___,", " (^o^)", " /)_)"],
};


/** The closed-eye frame for the moods that hold still long enough to blink. */
const BLINKS: Partial<Record<Mood, string[]>> = {
  watching: [" ,___,", " (-.-)", " /)_)"],
  asking: [" ,___,", " (-.-)", " /)_)"],
  happy: [" ,___,", " (^.^)", " /)_)"],
  proud: [" ,___,", " (^o^)", " /)_)"],
};

/** Widest line of any mood, so callers can reserve a fixed gutter. */
export const MASCOT_WIDTH = Math.max(
  ...Object.values(OWLS).flatMap((lines) => lines.map((l) => l.length)),
);

export const MASCOT_HEIGHT = 3;

/**
 * The face, at a moment in time.
 *
 * The status line re-runs on a timer, so consecutive runs are frames: passing a
 * `tick` lets the owl blink instead of staring. Everything stays deterministic —
 * the same tick always draws the same frame — because a status line has no memory
 * between runs and each one has to be able to work out the whole picture alone.
 */
export function owl(mood: Mood, tick = 0): string[] {
  const lines = OWLS[mood];
  const blinking = BLINKS[mood];
  // Blink on one frame in four: often enough to be alive, rare enough not to
  // read as a flicker.
  const frame = blinking && Math.abs(Math.floor(tick)) % 4 === 3 ? blinking : lines;
  // Padded to a fixed box so the text beside it never shifts as the mood changes.
  return frame.map((line) => line.padEnd(MASCOT_WIDTH, " "));
}

/** A short line of encouragement, chosen by how things are going. */
export function remark(mood: Mood, streak: number): string {
  if (mood === "proud") return `${streak} in a row`;
  if (mood === "happy") return streak > 1 ? `${streak} in a row` : "nice";
  if (mood === "oops") return "it happens";
  return "";
}
