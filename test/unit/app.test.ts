import { describe, expect, it } from "vitest";
import { type AppState, type Event, createState, isActive, reduce } from "../../src/ui/app.js";
import { buildCard, makeRng } from "../../src/srs.js";
import type { Progress } from "../../src/types.js";
import { MINUTE, T0, testPack, testProgress, testSettings } from "../helpers.js";

const pack = testPack();

function start(overrides: { agent?: "busy" | "idle"; settings?: object; progress?: Progress } = {}) {
  return createState(
    pack,
    overrides.progress ?? testProgress(),
    testSettings(overrides.settings ?? {}),
    overrides.agent ?? "idle",
    T0,
  );
}

function feed(state: AppState, events: Event[]) {
  let current = state;
  const effects = [];
  for (const event of events) {
    const step = reduce(current, event, pack);
    current = step.state;
    effects.push(...step.effects);
  }
  return { state: current, effects };
}

const press = (ch: string): Event => ({ type: "key", key: { ch } });
const named = (name: string): Event => ({ type: "key", key: { name } });

describe("agent gating", () => {
  it("waits while the agent is idle", () => {
    const state = start();
    expect(state.mode).toBe("waiting");
    expect(isActive(state)).toBe(false);
  });

  it("deals a card the moment the agent starts working", () => {
    const { state } = feed(start(), [{ type: "agent", state: "busy" }]);
    expect(state.mode).toBe("teach");
    expect(state.card?.word.term).toBe("uno");
  });

  it("stands down the moment the agent needs the human back", () => {
    const busy = feed(start(), [{ type: "agent", state: "busy" }]).state;
    const { state } = feed(busy, [{ type: "agent", state: "idle" }]);
    expect(state.mode).toBe("waiting");
  });

  it("resumes the same card when the agent picks work back up", () => {
    const busy = feed(start(), [{ type: "agent", state: "busy" }]).state;
    const term = busy.card?.word.term;
    const { state } = feed(busy, [
      { type: "agent", state: "idle" },
      { type: "agent", state: "busy" },
    ]);
    expect(state.mode).toBe("teach");
    expect(state.card?.word.term).toBe(term);
  });

  it("keeps quizzing through an idle agent when practice mode is on", () => {
    const busy = feed(start({ settings: { alwaysOn: true } }), [
      { type: "agent", state: "busy" },
    ]).state;
    const { state } = feed(busy, [{ type: "agent", state: "idle" }]);
    expect(state.mode).toBe("teach");
  });

  it("toggles practice mode with p", () => {
    const { state } = feed(start(), [press("p")]);
    expect(state.settings.alwaysOn).toBe(true);
    expect(state.mode).toBe("teach");
    const off = feed(state, [press("p")]).state;
    expect(off.settings.alwaysOn).toBe(false);
    expect(off.mode).toBe("waiting");
  });
});

describe("answering", () => {
  const busy = () => feed(start(), [{ type: "agent", state: "busy" }]).state;

  it("acknowledges a teach card with space and saves progress", () => {
    const { state, effects } = feed(busy(), [named("space")]);
    expect(effects.some((e) => e.type === "save")).toBe(true);
    expect(state.progress.items["xx:1"]?.stage).toBe("learning");
    expect(state.card?.word.term).toBe("dos");
  });

  it("ignores number keys on a teach card", () => {
    const { state } = feed(busy(), [press("1")]);
    expect(state.mode).toBe("teach");
    expect(state.card?.word.term).toBe("uno");
  });

  it("grades a multiple-choice answer and shows feedback", () => {
    const learned = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "learning" as const, box: 1, step: 0,
          due: T0 - MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
        },
      },
    };
    const state = feed(start({ progress: learned }), [{ type: "agent", state: "busy" }]).state;
    expect(state.mode).toBe("question");
    const correctKey = String((state.card?.answerIndex ?? 0) + 1);
    const { state: after, effects } = feed(state, [press(correctKey)]);
    expect(after.mode).toBe("feedback");
    expect(after.lastCorrect).toBe(true);
    expect(after.progress.streak).toBe(1);
    expect(effects.some((e) => e.type === "save")).toBe(true);
  });

  it("marks a wrong choice and records what was said", () => {
    const learned = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "learning" as const, box: 1, step: 0,
          due: T0 - MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
        },
      },
    };
    const state = feed(start({ progress: learned }), [{ type: "agent", state: "busy" }]).state;
    const wrong = String((((state.card?.answerIndex ?? 0) + 1) % 4) + 1);
    const after = feed(state, [press(wrong)]).state;
    expect(after.lastCorrect).toBe(false);
    expect(after.lastAnswer).not.toBe("");
    expect(after.progress.streak).toBe(0);
  });

  it("moves on from feedback with space", () => {
    const learned = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "learning" as const, box: 1, step: 0,
          due: T0 - MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
        },
      },
    };
    const state = feed(start({ progress: learned }), [{ type: "agent", state: "busy" }]).state;
    const graded = feed(state, [press("1")]).state;
    const next = feed(graded, [named("space")]).state;
    expect(next.mode).not.toBe("feedback");
  });
});

