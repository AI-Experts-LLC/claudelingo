import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type Env,
  Pane,
  cli,
  glossForTerm,
  idForTerm,
  makeEnv,
  parseChoices,
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

const BASE = ["--lang", "es", "--width", "58", "--no-color", "--no-enrich"];

/** Seed a progress file so a test can start at a chosen point in the ramp. */
function seed(
  e: Env,
  items: Array<{ id: string; box: number; stage: "learning" | "review"; dueOffsetMs?: number }>,
  extra: Record<string, unknown> = {},
): void {
  const now = Date.now();
  const map: Record<string, unknown> = {};
  for (const item of items) {
    map[item.id] = {
      id: item.id,
      stage: item.stage,
      box: item.box,
      step: 0,
      due: now + (item.dueOffsetMs ?? -1000),
      lastSeen: now - 60_000,
      seen: 3,
      correct: 3,
      lapses: 0,
    };
  }
  fs.writeFileSync(
    progressFile(e, "es"),
    JSON.stringify({
      version: 1,
      lang: "es",
      items: map,
      streak: 0,
      bestStreak: 0,
      totalAnswered: 0,
      totalCorrect: 0,
      introducedByDay: {},
      ...extra,
    }),
  );
}

describe("the pane and the agent", () => {
  it("waits while the agent is idle, then quizzes the moment it starts working", async () => {
    const e = fresh();
    await cli(["hook", "Stop"], e);

    pane = new Pane(BASE, e);
    await pane.waitForText("Standing by");
    expect(pane.lastFrame).toContain("agent idle");
    expect(pane.lastFrame).not.toContain("new word");

    // A Claude Code UserPromptSubmit hook fires — the pane should wake up.
    await cli(["hook", "UserPromptSubmit"], e);
    await pane.waitForLastFrame("new word");
    expect(pane.lastFrame).toContain("agent working");
    // Assert on the gloss, not the term: "el" is also a substring of the
    // "claudelingo" in the title bar, so it would match any frame at all.
    expect(pane.lastFrame).toContain("the (m.)");
    expect(pane.lastFrame).toContain("#1 most common word");

    // Claude finishes; the pane must get out of the way.
    await cli(["hook", "Stop"], e);
    await pane.until((out) => out.lastIndexOf("Standing by") > out.lastIndexOf("new word"));
    expect(pane.lastFrame).toContain("agent idle");
  });

  it("stands down for a permission prompt, because the human is needed", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("new word");

    await cli(["hook", "Notification"], e);
    await pane.waitForLastFrame("Standing by");
    expect(pane.lastFrame).toContain("agent idle");
  });

  it("wakes up already quizzing if the agent was working before it opened", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("new word");
    expect(pane.frames[0]).toContain("agent working");
  });

  it("reacts to Codex's notify hook as well as Claude Code's", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit", "--source", "codex"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("new word");

    await cli(["notify", JSON.stringify({ type: "agent-turn-complete" })], e);
    await pane.waitForLastFrame("Standing by");
  });
});

describe("the teaching ramp", () => {
  it("introduces words one at a time, in frequency order", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);

    await pane.waitForText("#1 most common word");
    expect(pane.lastFrame).toContain("the (m.)");

    pane.send(" ");
    await pane.waitForText("#2 most common word");
    expect(pane.lastFrame).toContain("de");

    pane.send(" ");
    await pane.waitForText("#3 most common word");
  });

  it("writes progress to disk as words are learned", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("#1 most common word");

    pane.send(" ");
    await pane.waitForText("#2 most common word");
    pane.send(" ");
    await pane.waitForText("#3 most common word");

    const progress = readProgress(e, "es") as {
      items: Record<string, { stage: string; box: number }>;
    };
    expect(Object.keys(progress.items)).toEqual(["es:1", "es:2"]);
    expect(progress.items["es:1"]).toMatchObject({ stage: "learning", box: 1 });
  });

  it("asks for the meaning once a word has been taught", async () => {
    const e = fresh();
    seed(e, [{ id: "es:1", box: 1, stage: "learning" }]);
    await cli(["hook", "UserPromptSubmit"], e);

    pane = new Pane(BASE, e);
    await pane.waitForText("what does");
    const frame = pane.lastFrame;
    expect(frame).toContain("meaning");
    expect(frame).toContain("box 1/5");
    expect(frame).toMatch(/1\)/);
    expect(frame).toMatch(/4\)/);
    expect(frame).toContain("1-4 answer");
  });

  it("asks for the word itself at a higher box", async () => {
    const e = fresh();
    seed(e, [{ id: "es:1", box: 3, stage: "review" }]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("how do you say");
    expect(pane.lastFrame).toContain("translate");
    expect(pane.lastFrame).toContain("box 3/5");
  });

  it("asks the user to spell it out at the top box", async () => {
    const e = fresh();
    seed(e, [{ id: "es:1", box: 5, stage: "review" }]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("spell the word");
    expect(pane.lastFrame).toContain("enter submit");
  });
});

