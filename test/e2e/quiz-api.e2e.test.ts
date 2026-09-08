import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type Env,
  Pane,
  REPO,
  cli,
  makeEnv,
  progressFile,
  readProgress,
  requireBuild,
} from "./harness.js";

let env: Env;
let pane: Pane | null = null;

beforeAll(requireBuild);
afterEach(() => {
  pane?.kill();
  pane = null;
  env?.cleanup();
});

function fresh(): Env {
  env = makeEnv();
  return env;
}

async function next(e: Env, extra: string[] = []) {
  const { stdout, code } = await cli(["next", "--json", ...extra], e);
  expect(code).toBe(0);
  return JSON.parse(stdout.trim());
}

async function answer(e: Env, args: string[]) {
  const { stdout, code } = await cli(["answer", ...args], e);
  expect(code).toBe(0);
  return JSON.parse(stdout.trim());
}

describe("the quiz the /lingo skill drives", () => {
  it("hands out a card without ever revealing the answer", async () => {
    // The whole point: Claude asks the question and passes back the choice. If
    // the right answer were in this payload it would be in the transcript before
    // the user replied, and a model could mark its own homework.
    const e = fresh();
    const first = await next(e);
    expect(first.card.question).toContain("el");
    expect(JSON.stringify(first)).not.toContain("answerIndex");
    expect(JSON.stringify(first)).not.toContain("accepted");
    expect(first.card).not.toHaveProperty("answerIndex");
  });

  it("grades multiple choice against the card it handed out", async () => {
    const e = fresh();
    // Get past the teach card to a real question.
    await next(e);
    await answer(e, ["--choice", "1"]);
    const card = await next(e);
    expect(card.card.kind).toBe("teach");
  });

  it("records the answer in the deck", async () => {
    const e = fresh();
    await next(e);
    const graded = await answer(e, ["--choice", "1"]);
    expect(graded.correct).toBe(true);
    expect(graded.term).toBe("el");
    const progress = readProgress(e, "es") as { items: Record<string, unknown> };
    expect(Object.keys(progress.items)).toEqual(["es:1"]);
  });

  /** Seed one overdue review card so the question really has four options. */
  function seedDue(e: Env): void {
    const now = Date.now();
    fs.writeFileSync(
      progressFile(e, "es"),
      JSON.stringify({
        version: 1, lang: "es",
        items: {
          "es:1": {
            id: "es:1", stage: "review", box: 2, step: 0,
            due: now - 60_000, lastSeen: now, seen: 4, correct: 4, lapses: 0,
          },
        },
        streak: 3, bestStreak: 3, totalAnswered: 4, totalCorrect: 4, introducedByDay: {},
      }),
    );
  }

  /** The gloss of es:1, read from the built pack rather than hard-coded. */
  function glossOfFirstWord(): string {
    const pack = JSON.parse(
      fs.readFileSync(path.join(REPO, "dist", "packs", "es.json"), "utf8"),
    ) as { words: string[][] };
    return (pack.words[0] as string[])[1] as string;
  }

  it("grades the option the user actually picked", async () => {
    // Answering changes the card's state, so right and wrong are checked on two
    // identical decks rather than in a loop over one.
    const gloss = glossOfFirstWord();

    const right = makeEnv();
    try {
      seedDue(right);
      const card = await next(right);
      expect(card.card.choices).toHaveLength(4);
      const correctIndex = (card.card.choices as string[]).indexOf(gloss);
      expect(correctIndex).toBeGreaterThanOrEqual(0);
      const graded = await answer(right, ["--choice", String(correctIndex + 1)]);
      expect(graded.correct).toBe(true);
      expect(graded.gloss).toBe(gloss);
    } finally {
      right.cleanup();
    }

    const wrong = makeEnv();
    try {
      seedDue(wrong);
      const card = await next(wrong);
      const correctIndex = (card.card.choices as string[]).indexOf(gloss);
      const wrongIndex = (correctIndex + 1) % 4;
      const graded = await answer(wrong, ["--choice", String(wrongIndex + 1)]);
      expect(graded.correct).toBe(false);
      // It still tells the user what the answer was.
      expect(graded.gloss).toBe(gloss);
    } finally {
      wrong.cleanup();
    }
  });

  it("refuses when there is no outstanding question", async () => {
    const e = fresh();
    const result = await answer(e, ["--choice", "1"]);
    expect(result.error).toContain("no question is outstanding");
  });

  it("stands aside when a pane already owns the deck", async () => {
    // Two graders writing the same file is how progress gets lost.
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(["--lang", "es", "--width", "60", "--no-color", "--no-enrich"], e);
    await pane.waitForText("most common word");

    const blocked = await next(e);
    expect(blocked.error).toContain("pane is already open");
    const blockedAnswer = await answer(e, ["--choice", "1"]);
    expect(blockedAnswer.error).toBeTruthy();
  });

  it("says so when nothing is due", async () => {
    const e = fresh();
    const future = Date.now() + 86_400_000;
    const items: Record<string, unknown> = {};
    for (let i = 1; i <= 400; i++) {
      items[`es:${i}`] = {
        id: `es:${i}`, stage: "review", box: 5, step: 0,
        due: future, lastSeen: 0, seen: 9, correct: 9, lapses: 0,
      };
    }
    fs.writeFileSync(
      progressFile(e, "es"),
      JSON.stringify({
        version: 1, lang: "es", items,
        streak: 0, bestStreak: 0, totalAnswered: 0, totalCorrect: 0, introducedByDay: {},
      }),
    );
    const result = await next(e);
    expect(result.done).toBe(true);
    expect(result.message).toContain("nothing due");
  });

  it("leaves no pending question behind once answered", async () => {
    const e = fresh();
    await next(e);
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(true);
    await answer(e, ["--choice", "1"]);
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(false);
  });

  // The skill parses stdout as JSON. A pending file that is valid JSON but the
  // wrong shape — `null` especially, which dereferences before any shape check —
  // must still come back as one line of JSON, not a stack trace.
  it.each([
    ["null", "null"],
    ["a bare string", '"hola"'],
    ["an array", "[1, 2, 3]"],
    ["an object missing every field", "{}"],
    ["an object with the wrong field types", '{"id": 7, "choices": "a", "accepted": 1, "answerIndex": "x"}'],
  ])("answers a pending file that is %s with JSON, not a crash", async (_label, body) => {
    const e = fresh();
    await next(e);
    await answer(e, ["--choice", "1"]);
    await next(e);
    const before = fs.readFileSync(progressFile(e, "es"), "utf8");
    fs.writeFileSync(path.join(e.home, "pending-es.json"), body);

    const { stdout, stderr, code } = await cli(["answer", "--choice", "1"], e);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout).error).toContain("unreadable");
    // and it graded nothing
    expect(fs.readFileSync(progressFile(e, "es"), "utf8")).toBe(before);
  });

  // `--choice` with nothing after it used to become -1: graded wrong, the box
  // demoted, and success reported. A missing value must be refused instead.
  it.each([["--choice"], ["--text"]])("refuses %s with no value rather than grading it", async (flag) => {
    const e = fresh();
    await next(e);
    await answer(e, ["--choice", "1"]);
    await next(e);
    const before = fs.readFileSync(progressFile(e, "es"), "utf8");

    const { stdout, stderr, code } = await cli(["answer", flag], e);
    expect(code).toBe(1);
    expect(stderr).toContain("needs a value");
    expect(stdout).toBe("");
    // Nothing graded, and the question is still outstanding to answer properly.
    expect(fs.readFileSync(progressFile(e, "es"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(true);
  });

  // Round 2's blocker: no answer at all is not a wrong answer. This grades
  // nothing, where it used to demote a box and break a streak while reporting
  // `{"correct":false}` and exit 0 — indistinguishable from getting it wrong.
  it("refuses to grade when neither --choice nor --text is given", async () => {
    const e = fresh();
    // Get onto a real review card, where being marked wrong actually costs
    // something: a box level, a stage, and the streak.
    await next(e);
    await answer(e, ["--choice", "1"]);
    const stored = JSON.parse(fs.readFileSync(progressFile(e, "es"), "utf8")) as {
      items: Record<string, Record<string, unknown>>;
      streak: number;
    };
    const id = Object.keys(stored.items)[0]!;
    stored.items[id] = { ...stored.items[id], stage: "review", box: 3, due: Date.now() - 1000 };
    stored.streak = 4;
    fs.writeFileSync(progressFile(e, "es"), JSON.stringify(stored));
    await next(e);
    const before = fs.readFileSync(progressFile(e, "es"), "utf8");

    const { stdout, code } = await cli(["answer"], e);
    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim()) as { error?: string; correct?: boolean };
    expect(result.error).toBeTruthy();
    expect(result.correct).toBeUndefined();
    // Nothing graded: same bytes, and the question still there to answer properly.
    expect(fs.readFileSync(progressFile(e, "es"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(true);

    const proper = await answer(e, ["--choice", "1"]);
    expect(typeof proper.correct).toBe("boolean");
  });

  it("emits one line of JSON, so a skill can parse it", async () => {
    const e = fresh();
    const { stdout } = await cli(["next", "--json"], e);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