describe("typing a recall answer", () => {
  const recallProgress = {
    ...testProgress(),
    items: {
      "xx:1": {
        id: "xx:1", stage: "review" as const, box: 5, step: 0,
        due: T0 - MINUTE, lastSeen: T0, seen: 9, correct: 9, lapses: 0,
      },
    },
  };
  const open = () =>
    feed(start({ progress: recallProgress }), [{ type: "agent", state: "busy" }]).state;

  it("presents a spell-it card at the top box", () => {
    const state = open();
    expect(state.mode).toBe("question");
    expect(state.card?.kind).toBe("recall");
    expect(state.card?.choices).toHaveLength(0);
  });

  it("routes letters into the input instead of triggering shortcuts", () => {
    // "q", "s", "p" and "e" are all global shortcuts outside of a text field.
    const state = feed(open(), [press("q"), press("s"), press("p"), press("e")]).state;
    expect(state.input).toBe("qspe");
    expect(state.mode).toBe("question");
    expect(state.settings.alwaysOn).toBe(false);
  });

  it("supports backspace and spaces", () => {
    const state = feed(open(), [
      press("u"), press("n"), press("x"), named("backspace"), named("space"), press("o"),
    ]).state;
    expect(state.input).toBe("un o");
  });

  it("accepts a correct typed answer on enter", () => {
    const typed = feed(open(), [press("u"), press("n"), press("o"), named("enter")]).state;
    expect(typed.mode).toBe("feedback");
    expect(typed.lastCorrect).toBe(true);
  });

  it("refuses to submit an empty answer", () => {
    const state = feed(open(), [named("enter")]).state;
    expect(state.mode).toBe("question");
  });
});

describe("skip, help and quit", () => {
  const busy = () => feed(start(), [{ type: "agent", state: "busy" }]).state;

  it("skips without touching the streak or the box", () => {
    const learned = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "learning" as const, box: 2, step: 1,
          due: T0 - MINUTE, lastSeen: T0, seen: 4, correct: 3, lapses: 0,
        },
      },
    };
    const state = feed(start({ progress: learned }), [{ type: "agent", state: "busy" }]).state;
    const skipped = feed(state, [press("s")]).state;
    expect(skipped.progress.items["xx:1"]?.box).toBe(2);
    expect(skipped.progress.items["xx:1"]?.seen).toBe(4);
    expect(skipped.progress.streak).toBe(0);
    expect(skipped.message).toContain("skipped");
    expect(skipped.card?.word.id).not.toBe("xx:1");
  });

  it("opens and closes help", () => {
    const helped = feed(busy(), [press("?")]).state;
    expect(helped.showHelp).toBe(true);
    expect(feed(helped, [press("x")]).state.showHelp).toBe(false);
  });

  it("quits on q and on ctrl-c", () => {
    for (const event of [press("q"), named("ctrl-c")]) {
      const { state, effects } = feed(busy(), [event]);
      expect(state.mode).toBe("quit");
      expect(effects.some((e) => e.type === "quit")).toBe(true);
    }
  });
});

describe("memory hooks", () => {
  it("requests one on e and renders the reply", () => {
    const busy = feed(start({ settings: { enrich: true } }), [
      { type: "agent", state: "busy" },
    ]).state;
    const { state, effects } = feed(busy, [press("e")]);
    expect(state.enrichPending).toBe(true);
    expect(effects.some((e) => e.type === "enrich")).toBe(true);

    const filled = feed(state, [
      { type: "enriched", wordId: state.card!.word.id, text: "one, as in unicycle" },
    ]).state;
    expect(filled.enrichment).toBe("one, as in unicycle");
    expect(filled.enrichPending).toBe(false);
  });

  it("drops a reply that arrives after the card has moved on", () => {
    const busy = feed(start({ settings: { enrich: true } }), [
      { type: "agent", state: "busy" },
    ]).state;
    const later = feed(busy, [named("space")]).state;
    const stale = feed(later, [{ type: "enriched", wordId: "xx:1", text: "too late" }]).state;
    expect(stale.enrichment).toBeNull();
  });

  it("does not request one when enrichment is disabled", () => {
    const busy = feed(start({ settings: { enrich: false } }), [
      { type: "agent", state: "busy" },
    ]).state;
    const { effects } = feed(busy, [press("e")]);
    expect(effects).toHaveLength(0);
  });
});

