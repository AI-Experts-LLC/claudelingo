import { describe, expect, it } from "vitest";
import {
  RANGE_TABLES,
  charWidth,
  sliceToWidth,
  stringWidth,
  truncateStyled,
} from "../../src/ui/width.js";
import { COLOR, PLAIN, box, renderFrame, visibleWidth } from "../../src/ui/render.js";
import { materialize } from "../../src/packs/index.js";
import { createState, reduce } from "../../src/ui/app.js";
import type { Progress } from "../../src/types.js";
import { T0, testProgress, testSettings } from "../helpers.js";

/**
 * An INDEPENDENT expected-column table. The renderer's own `visibleWidth` must not
 * be used to check the renderer, or the assertion cannot fail — which is exactly
 * how a wide-character bug survives a green suite.
 */
const CASES: Array<[string, number]> = [
  ["", 0],
  ["abc", 3],
  ["café", 4], // precomposed
  ["café", 4], // e + combining acute: 5 code points, 4 columns
  ["é́", 1], // precomposed e-acute plus another combining mark
  ["日本語", 6], // three wide glyphs
  ["日本語abc", 9],
  ["한국어", 6], // Hangul syllables
  ["ａｂｃ", 6], // fullwidth Latin
  ["·…█░", 4], // the glyphs the panel itself uses
  ["«tiempo»", 8],
  ["​", 0], // zero-width space
  ["a​b", 2],
];

describe("column width", () => {
  it.each(CASES)("measures %j as %i columns", (text, expected) => {
    expect(stringWidth(text)).toBe(expected);
  });

  it("classifies single code points", () => {
    expect(charWidth("a".codePointAt(0) as number)).toBe(1);
    expect(charWidth("日".codePointAt(0) as number)).toBe(2);
    expect(charWidth(0x0301)).toBe(0); // combining acute
    expect(charWidth(0x0007)).toBe(0); // control
  });

  it("slices to a column budget without splitting a wide glyph", () => {
    expect(sliceToWidth("日本語", 4)).toEqual({ text: "日本", width: 4 });
    // 5 columns cannot fit a third 2-column glyph, so it stops at 4.
    expect(sliceToWidth("日本語", 5)).toEqual({ text: "日本", width: 4 });
    expect(sliceToWidth("abc", 2)).toEqual({ text: "ab", width: 2 });
  });
});

