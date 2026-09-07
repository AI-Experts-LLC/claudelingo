import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PackError, listPacks, loadPack, materialize, savePack } from "../../src/packs/index.js";
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

describe("saving a generated pack", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CLAUDELINGO_HOME;
  });

  function isolate(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudelingo-packs-"));
    homes.push(dir);
    process.env.CLAUDELINGO_HOME = dir;
    return dir;
  }

  it("writes a valid pack and loads it straight back", () => {
    const home = isolate();
    const file = savePack({
      code: "pt", name: "Português", englishName: "Portuguese",
      words: [["de", "of", "prep"], ["casa", "house", "noun", "feminine"]],
    });
    expect(file).toBe(path.join(home, "packs", "pt.json"));
    const pack = loadPack("pt");
    expect(pack.englishName).toBe("Portuguese");
    expect(pack.words[1]).toMatchObject({ id: "pt:2", term: "casa", note: "feminine" });
  });

  it("refuses to write a pack that would fail on every later load", () => {
    // Validating here turns one clear failure at generation time into zero
    // mysterious failures later.
    const home = isolate();
    expect(() =>
      savePack({
        code: "pt", name: "P", englishName: "Portuguese",
        words: [["de", "of", "prep"], ["de", "from", "prep"]],
      }),
    ).toThrow(PackError);
    expect(fs.existsSync(path.join(home, "packs", "pt.json"))).toBe(false);
  });

  it("leaves no temp file behind", () => {
    const home = isolate();
    savePack({ code: "pt", name: "P", englishName: "Portuguese", words: [["de", "of", "prep"]] });
    expect(fs.readdirSync(path.join(home, "packs")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("untrusted pack text", () => {
  // Packs are model-generated by `pack generate` or hand-placed, so their text is
  // input, not data we wrote. A newline turns Claude Code's one-line status area
  // into two lines; a raw ESC injects arbitrary escape sequences into it.
  const ESC = String.fromCharCode(27);

  function fields(pack: ReturnType<typeof materialize>): string[] {
    return [
      pack.name,
      pack.englishName,
      ...pack.words.flatMap((w) => [w.term, w.gloss, w.pos, w.note ?? ""]),
    ];
  }

  it("strips control characters from every field", () => {
    const pack = materialize({
      code: "zz",
      name: "Ze\nd",
      englishName: "Ze\td",
      words: [
        ["ter\nm", "gl\noss", "noun", "no\rte"],
        [`${ESC}[31mred${ESC}[0m`, "colour", "adj"],
      ],
    });
    // Asserted on the values themselves: JSON.stringify escapes a raw ESC into
    // the six characters "\\u001b", so a check against the serialised form could
    // never fail.
    for (const field of fields(pack)) {
      expect(field, JSON.stringify(field)).not.toMatch(/\p{Cc}/u);
    }
    expect(pack.words[0]?.term).toBe("ter m");
    expect(pack.words[0]?.note).toBe("no te");
    expect(pack.words[1]?.term).toBe("[31mred [0m");
    expect(pack.name).toBe("Ze d");
  });

  it("still rejects an entry that is only control characters", () => {
    expect(() =>
      materialize({ code: "zz", name: "Z", englishName: "Z", words: [["\n\t", "gloss", "noun"]] }),
    ).toThrow(PackError);
  });

  it("leaves ordinary accented and non-Latin text alone", () => {
    const pack = materialize({
      code: "zz", name: "Español", englishName: "Spanish",
      words: [["qué", "what", "pron"], ["日本語", "Japanese", "noun"]],
    });
    expect(pack.words[0]?.term).toBe("qué");
    expect(pack.words[1]?.term).toBe("日本語");
    expect(pack.name).toBe("Español");
  });
});
