/**
 * Fixtures the ported suites share.
 *
 * The CLI's version of this also made temporary home directories, because its
 * decks were files. There are no files here, so what is left is the small
 * predictable pack the scheduler is reasoned about against, and the clock the
 * due-date assertions are pinned to.
 */
import { DEFAULT_SETTINGS } from "../hooks/deck";
import { materialize } from "../hooks/pack";
import { emptyProgress } from "../hooks/srs";
import type { Pack, Progress, Settings } from "../hooks/types";

/** A small, fully predictable pack. Real packs are exercised separately. */
export function testPack(): Pack {
  return materialize({
    code: "xx",
    name: "Testish",
    englishName: "Testish",
    words: [
      ["uno", "one", "num"],
      ["dos", "two", "num"],
      ["tres", "three", "num"],
      ["casa", "house", "noun", "feminine"],
      ["perro", "dog", "noun"],
      ["gato", "cat", "noun"],
      ["libro", "book", "noun"],
      ["mesa", "table", "noun"],
      ["correr", "to run", "verb"],
      ["comer", "to eat", "verb"],
      ["beber", "to drink", "verb"],
      ["hablar", "to speak", "verb"],
      ["rojo", "red", "adj"],
      ["azul", "blue", "adj"],
      ["verde", "green", "adj"],
      ["grande", "big", "adj"],
    ],
  });
}

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, lang: "xx", enrich: false, ...overrides };
}

export function testProgress(): Progress {
  return emptyProgress("xx");
}

export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