describe("the renderer respects columns, not code points", () => {
  it("draws a box of exact column width around wide text", () => {
    const lines = box(["日本語のテキスト", "plain"], {
      width: 30, title: "日本語", footer: "テスト", theme: PLAIN,
    });
    for (const line of lines) expect(stringWidth(line)).toBe(30);
  });

  it("truncates wide content to the panel without overrunning the border", () => {
    const lines = box(["日".repeat(40)], { width: 24, title: "t", footer: "f", theme: PLAIN });
    for (const line of lines) expect(stringWidth(line)).toBe(24);
  });

  it("keeps a whole frame exact for a generated non-Latin pack", () => {
    // `claudelingo pack generate` is a documented feature, so a Japanese pack is
    // an expected input, not a hypothetical one.
    const pack = materialize({
      code: "ja", name: "日本語", englishName: "Japanese",
      words: [
        ["私", "I", "pron"],
        ["時間", "time", "noun"],
        ["食べる", "to eat", "verb"],
        ["大きい", "big", "adj"],
        ["水", "water", "noun"],
        ["家", "house", "noun"],
        ["本", "book", "noun"],
        ["犬", "dog", "noun"],
      ],
    });
    let state = createState(pack, testProgress(), testSettings({ lang: "ja" }), "idle", T0);
    state = reduce(state, { type: "agent", state: "busy" }, pack).state;

    for (const width of [30, 46, 58, 80]) {
      const lines = renderFrame(state, pack, width, PLAIN);
      for (const line of lines) {
        expect(stringWidth(line), `"${line}" at width ${width}`).toBe(width);
      }
    }
  });

  it("keeps a frame exact when the answer is typed in decomposed form", () => {
    const pack = materialize({
      code: "xx", name: "X", englishName: "X",
      words: [["café", "coffee", "noun"], ["b", "two", "num"], ["c", "three", "num"], ["d", "four", "num"]],
    });
    // A top-box item, so the card is `recall` and keystrokes reach `state.input`.
    // Without this the reducer sits in `teach`, discards the keys, and the frame
    // under test is plain ASCII — an assertion that cannot fail.
    const progress: Progress = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "review", box: 5, step: 0,
          due: T0 - 1000, lastSeen: T0, seen: 9, correct: 9, lapses: 0,
        },
      },
    };
    let state = createState(pack, progress, testSettings({ lang: "xx" }), "idle", T0);
    state = reduce(state, { type: "agent", state: "busy" }, pack).state;
    expect(state.card?.kind).toBe("recall");

    // NFD "café" — five code points, four columns.
    for (const ch of ["c", "a", "f", "e", "\u0301"]) {
      state = reduce(state, { type: "key", key: { ch } }, pack).state;
    }
    expect(state.input).toBe("cafe\u0301");
    expect([...state.input].length).toBe(5);
    expect(stringWidth(state.input)).toBe(4);

    const frame = renderFrame(state, pack, 40, PLAIN);
    expect(frame.join("\n")).toContain(state.input);
    for (const line of frame) expect(stringWidth(line)).toBe(40);
  });

  it("strips colour codes before measuring, unlike the raw column measure", () => {
    // `visibleWidth` is defined in terms of `stringWidth`, so comparing the two on
    // plain text proves nothing — they are the same call. What is worth pinning is
    // the difference: the ANSI strip that only `visibleWidth` performs.
    const coloured = `${COLOR.bold}hi${COLOR.reset}`;
    expect(visibleWidth(coloured)).toBe(2);
    expect(stringWidth(coloured)).toBeGreaterThan(2);
    // and it still counts columns, not code points, once stripped
    expect(visibleWidth(`${COLOR.cyan}日本${COLOR.reset}`)).toBe(4);
  });
});

describe("the range tables themselves", () => {
  // The binary search returns wrong answers, silently, if either table is
  // unsorted or has overlapping entries — which is easy to do when adding a block.
  it.each(Object.entries(RANGE_TABLES))("%s is sorted and non-overlapping", (_name, ranges) => {
    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i] as [number, number];
      expect(start).toBeLessThanOrEqual(end);
      if (i > 0) {
        const previousEnd = (ranges[i - 1] as [number, number])[1];
        expect(start).toBeGreaterThan(previousEnd);
      }
    }
  });

  it("measures combining marks outside Latin as zero columns", () => {
    // A hand-written table covered Latin accents and missed everything else;
    // packs can be generated for any language, so these have to be right.
    for (const [name, cp] of [
      ["Devanagari sign nukta", 0x093c],
      ["Devanagari vowel sign u", 0x0941],
      ["Arabic fatha", 0x064b],
      ["Hebrew point sheva", 0x05b0],
      ["Tibetan vowel sign i", 0x0f72],
      ["Myanmar vowel sign i", 0x102d],
      ["Thai character mai ek", 0x0e48],
      ["Balinese sign rerekan", 0x1b34],
    ] as const) {
      expect(charWidth(cp), `${name} should be zero columns`).toBe(0);
    }
  });

  it("measures wide code points outside the CJK blocks", () => {
    for (const [name, cp] of [
      ["angle bracket", 0x2329],
      ["black large square", 0x2b1b],
      ["white circle large", 0x2b55],
      ["hourglass", 0x231a],
    ] as const) {
      expect(charWidth(cp), `${name} should be two columns`).toBe(2);
    }
  });

  it("measures a narrow dingbat as one column", () => {
    // The Misc Symbols block is narrow as a whole; only some code points in it are
    // wide, so it must not be included wholesale.
    expect(stringWidth("✓")).toBe(1);
    expect(stringWidth("✗")).toBe(1);
    expect(stringWidth("·")).toBe(1);
  });

  it("measures the emoji a memory hook or a generated pack might contain", () => {
    // These arrive in model output, so they reach the panel even though the
    // shipped es/fr/it packs are pure Latin.
    // Unambiguously double-width code points. Emoji presentation sequences such
    // as U+26A0 U+FE0F are deliberately excluded: terminals disagree about them.
    for (const emoji of ["🚀", "✅", "🎴", "🔥", "📚", "🩰"]) {
      expect(stringWidth(emoji), `${emoji} should be two columns`).toBe(2);
    }
  });
});