describe("caught up", () => {
  it("shows the caught-up screen when nothing is due and the queue is full", () => {
    const full: Progress = { ...testProgress(), items: {} };
    for (let i = 1; i <= 8; i++) {
      full.items[`xx:${i}`] = {
        id: `xx:${i}`, stage: "learning", box: 1, step: 0,
        due: T0 + 10 * MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
      };
    }
    const { state } = feed(start({ progress: full }), [{ type: "agent", state: "busy" }]);
    expect(state.mode).toBe("caughtup");
  });

  it("deals a card again as soon as one falls due", () => {
    const full: Progress = { ...testProgress(), items: {} };
    for (let i = 1; i <= 8; i++) {
      full.items[`xx:${i}`] = {
        id: `xx:${i}`, stage: "learning", box: 1, step: 0,
        due: T0 + 10 * MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
      };
    }
    const caught = feed(start({ progress: full }), [{ type: "agent", state: "busy" }]).state;
    expect(caught.mode).toBe("caughtup");
    const later = feed(caught, [{ type: "tick", now: T0 + 11 * MINUTE }]).state;
    expect(later.mode).toBe("question");
  });

  it("does not deal cards on a tick while the agent is idle", () => {
    const { state } = feed(start(), [{ type: "tick", now: T0 + 60 * MINUTE }]);
    expect(state.mode).toBe("waiting");
  });
});

describe("card construction", () => {
  it("varies the distractors with the seed, and repeats them for the same seed", () => {
    const word = pack.words[3]!;
    const item = {
      id: word.id, stage: "learning" as const, box: 1, step: 0,
      due: T0, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
    };
    const a = buildCard(pack, word, item, makeRng(5));
    const b = buildCard(pack, word, item, makeRng(5));
    const c = buildCard(pack, word, item, makeRng(6));
    expect(a.choices).toEqual(b.choices);
    expect(c.choices).not.toEqual(a.choices);
  });
});

describe("resuming after the agent goes quiet", () => {
  const dueItem = (box: number, stage: "learning" | "review" = "learning"): Progress => ({
    ...testProgress(),
    items: {
      "xx:1": {
        id: "xx:1", stage, box, step: 0,
        due: T0 - MINUTE, lastSeen: T0, seen: 4, correct: 4, lapses: 0,
      },
    },
  });

  it("puts an unanswered question back exactly as it was", () => {
    const asked = feed(start({ progress: dueItem(1) }), [{ type: "agent", state: "busy" }]).state;
    expect(asked.mode).toBe("question");
    const resumed = feed(asked, [
      { type: "agent", state: "idle" },
      { type: "agent", state: "busy" },
    ]).state;
    expect(resumed.mode).toBe("question");
    expect(resumed.card?.word.id).toBe(asked.card?.word.id);
  });

  it("puts an unacknowledged teach card back", () => {
    const taught = feed(start(), [{ type: "agent", state: "busy" }]).state;
    const resumed = feed(taught, [
      { type: "agent", state: "idle" },
      { type: "agent", state: "busy" },
    ]).state;
    expect(resumed.mode).toBe("teach");
  });

  it("never re-asks a card that was already graded", () => {
    // The most common path in the app: answer a card, Claude finishes its turn,
    // you send the next prompt. Replaying the graded card double-counts it.
    const asked = feed(start({ progress: dueItem(2, "review") }), [
      { type: "agent", state: "busy" },
    ]).state;
    const graded = feed(asked, [press(String((asked.card?.answerIndex ?? 0) + 1))]).state;
    expect(graded.mode).toBe("feedback");

    const before = graded.progress.items["xx:1"]!;
    const resumed = feed(graded, [
      { type: "agent", state: "idle" },
      { type: "agent", state: "busy" },
    ]).state;

    expect(resumed.mode).not.toBe("feedback");
    expect(resumed.mode).not.toBe("question");
    const after = resumed.progress.items["xx:1"];
    // Untouched: same box, same counters. No second grading.
    if (after) {
      expect(after.seen).toBe(before.seen);
      expect(after.box).toBe(before.box);
    }
    expect(resumed.progress.totalAnswered).toBe(graded.progress.totalAnswered);
  });

  it("does not double-count across repeated idle/busy cycles", () => {
    const asked = feed(start({ progress: dueItem(2, "review") }), [
      { type: "agent", state: "busy" },
    ]).state;
    let state = feed(asked, [press(String((asked.card?.answerIndex ?? 0) + 1))]).state;
    const answered = state.progress.totalAnswered;
    for (let i = 0; i < 5; i++) {
      state = feed(state, [
        { type: "agent", state: "idle" },
        { type: "agent", state: "busy" },
      ]).state;
    }
    expect(state.progress.totalAnswered).toBe(answered);
  });
});

