import { describe, expect, it } from "vitest";
import {
  LEARNING_STEPS,
  MAX_BOX,
  REVIEW_DAYS,
  applyAnswer,
  buildCard,
  cardKindForBox,
  dayKey,
  isCorrect,
  makeRng,
  nextDueAt,
  normalize,
  selectNext,
  stats,
} from "../../src/srs.js";
import { materialize } from "../../src/packs/index.js";
import type { ItemProgress, Progress } from "../../src/types.js";
import { DAY, MINUTE, T0, testPack, testProgress, testSettings } from "../helpers.js";

const pack = testPack();
const rng = () => makeRng(1);

function withItem(progress: Progress, item: Partial<ItemProgress> & { id: string }): Progress {
  return {
    ...progress,
    items: {
      ...progress.items,
      [item.id]: {
        stage: "review",
        box: 1,
        step: 0,
        due: T0,
        lastSeen: T0,
        seen: 0,
        correct: 0,
        lapses: 0,
        ...item,
      },
    },
  };
}

describe("card progression", () => {
  it("moves from recognising to translating to spelling as the box rises", () => {
    expect(cardKindForBox(1)).toBe("recognize");
    expect(cardKindForBox(2)).toBe("recognize");
    expect(cardKindForBox(3)).toBe("reverse");
    expect(cardKindForBox(4)).toBe("reverse");
    expect(cardKindForBox(MAX_BOX)).toBe("recall");
  });

  it("shows a teach card for a word never seen before", () => {
    const card = buildCard(pack, pack.words[0]!, null, rng());
    expect(card.kind).toBe("teach");
    expect(card.choices).toHaveLength(0);
  });

  it("builds four distinct choices with exactly one correct answer", () => {
    const word = pack.words[3]!;
    const item: ItemProgress = {
      id: word.id, stage: "learning", box: 1, step: 0,
      due: T0, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
    };
    const card = buildCard(pack, word, item, rng());
    expect(card.kind).toBe("recognize");
    expect(card.choices).toHaveLength(4);
    expect(new Set(card.choices).size).toBe(4);
    expect(card.choices[card.answerIndex]).toBe(word.gloss);
  });

  it("prefers distractors from the same part of speech", () => {
    const word = pack.words.find((w) => w.term === "correr")!;
    const item: ItemProgress = {
      id: word.id, stage: "learning", box: 1, step: 0,
      due: T0, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
    };
    const glosses = new Set(pack.words.filter((w) => w.pos === "verb").map((w) => w.gloss));
    const card = buildCard(pack, word, item, rng());
    // Guard the loop: with no choices the assertions below would never run.
    expect(card.choices).toHaveLength(4);
    // Four verbs exist, so every choice should be one.
    for (const choice of card.choices) expect(glosses.has(choice)).toBe(true);
  });

  it("asks for the target-language word once the box reaches reverse level", () => {
    const word = pack.words[4]!;
    const item: ItemProgress = {
      id: word.id, stage: "review", box: 3, step: 0,
      due: T0, lastSeen: T0, seen: 4, correct: 4, lapses: 0,
    };
    const card = buildCard(pack, word, item, rng());
    expect(card.kind).toBe("reverse");
    expect(card.prompt).toBe(word.gloss);
    expect(card.choices[card.answerIndex]).toBe(word.term);
  });
});

describe("answer checking", () => {
  const word = pack.words.find((w) => w.term === "casa")!;
  const recall = {
    kind: "recall" as const,
    word,
    prompt: word.gloss,
    choices: [],
    answerIndex: -1,
    accepted: ["casa"],
  };

  it("accepts a typed answer regardless of case, accents, or padding", () => {
    for (const text of ["casa", "CASA", "  Casa ", "cása", "casa!"]) {
      expect(isCorrect(recall, { text })).toBe(true);
    }
  });

  it("rejects an empty or wrong typed answer", () => {
    expect(isCorrect(recall, { text: "" })).toBe(false);
    expect(isCorrect(recall, { text: "   " })).toBe(false);
    expect(isCorrect(recall, { text: "perro" })).toBe(false);
  });

  it("normalises consistently", () => {
    expect(normalize("Qué")).toBe("que");
    expect(normalize("  a  b  ")).toBe("a b");
    expect(normalize("aujourd'hui")).toBe("aujourd'hui");
  });

  it("treats a teach card as always correct", () => {
    const teach = { ...recall, kind: "teach" as const };
    expect(isCorrect(teach, {})).toBe(true);
  });
});