describe("truncating styled text", () => {
  const ESC = String.fromCharCode(27);
  const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  const plain = (s: string) => s.replace(SGR, "");

  const samples = [
    `${ESC}[36m«el»${ESC}[0m ${ESC}[2m=${ESC}[0m ${ESC}[1mthe (m.)${ESC}[0m  ${ESC}[2m20/312${ESC}[0m`,
    `${ESC}[36m«日本語»${ESC}[0m ${ESC}[1mJapanese${ESC}[0m`,
    `café ${ESC}[2mcombining${ESC}[0m`,
    `${ESC}[31m${"x".repeat(50)}${ESC}[0m`,
    "no styling at all, just text",
  ];

  it("never leaves a half-written escape sequence", () => {
    // Slicing a styled string by character index cuts through escapes, and the
    // terminal then swallows the bare ESC[ along with whatever follows it.
    for (const sample of samples) {
      for (let width = 1; width <= 60; width++) {
        expect(plain(truncateStyled(sample, width)), `${width}`).not.toContain(ESC);
      }
    }
  });

  it("never exceeds the column budget", () => {
    for (const sample of samples) {
      for (let width = 1; width <= 60; width++) {
        expect(stringWidth(plain(truncateStyled(sample, width))), `${width}`).toBeLessThanOrEqual(
          width,
        );
      }
    }
  });

  it("always closes the styling it cut through", () => {
    for (const sample of samples.filter((s) => s.includes(ESC))) {
      for (let width = 2; width <= 60; width++) {
        const out = truncateStyled(sample, width);
        if (out.includes(ESC)) expect(out.endsWith(`${ESC}[0m`), `${width}`).toBe(true);
      }
    }
  });

  it("keeps the styling of the text it kept", () => {
    // Closing the styling is not enough: dropping the escapes would produce a
    // correctly-terminated but entirely colourless line.
    const styled = `${ESC}[36mcyan${ESC}[0m ${ESC}[1mbold${ESC}[0m tail`;
    for (let width = 6; width <= 14; width++) {
      const out = truncateStyled(styled, width);
      expect(out, `width ${width}`).toContain(`${ESC}[36m`);
      expect(plain(out).startsWith("cyan"), `width ${width}`).toBe(true);
    }
    // And a later run of styling survives when it is inside the budget.
    const wide = truncateStyled(styled, 12);
    expect(wide).toContain(`${ESC}[1m`);
  });

  it("leaves a string that already fits completely alone", () => {
    for (const sample of samples) {
      expect(truncateStyled(sample, 200)).toBe(sample);
    }
  });

  it("does not split a wide glyph across the boundary", () => {
    const out = truncateStyled("日本語です", 5);
    expect(stringWidth(plain(out))).toBeLessThanOrEqual(5);
    expect(plain(out)).not.toContain("�");
  });

  it("returns nothing for a nonsensical budget", () => {
    expect(truncateStyled("anything", 0)).toBe("");
    expect(truncateStyled("anything", -5)).toBe("");
  });
});

describe("the truncation marker itself", () => {
  it("budgets for the whole marker, not just its first code point", () => {
    // A multi-character or wide marker would otherwise push the line over.
    for (const marker of ["...", "…", "»»", "："]) {
      for (let width = 2; width <= 12; width++) {
        const out = truncateStyled("abcdefghijklmnop", width, marker);
        expect(stringWidth(out), `${JSON.stringify(marker)} at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });
});
