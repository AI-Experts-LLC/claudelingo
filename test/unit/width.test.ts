import { describe, expect, it } from "vitest";
import { charWidth, sliceToWidth, stringWidth } from "../../src/ui/width.js";
import { PLAIN, box, renderFrame, visibleWidth } from "../../src/ui/render.js";
import { materialize } from "../../src/packs/index.js";
import { createState, reduce } from "../../src/ui/app.js";
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
      words: [["a", "one", "num"], ["b", "two", "num"], ["c", "three", "num"], ["d", "four", "num"]],
    });
    let state = createState(pack, testProgress(), testSettings(), "idle", T0);
    state = reduce(state, { type: "agent", state: "busy" }, pack).state;
    // NFD "é" — one visible column made of two code points.
    for (const ch of ["e", "́", "e", "́"]) {
      state = reduce(state, { type: "key", key: { ch } }, pack).state;
    }
    for (const line of renderFrame(state, pack, 40, PLAIN)) {
      expect(stringWidth(line)).toBe(40);
    }
  });

  it("agrees with the renderer's own measure for plain ASCII", () => {
    // A guard that the two measures have not silently diverged for the common case.
    expect(visibleWidth("hello")).toBe(stringWidth("hello"));
  });
});
