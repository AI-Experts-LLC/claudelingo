import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../src/config.js";
import { materialize } from "../src/packs/index.js";
import { emptyProgress } from "../src/srs.js";
import type { Pack, Progress, Settings } from "../src/types.js";

export function tempHome(prefix = "claudelingo-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
  // Onboarded by default: most tests are about the quiz, not the walkthrough.
  // The walkthrough tests pass `onboarded: false` explicitly.
  return { ...DEFAULT_SETTINGS, lang: "xx", enrich: false, onboarded: true, ...overrides };
}

export function testProgress(): Progress {
  return emptyProgress("xx");
}

export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