describe("scheduling", () => {
  const settings = testSettings();

  it("introduces the highest-frequency unseen word first", () => {
    const next = selectNext(pack, testProgress(), settings, T0);
    expect(next?.word.term).toBe("uno");
    expect(next?.item).toBeNull();
  });

  it("graduates a word to review only after every learning step", () => {
    const word = pack.words[0]!;
    let progress = testProgress();
    const teach = buildCard(pack, word, null, rng());

    progress = applyAnswer(progress, word, teach, true, T0);
    expect(progress.items[word.id]!.stage).toBe("learning");
    expect(progress.items[word.id]!.due).toBe(T0 + LEARNING_STEPS[0]!);

    let now = T0;
    for (let step = 1; step < LEARNING_STEPS.length; step++) {
      now += LEARNING_STEPS[step - 1]!;
      const card = buildCard(pack, word, progress.items[word.id]!, rng());
      progress = applyAnswer(progress, word, card, true, now);
      expect(progress.items[word.id]!.stage).toBe("learning");
      expect(progress.items[word.id]!.step).toBe(step);
    }

    now += LEARNING_STEPS.at(-1)!;
    const final = buildCard(pack, word, progress.items[word.id]!, rng());
    progress = applyAnswer(progress, word, final, true, now);
    const item = progress.items[word.id]!;
    expect(item.stage).toBe("review");
    expect(item.box).toBe(2);
    expect(item.due).toBe(now + REVIEW_DAYS[2]! * DAY);
  });

  it("drops a lapsed review back into learning without wiping its history", () => {
    const word = pack.words[0]!;
    let progress = withItem(testProgress(), {
      id: word.id, stage: "review", box: 4, seen: 9, correct: 8,
    });
    const card = buildCard(pack, word, progress.items[word.id]!, rng());
    progress = applyAnswer(progress, word, card, false, T0);
    const item = progress.items[word.id]!;
    expect(item.stage).toBe("learning");
    expect(item.box).toBe(3);
    expect(item.lapses).toBe(1);
    expect(item.seen).toBe(10);
    expect(item.correct).toBe(8);
    expect(item.due).toBe(T0 + LEARNING_STEPS[0]!);
  });

  it("never pushes the box past the maximum", () => {
    const word = pack.words[0]!;
    let progress = withItem(testProgress(), { id: word.id, stage: "review", box: MAX_BOX });
    const card = buildCard(pack, word, progress.items[word.id]!, rng());
    progress = applyAnswer(progress, word, card, true, T0);
    expect(progress.items[word.id]!.box).toBe(MAX_BOX);
    expect(progress.items[word.id]!.due).toBe(T0 + REVIEW_DAYS[MAX_BOX]! * DAY);
  });

  it("never drops the box below one", () => {
    const word = pack.words[0]!;
    let progress = withItem(testProgress(), { id: word.id, stage: "learning", box: 1 });
    const card = buildCard(pack, word, progress.items[word.id]!, rng());
    progress = applyAnswer(progress, word, card, false, T0);
    expect(progress.items[word.id]!.box).toBe(1);
  });

  it("stops introducing new words once the learning queue is full", () => {
    let progress = testProgress();
    const capped = testSettings({ maxLearning: 3 });
    for (const word of pack.words.slice(0, 3)) {
      progress = withItem(progress, {
        id: word.id, stage: "learning", due: T0 + DAY,
      });
    }
    expect(selectNext(pack, progress, capped, T0)).toBeNull();
  });

  it("respects the daily cap on new words", () => {
    const progress: Progress = { ...testProgress(), introducedByDay: { [dayKey(T0)]: 2 } };
    expect(selectNext(pack, progress, testSettings({ newPerDay: 2 }), T0)).toBeNull();
    expect(selectNext(pack, progress, testSettings({ newPerDay: 3 }), T0)?.word.term).toBe("uno");
  });

  it("serves the most overdue item before anything else", () => {
    let progress = testProgress();
    progress = withItem(progress, { id: "xx:5", due: T0 - MINUTE });
    progress = withItem(progress, { id: "xx:2", due: T0 - 10 * MINUTE });
    expect(selectNext(pack, progress, testSettings(), T0)?.word.id).toBe("xx:2");
  });

  it("ignores progress rows whose word is no longer in the pack", () => {
    const progress = withItem(testProgress(), { id: "xx:9999", due: T0 - MINUTE });
    // Falls through to introducing a new word rather than crashing.
    expect(selectNext(pack, progress, testSettings(), T0)?.word.term).toBe("uno");
  });

  it("reports the earliest due time", () => {
    let progress = testProgress();
    progress = withItem(progress, { id: "xx:1", due: T0 + 5 * MINUTE });
    progress = withItem(progress, { id: "xx:2", due: T0 + MINUTE });
    expect(nextDueAt(progress)).toBe(T0 + MINUTE);
    expect(nextDueAt(testProgress())).toBeNull();
  });
});