describe("answering", () => {
  it("marks a correct choice, banks the streak, and moves on", async () => {
    const e = fresh();
    seed(e, [
      { id: "es:1", box: 1, stage: "learning" },
      { id: "es:2", box: 1, stage: "learning", dueOffsetMs: -500 },
    ]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("what does");

    // Find which number carries the right answer in the frame on screen.
    const frame = pane.lastFrame;
    const term = /what does «(.+?)» mean/.exec(frame)?.[1];
    expect(term).toBeTruthy();
    const gloss = glossForTerm("es", term as string);
    const choices = parseChoices(frame);
    expect(choices.size).toBe(4);
    const correct = [...choices].find(([, label]) => label === gloss)?.[0];
    expect(correct, `no choice matched "${gloss}" in\n${frame}`).toBeTruthy();

    pane.send(correct as string);
    await pane.waitForText("correct");
    expect(pane.lastFrame).toContain("streak 1");
    expect(pane.lastFrame).toContain("space next");

    pane.send(" ");
    await pane.until((out) => out.lastIndexOf("what does") > out.lastIndexOf("correct"));
  });

  it("shows the right answer after a wrong one and resets the streak", async () => {
    const e = fresh();
    seed(e, [{ id: "es:1", box: 1, stage: "learning" }], { streak: 6, bestStreak: 6 });
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("what does");

    const frame = pane.lastFrame;
    const term = /what does «(.+?)» mean/.exec(frame)?.[1] as string;
    const gloss = glossForTerm("es", term);
    const wrong = [...parseChoices(frame)].find(([, label]) => label !== gloss)?.[0];
    expect(wrong, `no wrong choice found in\n${frame}`).toBeTruthy();

    pane.send(wrong as string);
    await pane.waitForText("not quite");
    expect(pane.lastFrame).toContain("you said");
    expect(pane.lastFrame).toContain(term);
    expect(pane.lastFrame).toContain("streak 0");
  });

  it("accepts a typed answer, accents and all", async () => {
    const e = fresh();
    seed(e, [{ id: idForTerm("es", "qué"), box: 5, stage: "review" }]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("spell the word");

    pane.send("que");
    await pane.waitForText("> que");
    pane.send("\r");
    await pane.waitForText("correct");
    expect(pane.lastFrame).toContain("qué");
  });

  it("lets the user correct a typo with backspace", async () => {
    const e = fresh();
    seed(e, [{ id: "es:1", box: 5, stage: "review" }]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("spell the word");

    pane.send("ex");
    await pane.waitForText("> ex");
    pane.send(String.fromCharCode(127));
    const typed = pane;
    await typed.until(() => /^\s*>\s*e\s*▏?\s*$/m.test(typed.lastFrame.replace(/[│]/g, "")));
    pane.send("l\r");
    await pane.waitForText("correct");
  });

  it("does not fire shortcuts while the user is typing an answer", async () => {
    const e = fresh();
    seed(e, [{ id: "es:1", box: 5, stage: "review" }]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("spell the word");

    // "q" would normally quit and "p" would toggle practice mode.
    pane.send("qp");
    await pane.waitForText("> qp");
    expect(pane.lastFrame).not.toContain("practice");
  });

  it("rejects a wrong typed answer", async () => {
    const e = fresh();
    seed(e, [{ id: "es:1", box: 5, stage: "review" }]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("spell the word");
    pane.send("zzz\r");
    await pane.waitForText("not quite");
  });
});

describe("skipping, help and quitting", () => {
  it("skips a word without marking it wrong", async () => {
    const e = fresh();
    seed(e, [
      { id: "es:1", box: 2, stage: "review" },
      { id: "es:2", box: 2, stage: "review", dueOffsetMs: -500 },
    ]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("what does");

    pane.send("s");
    await pane.waitForText("skipped");
    const progress = readProgress(e, "es") as {
      items: Record<string, { box: number; seen: number }>;
      streak: number;
    };
    expect(progress.streak).toBe(0);
    expect(progress.items["es:1"]?.box).toBe(2);
    expect(progress.items["es:1"]?.seen).toBe(3);
  });

  it("opens help and closes it again", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("new word");

    pane.send("?");
    await pane.waitForText("any key to close");
    expect(pane.lastFrame).toContain("memory hook");

    pane.send("x");
    await pane.until((out) => out.lastIndexOf("new word") > out.lastIndexOf("any key to close"));
  });

  it("practises on demand while the agent is idle", async () => {
    const e = fresh();
    await cli(["hook", "Stop"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("Standing by");

    pane.send("p");
    await pane.waitForText("new word");
    expect(pane.lastFrame).toContain("practice");
  });

  it("quits on q and leaves progress on disk", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("new word");

    pane.send(" ");
    await pane.waitForText("#2 most common word");
    pane.send("q");

    expect(await pane.exited).toBe(0);
    expect(Object.keys((readProgress(e, "es") as { items: object }).items)).toContain("es:1");
  });

  it("quits on ctrl-c", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("new word");
    pane.send(String.fromCharCode(3));
    expect(await pane.exited).toBe(0);
  });
});

describe("resilience", () => {
  it("treats an abandoned busy session as idle rather than quizzing forever", async () => {
    const e = fresh();
    // A Claude session that was killed mid-turn: busy, but written long ago.
    fs.writeFileSync(
      path.join(e.home, "status.json"),
      JSON.stringify({
        state: "busy",
        source: "claude",
        event: "UserPromptSubmit",
        ts: Date.now() - 60 * 60 * 1000,
      }),
    );
    pane = new Pane(BASE, e);
    await pane.waitForText("Standing by");
    expect(pane.lastFrame).toContain("agent idle");
  });

  it("survives a corrupt progress file by starting over", async () => {
    const e = fresh();
    fs.writeFileSync(progressFile(e, "es"), "{ not json at all");
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("#1 most common word");
  });

  it("holds the panel shape at every width it is given", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    for (const width of ["30", "46", "100"]) {
      const p = new Pane(["--lang", "es", "--width", width, "--no-color", "--no-enrich"], e);
      await p.waitForText("claudelingo");
      const lines = p.lastFrame.split("\n");
      for (const line of lines) expect([...line].length).toBe(Number(width));
      p.kill();
    }
  });

  it("runs each shipped language end to end", async () => {
    // Glosses, not terms: several terms are substrings of the panel chrome.
    for (const [lang, first] of [
      ["es", "the (m.)"],
      ["fr", "the (m.)"],
      ["it", "the (m.)"],
    ] as const) {
      const e = makeEnv();
      try {
        await cli(["hook", "UserPromptSubmit"], e);
        const p = new Pane([`--lang`, lang, "--width", "58", "--no-color", "--no-enrich"], e);
        await p.waitForText("#1 most common word");
        expect(p.lastFrame).toContain(first);
        p.send(" ");
        await p.waitForText("#2 most common word");
        p.send("q");
        expect(await p.exited).toBe(0);
      } finally {
        e.cleanup();
      }
    }
  });
});

describe("the answer / idle / next-prompt cycle", () => {
  /**
   * The single most common path in the app: answer a card, Claude finishes its
   * turn, you send the next prompt. Resuming a card that was already graded would
   * re-ask it and double-count it into the deck on disk.
   */
  it("does not re-ask or double-count a card that was already answered", async () => {
    const e = fresh();
    seed(e, [
      { id: "es:1", box: 2, stage: "review" },
      { id: "es:2", box: 2, stage: "review", dueOffsetMs: -500 },
    ]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("what does");

    const frame = pane.lastFrame;
    const term = /what does «(.+?)» mean/.exec(frame)?.[1] as string;
    const gloss = glossForTerm("es", term);
    const correct = [...parseChoices(frame)].find(([, label]) => label === gloss)?.[0];
    pane.send(correct as string);
    await pane.waitForText("correct");

    const afterAnswer = readProgress(e, "es") as {
      items: Record<string, { seen: number; box: number }>;
      totalAnswered: number;
    };

    // Claude finishes its turn, then you send the next prompt.
    await cli(["hook", "Stop"], e);
    await pane.waitForLastFrame("Standing by");
    await cli(["hook", "UserPromptSubmit"], e);
    const resumed = pane;
    await resumed.until(() => !resumed.lastFrame.includes("Standing by"));

    // Whatever is on screen, it must not be the graded card awaiting an answer.
    expect(pane.lastFrame).not.toContain(`what does «${term}»`);

    const answeredId = Object.keys(afterAnswer.items).find(
      (id) => afterAnswer.items[id]!.seen > 3,
    ) as string;
    const now = readProgress(e, "es") as {
      items: Record<string, { seen: number; box: number }>;
      totalAnswered: number;
    };
    expect(now.items[answeredId]?.seen).toBe(afterAnswer.items[answeredId]?.seen);
    expect(now.items[answeredId]?.box).toBe(afterAnswer.items[answeredId]?.box);
    expect(now.totalAnswered).toBe(afterAnswer.totalAnswered);
  });

  it("puts an unanswered card back exactly where it was", async () => {
    const e = fresh();
    seed(e, [{ id: "es:1", box: 1, stage: "learning" }]);
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("what does");
    const question = /what does «(.+?)» mean/.exec(pane.lastFrame)?.[1];

    await cli(["hook", "Stop"], e);
    await pane.waitForLastFrame("Standing by");
    await cli(["hook", "UserPromptSubmit"], e);
    await pane.waitForLastFrame("what does");
    expect(/what does «(.+?)» mean/.exec(pane.lastFrame)?.[1]).toBe(question);
  });
});

describe("skipping a word never seen before", () => {
  it("moves on instead of showing the same word straight back", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForText("#1 most common word");

    pane.send("s");
    await pane.waitForText("#2 most common word");
    expect(pane.flatFrame).toContain("skipped el");

    // The deferral is persisted, so it does not reappear on the next launch.
    const progress = readProgress(e, "es") as {
      items: Record<string, { stage: string; due: number }>;
      totalAnswered: number;
    };
    expect(progress.items["es:1"]?.stage).toBe("new");
    expect(progress.items["es:1"]?.due).toBeGreaterThan(Date.now());
    expect(progress.totalAnswered).toBe(0);
  });
});
