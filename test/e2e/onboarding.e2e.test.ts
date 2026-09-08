import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Env, Pane, cli, makeEnv, progressFile, requireBuild } from "./harness.js";

let env: Env;
let pane: Pane | null = null;

beforeAll(requireBuild);
afterEach(() => {
  pane?.kill();
  pane = null;
  env?.cleanup();
});

/** A genuinely new user: nothing configured, nothing learned. */
function firstTime(): Env {
  env = makeEnv({ onboarded: false });
  return env;
}

const BASE = ["--width", "56", "--no-color", "--no-enrich"];

describe("the first time someone opens it", () => {
  it("introduces itself before anything else", async () => {
    const e = firstTime();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);

    await pane.waitForProse("Hello");
    // No jargon, no commands to learn, and one obvious key.
    expect(pane.flatFrame).toContain("I teach you a language");
    expect(pane.flatFrame).toContain("[enter]");
    // And nothing has been decided on the user's behalf.
    expect(fs.existsSync(progressFile(e, "es"))).toBe(false);
  });

  it("asks which language, and takes a number", async () => {
    const e = firstTime();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForProse("Hello");

    pane.send("\r");
    await pane.waitForProse("Which language?");
    // Every installed pack, numbered, with its size — nothing to look up.
    for (const [n, name] of [["1", "Spanish"], ["2", "French"], ["3", "Italian"]] as const) {
      expect(pane.flatFrame).toContain(`[${n}] ${name}`);
    }
    expect(pane.flatFrame).toContain("words");

    pane.send("3");
    await pane.waitForProse("How this works");
    expect(pane.lastFrame).toContain("Italian");
  });

  it("explains the idea in three lines, then starts", async () => {
    const e = firstTime();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForProse("Hello");
    pane.send("\r");
    await pane.waitForProse("Which language?");
    pane.send("2");
    await pane.waitForProse("How this works");

    expect(pane.flatFrame).toContain("I show you a word");
    expect(pane.flatFrame).toContain("I ask less often");
    // It says where to look for what to press, which is the whole navigation model.
    expect(pane.flatFrame).toContain("always shown along the bottom");

    pane.send("\r");
    await pane.waitForProse("most common word in French");
  });

  it("remembers, so it never introduces itself twice", async () => {
    const e = firstTime();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForProse("Hello");
    pane.send("\r");
    await pane.waitForProse("Which language?");
    pane.send("1");
    await pane.waitForProse("How this works");
    pane.send("\r");
    await pane.waitForProse("most common word");
    pane.send("q");
    expect(await pane.exited).toBe(0);

    const settings = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8"));
    expect(settings.onboarded).toBe(true);
    expect(settings.lang).toBe("es");

    const second = new Pane(BASE, e);
    pane = second;
    await second.waitForProse("most common word");
    expect(second.output).not.toContain("Hello");
  });

  it("is not interrupted by the agent starting or stopping", async () => {
    const e = firstTime();
    pane = new Pane(BASE, e);
    await pane.waitForProse("Hello");
    for (const event of ["UserPromptSubmit", "Stop", "UserPromptSubmit"]) {
      await cli(["hook", event], e);
    }
    await pane.settle(1500);
    expect(pane.flatFrame).toContain("Hello");
  });
});

describe("changing language later", () => {
  it("is one key from a card, and takes effect immediately", async () => {
    const e = makeEnv();
    env = e;
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(["--lang", "es", ...BASE], e);
    await pane.waitForProse("most common word in Spanish");

    pane.send("l");
    await pane.waitForProse("Which language?");
    // The one in use is marked, so it is obvious where you are.
    expect(pane.flatFrame).toContain("Spanish");

    pane.send("2");
    await pane.waitForProse("most common word in French");
    expect(pane.lastFrame).toContain("French");

    const settings = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8"));
    expect(settings.lang).toBe("fr");
  });

  it("backs out on escape without changing anything", async () => {
    const e = makeEnv();
    env = e;
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(["--lang", "es", ...BASE], e);
    await pane.waitForProse("most common word in Spanish");

    pane.send("l");
    await pane.waitForProse("Which language?");
    expect(pane.flatFrame).toContain("esc");
    pane.send(String.fromCharCode(27));
    await pane.waitForProse("most common word in Spanish");
  });

  it("leaves only one deck locked", async () => {
    const e = makeEnv();
    env = e;
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(["--lang", "es", ...BASE], e);
    await pane.waitForProse("most common word in Spanish");
    pane.send("l");
    await pane.waitForProse("Which language?");
    pane.send("3");
    await pane.waitForProse("most common word in Italian");

    const locks = fs.readdirSync(e.home).filter((f) => f.endsWith(".lock"));
    expect(locks).toEqual(["progress-it.lock"]);
  });
});

describe("nobody has to learn a command", () => {
  it("shows the keys that work, on every screen", async () => {
    const e = makeEnv();
    env = e;
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(["--lang", "es", ...BASE], e);

    await pane.waitForProse("most common word");
    // The footer is the navigation model: it always says what is pressable here.
    expect(pane.lastFrame).toMatch(/space next.*s skip.*\? help/);

    pane.send("?");
    await pane.waitForProse("keys");
    for (const cue of ["answer a multiple-choice", "change language", "quit"]) {
      expect(pane.flatFrame).toContain(cue);
    }
  });
});