describe("streaks and stats", () => {
  const word = pack.words[0]!;

  it("does not let a teach card inflate the streak or accuracy", () => {
    const teach = buildCard(pack, word, null, rng());
    const progress = applyAnswer(testProgress(), word, teach, true, T0);
    expect(progress.streak).toBe(0);
    expect(progress.totalAnswered).toBe(0);
    expect(progress.introducedByDay[dayKey(T0)]).toBe(1);
  });

  it("builds a streak on correct answers and resets it on a miss", () => {
    let progress = withItem(testProgress(), { id: word.id, stage: "review", box: 2 });
    const card = buildCard(pack, word, progress.items[word.id]!, rng());
    progress = applyAnswer(progress, word, card, true, T0);
    progress = applyAnswer(progress, word, card, true, T0);
    expect(progress.streak).toBe(2);
    expect(progress.bestStreak).toBe(2);
    progress = applyAnswer(progress, word, card, false, T0);
    expect(progress.streak).toBe(0);
    expect(progress.bestStreak).toBe(2);
    expect(progress.totalAnswered).toBe(3);
    expect(progress.totalCorrect).toBe(2);
  });

  it("summarises the deck", () => {
    let progress = testProgress();
    progress = withItem(progress, { id: "xx:1", stage: "learning", box: 1, due: T0 - 1 });
    progress = withItem(progress, { id: "xx:2", stage: "review", box: MAX_BOX, due: T0 + DAY });
    const s = stats(pack, progress, T0);
    expect(s).toMatchObject({
      learned: 2, total: pack.words.length, learning: 1, review: 1, mastered: 1, due: 1,
    });
  });
});

describe("determinism", () => {
  it("produces the same quiz for the same seed", () => {
    const word = pack.words[3]!;
    const item: ItemProgress = {
      id: word.id, stage: "learning", box: 1, step: 0,
      due: T0, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
    };
    const a = buildCard(pack, word, item, makeRng(99));
    const b = buildCard(pack, word, item, makeRng(99));
    expect(a.choices).toEqual(b.choices);
    expect(a.answerIndex).toBe(b.answerIndex);
  });
});