describe("skipping a brand-new word", () => {
  it("actually defers it instead of showing it straight back", () => {
    const busy = feed(start(), [{ type: "agent", state: "busy" }]).state;
    const first = busy.card?.word.id;
    const { state, effects } = feed(busy, [press("s")]);
    expect(state.card?.word.id).not.toBe(first);
    expect(state.message).toContain("skipped");
    // The deferral has to be persisted, or the next launch shows it again.
    expect(effects.some((e) => e.type === "save")).toBe(true);
    expect(state.progress.items[first as string]?.due).toBeGreaterThan(state.now);
    // and it must not count as learned or answered
    expect(state.progress.items[first as string]?.stage).toBe("new");
    expect(state.progress.totalAnswered).toBe(0);
  });
});

describe("escaping a typed answer", () => {
  const recallProgress: Progress = {
    ...testProgress(),
    items: {
      "xx:1": {
        id: "xx:1", stage: "review", box: 5, step: 0,
        due: T0 - MINUTE, lastSeen: T0, seen: 9, correct: 9, lapses: 0,
      },
    },
  };

  it("clears a half-typed answer on the first press", () => {
    const open = feed(start({ progress: recallProgress }), [
      { type: "agent", state: "busy" },
    ]).state;
    const typed = feed(open, [press("u"), press("n")]).state;
    const cleared = feed(typed, [named("escape")]).state;
    expect(cleared.input).toBe("");
    expect(cleared.mode).toBe("question");
  });

  it("skips the card on a second press, the one mode with no other way out", () => {
    const open = feed(start({ progress: recallProgress }), [
      { type: "agent", state: "busy" },
    ]).state;
    const skipped = feed(open, [named("escape")]).state;
    expect(skipped.message).toContain("skipped");
    expect(skipped.progress.totalAnswered).toBe(0);
  });
});

describe("surfacing failures", () => {
  it("keeps a memory-hook failure retryable and out of the content slot", () => {
    const busy = feed(start({ settings: { enrich: true } }), [
      { type: "agent", state: "busy" },
    ]).state;
    const asked = feed(busy, [press("e")]).state;
    const failed = feed(asked, [
      { type: "enrichFailed", wordId: asked.card!.word.id, message: "Connection error" },
    ]).state;

    expect(failed.enrichPending).toBe(false);
    expect(failed.enrichError).toBe("Connection error");
    // enrichment must stay null, or `e` is locked out for the rest of the card
    expect(failed.enrichment).toBeNull();

    const retried = feed(failed, [press("e")]);
    expect(retried.effects.some((e) => e.type === "enrich")).toBe(true);
    expect(retried.state.enrichError).toBeNull();
  });

  it("ignores a failure that arrives after the card moved on", () => {
    const busy = feed(start({ settings: { enrich: true } }), [
      { type: "agent", state: "busy" },
    ]).state;
    const later = feed(busy, [named("space")]).state;
    const stale = feed(later, [
      { type: "enrichFailed", wordId: "xx:1", message: "too late" },
    ]).state;
    expect(stale.enrichError).toBeNull();
  });

  it("carries a problem until it is cleared", () => {
    const busy = feed(start(), [{ type: "agent", state: "busy" }]).state;
    const broken = feed(busy, [{ type: "problem", message: "progress is not saving: EACCES" }]).state;
    expect(broken.problem).toContain("EACCES");
    // and it survives moving to the next card
    const next = feed(broken, [named("space")]).state;
    expect(next.problem).toContain("EACCES");
    expect(feed(next, [{ type: "problem", message: null }]).state.problem).toBeNull();
  });
});