describe("choosing the language already in use", () => {
  it("keeps the deck lock, so a second pane is still refused", async () => {
    // The reviewer's finding: the picker offers the current language like any
    // other, and going round the acquire/release cycle on one file deletes the
    // lock this pane is holding. A new user is defaulted to Spanish and shown
    // Spanish as [1], so it is the likeliest first run there is.
    const e = firstTime();
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(BASE, e);
    await pane.waitForProse("Hello");
    pane.send("\r");
    await pane.waitForProse("Which language?");
    pane.send("1");
    await pane.waitForProse("How this works");
    pane.send("\r");
    await pane.waitForProse("most common word in Spanish");

    const locks = fs.readdirSync(e.home).filter((f) => f.endsWith(".lock"));
    expect(locks, "the pane released its own lock").toEqual(["progress-es.lock"]);

    const second = await cli(["--lang", "es", "--no-color"], e);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already studying Spanish");
  });

  it("says so and stays put when picked mid-session", async () => {
    const e = makeEnv();
    env = e;
    await cli(["hook", "UserPromptSubmit"], e);
    pane = new Pane(["--lang", "es", ...BASE], e);
    await pane.waitForProse("most common word in Spanish");

    pane.send("l");
    await pane.waitForProse("Which language?");
    pane.send("1");
    await pane.waitForProse("still Spanish");
    expect(fs.readdirSync(e.home).filter((f) => f.endsWith(".lock"))).toEqual([
      "progress-es.lock",
    ]);
  });
});

describe("switching into a deck that cannot be read", () => {
  /** A real French deck, made unreadable. */
  function unreadableFrench(e: Env): { file: string; before: string } {
    const now = Date.now();
    const file = progressFile(e, "fr");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1, lang: "fr",
        items: {
          "fr:1": {
            id: "fr:1", stage: "review", box: 5, step: 0,
            due: now + 9e7, lastSeen: now, seen: 40, correct: 38, lapses: 1,
          },
        },
        streak: 7, bestStreak: 12, totalAnswered: 99, totalCorrect: 90, introducedByDay: {},
      }),
    );
    const before = fs.readFileSync(file, "utf8");
    fs.chmodSync(file, 0o000);
    return { file, before };
  }

  it("does not overwrite it with an empty one", async () => {
    // Read-only state belongs to a language, not to the pane. Captured once at
    // startup, a switch hands the pane a blank deck with saving still on.
    const e = makeEnv();
    env = e;
    const { file, before } = unreadableFrench(e);
    try {
      await cli(["hook", "UserPromptSubmit"], e);
      pane = new Pane(["--lang", "es", ...BASE], e);
      await pane.waitForProse("most common word in Spanish");

      pane.send("l");
      await pane.waitForProse("Which language?");
      pane.send("2");
      await pane.waitForProse("could not be read");
      expect(pane.flatFrame).toContain("Not saving");

      // Answer several cards; none of them may reach that file.
      for (let i = 0; i < 3; i++) {
        pane.send(" ");
        await pane.settle(250);
      }
      fs.chmodSync(file, 0o600);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it("starts saving again after switching away to a healthy deck", async () => {
    // The mirror image: read-only captured at startup would silently persist
    // after moving to a language that is perfectly fine.
    const e = makeEnv();
    env = e;
    const file = progressFile(e, "es");
    fs.writeFileSync(file, '{"version":1,"lang":"es","items":{}}');
    fs.chmodSync(file, 0o000);
    try {
      await cli(["hook", "UserPromptSubmit"], e);
      pane = new Pane(["--lang", "es", ...BASE], e);
      await pane.waitForProse("could not be read");

      pane.send("l");
      await pane.waitForProse("Which language?");
      pane.send("2");
      await pane.waitForProse("most common word in French");
      // The Spanish warning belongs to Spanish and must not follow us.
      expect(pane.flatFrame).not.toContain("Not saving");

      pane.send(" ");
      await pane.waitForProse("#2 most common word");
      expect(fs.existsSync(progressFile(e, "fr")), "French progress was never saved").toBe(true);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it("keeps the walkthrough alive when the switch fails outright", async () => {
    // Dropping into `waiting` un-onboarded is unrecoverable: `l` from there sets
    // pickerReturn, so the same-language branch returns to `waiting` for ever.
    const e = makeEnv({ onboarded: false });
    env = e;
    // Something else already owns French.
    fs.writeFileSync(
      path.join(e.home, "progress-fr.lock"),
      JSON.stringify({ pid: 1, since: Date.now() }),
    );
    pane = new Pane(BASE, e);
    await pane.waitForProse("Hello");
    pane.send("\r");
    await pane.waitForProse("Which language?");
    pane.send("2");
    await pane.waitForProse("could not switch to fr");
    // Still on the picker, still able to choose something else.
    expect(pane.flatFrame).toContain("Which language?");
    pane.send("1");
    await pane.waitForProse("How this works");
  });
});
