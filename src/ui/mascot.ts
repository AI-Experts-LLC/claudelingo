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

/** Widest line of any mood, so callers can reserve a fixed gutter. */
export const MASCOT_WIDTH = Math.max(
  ...Object.values(OWLS).flatMap((lines) => lines.map((l) => l.length)),
);

export const MASCOT_HEIGHT = 3;

export function owl(mood: Mood): string[] {
  const lines = OWLS[mood];
  // Padded to a fixed box so the text beside it never shifts as the mood changes.
  return lines.map((line) => line.padEnd(MASCOT_WIDTH, " "));
}

/** A short line of encouragement, chosen by how things are going. */
export function remark(mood: Mood, streak: number): string {
  if (mood === "proud") return `${streak} in a row`;
  if (mood === "happy") return streak > 1 ? `${streak} in a row` : "nice";
  if (mood === "oops") return "it happens";
  return "";
}
