import { describe, expect, it } from "vitest";
import { PackError, listPacks, loadPack, materialize } from "../../src/packs/index.js";
import { buildCard, isCorrect, makeRng } from "../../src/srs.js";
import type { ItemProgress } from "../../src/types.js";

const SHIPPED = ["es", "fr", "it"] as const;
const VALID_POS = new Set([
  "noun", "verb", "adj", "adv", "prep", "conj", "pron", "art", "num", "interj",
]);

describe("pack format", () => {
  it("assigns stable ids and frequency ranks", () => {
    const pack = materialize({
      code: "zz", name: "Z", englishName: "Zed",
      words: [["a", "one", "num"], ["b", "two", "num"]],
    });
    expect(pack.words[0]).toMatchObject({ id: "zz:1", rank: 1, term: "a" });
    expect(pack.words[1]).toMatchObject({ id: "zz:2", rank: 2, term: "b" });
  });

  it("keeps an optional note", () => {
    const pack = materialize({
      code: "zz", name: "Z", englishName: "Zed",
      words: [["casa", "house", "noun", "feminine"]],
    });
    expect(pack.words[0]?.note).toBe("feminine");
  });

  it("rejects a duplicate term", () => {
    expect(() =>
      materialize({
        code: "zz", name: "Z", englishName: "Zed",
        words: [["a", "one", "num"], ["a", "uno", "num"]],
      }),
    ).toThrow(PackError);
  });

  it("rejects an incomplete entry", () => {
    expect(() =>
      materialize({ code: "zz", name: "Z", englishName: "Zed", words: [["a", "", "num"]] }),
    ).toThrow(/needs/);
  });

  it("rejects a pack with no words array", () => {
    expect(() => materialize({ code: "zz" } as never)).toThrow(PackError);
  });

  it("explains itself when a language is not installed", () => {
    expect(() => loadPack("qq")).toThrow(/no pack for "qq"/);
  });
});

describe("shipped packs", () => {
  it("ships Spanish, French and Italian", () => {
    for (const code of SHIPPED) expect(listPacks()).toContain(code);
  });

  it.each(SHIPPED)("%s loads, is substantial, and is internally consistent", (code) => {
    const pack = loadPack(code);
    expect(pack.words.length).toBeGreaterThanOrEqual(300);
    expect(pack.englishName).toBeTruthy();
    expect(pack.name).toBeTruthy();

    const terms = new Set<string>();
    for (const word of pack.words) {
      expect(word.term.trim()).toBe(word.term);
      expect(word.gloss.trim()).toBe(word.gloss);
      expect(word.term.length).toBeGreaterThan(0);
      expect(word.gloss.length).toBeGreaterThan(0);
      expect(VALID_POS.has(word.pos)).toBe(true);
      expect(terms.has(word.term)).toBe(false);
      terms.add(word.term);
    }
  });

  it.each(SHIPPED)("%s glosses every word distinctly", (code) => {
    // A reverse or recall card shows only the gloss, so two words sharing one
    // would produce a question with two right answers.
    const seen = new Map<string, string>();
    for (const word of loadPack(code).words) {
      const clash = seen.get(word.gloss);
      expect(clash, `${code}: "${word.gloss}" glosses both ${clash} and ${word.term}`).toBeUndefined();
      seen.set(word.gloss, word.term);
    }
  });

  it.each(SHIPPED)("%s can build a fair card for every single word", (code) => {
    const pack = loadPack(code);
    for (const word of pack.words) {
      for (const box of [1, 3]) {
        const item: ItemProgress = {
          id: word.id, stage: "review", box, step: 0,
          due: 0, lastSeen: 0, seen: 1, correct: 1, lapses: 0,
        };
        const card = buildCard(pack, word, item, makeRng(word.rank * 31 + box));
        expect(card.choices, `${code}:${word.term} box ${box}`).toHaveLength(4);
        expect(new Set(card.choices).size, `${code}:${word.term} box ${box}`).toBe(4);
        expect(card.choices[card.answerIndex]).toBe(box === 1 ? word.gloss : word.term);
      }
    }
  });

  it.each(SHIPPED)("%s can be spelled out from its gloss at the top box", (code) => {
    const pack = loadPack(code);
    for (const word of pack.words) {
      const item: ItemProgress = {
        id: word.id, stage: "review", box: 5, step: 0,
        due: 0, lastSeen: 0, seen: 1, correct: 1, lapses: 0,
      };
      const card = buildCard(pack, word, item, makeRng(1));
      expect(card.kind).toBe("recall");
      expect(isCorrect(card, { text: word.term })).toBe(true);
    }
  });

  it.each(SHIPPED)("%s starts with genuinely high-frequency function words", (code) => {
    const pack = loadPack(code);
    const openers = pack.words.slice(0, 20).map((w) => w.pos);
    const functionWords = openers.filter((pos) =>
      ["art", "prep", "conj", "pron", "verb", "adv"].includes(pos),
    );
    expect(functionWords.length).toBeGreaterThanOrEqual(15);
  });
});
