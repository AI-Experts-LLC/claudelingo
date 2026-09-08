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