describe("the daily new-word cap across days", () => {
  const settings = testSettings({ newPerDay: 2 });
  const nextDay = T0 + DAY;

  it("keys the count on the local calendar day", () => {
    expect(dayKey(T0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayKey(T0)).not.toBe(dayKey(nextDay));
    // Same day, different hours, must be one bucket.
    expect(dayKey(T0)).toBe(dayKey(T0 + 60 * 60 * 1000));
  });

  it("stops introducing once the cap is hit, and starts again tomorrow", () => {
    let progress = testProgress();
    for (let i = 0; i < 2; i++) {
      const next = selectNext(pack, progress, settings, T0);
      expect(next, `introduction ${i + 1} should be allowed`).not.toBeNull();
      const card = buildCard(pack, next!.word, next!.item, rng());
      progress = applyAnswer(progress, next!.word, card, true, T0);
    }
    expect(progress.introducedByDay[dayKey(T0)]).toBe(2);
    expect(selectNext(pack, progress, settings, T0)).toBeNull();

    // A new day resets the allowance without any explicit rollover step.
    expect(selectNext(pack, progress, settings, nextDay)).not.toBeNull();
  });

  it("keeps only the current day, so the file does not grow forever", () => {
    let progress = testProgress();
    let now = T0;
    for (let day = 0; day < 5; day++) {
      const next = selectNext(pack, progress, settings, now);
      const card = buildCard(pack, next!.word, next!.item, rng());
      progress = applyAnswer(progress, next!.word, card, true, now);
      now += DAY;
    }
    expect(Object.keys(progress.introducedByDay)).toEqual([dayKey(now - DAY)]);
  });

  it("counts only genuinely new words, not review answers", () => {
    let progress = withItem(testProgress(), { id: "xx:1", stage: "review", box: 2 });
    const card = buildCard(pack, pack.words[0]!, progress.items["xx:1"]!, rng());
    progress = applyAnswer(progress, pack.words[0]!, card, true, T0);
    expect(progress.introducedByDay[dayKey(T0)]).toBeUndefined();
  });
});

describe("selection order is deterministic", () => {
  it("breaks a due-time tie by weakest box, then by id", () => {
    // Two items falling due in the same millisecond is common after a seeded
    // start; without a total order the pane would pick arbitrarily and seeded
    // tests would be unreproducible.
    let progress = testProgress();
    progress = withItem(progress, { id: "xx:3", due: T0, box: 3 });
    progress = withItem(progress, { id: "xx:2", due: T0, box: 1 });
    progress = withItem(progress, { id: "xx:1", due: T0, box: 1 });
    // Weakest box first; among equals, the lowest id.
    expect(selectNext(pack, progress, testSettings(), T0)?.word.id).toBe("xx:1");
  });
});

describe("sentence cards", () => {
  const withExample = materialize({
    code: "xx",
    name: "Testish",
    englishName: "Testish",
    words: [
      ["casa", "house", "noun", "feminine", "La casa es grande | The house is big"],
      ["perro", "dog", "noun", "", "El perro corre | The dog runs"],
      ["gato", "cat", "noun", "", "Un gato duerme | A cat sleeps"],
      ["libro", "book", "noun", "", "El libro es nuevo | The book is new"],
      ["mesa", "table", "noun"],
    ],
  });

  function at(box: number, word = withExample.words[0]!) {
    const item: ItemProgress = {
      id: word.id, stage: "review", box, step: 0,
      due: T0, lastSeen: T0, seen: 5, correct: 4, lapses: 0,
    };
    return buildCard(withExample, word, item, makeRng(7));
  }

  it("asks the word inside its own sentence, with the word taken out", () => {
    const card = at(4);
    expect(card.kind).toBe("cloze");
    expect(card.prompt).toContain("____");
    // The answer must not be sitting in the prompt.
    expect(card.prompt.toLowerCase()).not.toContain("casa");
    expect(card.choices).toHaveLength(4);
    expect(card.choices[card.answerIndex]).toBe("casa");
  });

  it("blanks the word even when the sentence starts with it", () => {
    const pack = materialize({
      code: "xx", name: "T", englishName: "T",
      words: [
        ["casa", "house", "noun", "", "Casa mía, casa tuya | My house, your house"],
        ["perro", "dog", "noun"],
        ["gato", "cat", "noun"],
        ["libro", "book", "noun"],
      ],
    });
    const word = pack.words[0]!;
    const card = buildCard(pack, word, {
      id: word.id, stage: "review", box: 4, step: 0,
      due: T0, lastSeen: T0, seen: 5, correct: 4, lapses: 0,
    }, makeRng(3));
    expect(card.prompt.startsWith("____")).toBe(true);
  });

  it("falls back for a word that has no sentence", () => {
    // Nothing to blank: asking would show an empty gap and no way to answer it.
    const plain = withExample.words[4]!;
    expect(plain.example).toBeUndefined();
    expect(at(4, plain).kind).toBe("reverse");
  });

  it("keeps the rest of the progression where it was", () => {
    expect(at(1).kind).toBe("recognize");
    expect(at(3).kind).toBe("reverse");
    expect(at(5).kind).toBe("recall");
  });

  it("grades a cloze like any other multiple choice", () => {
    const card = at(4);
    expect(isCorrect(card, { choice: card.answerIndex })).toBe(true);
    expect(isCorrect(card, { choice: (card.answerIndex + 1) % 4 })).toBe(false);
    // …and typing the word works too.
    expect(isCorrect(card, { text: "casa" })).toBe(true);
  });
});
