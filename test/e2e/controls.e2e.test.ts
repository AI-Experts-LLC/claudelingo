import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Env, Pane, cli, makeEnv, progressFile, readProgress, requireBuild } from "./harness.js";

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

async function json(args: string[], e: Env): Promise<Record<string, unknown>> {
  const { stdout, code } = await cli(args, e);
  expect(code).toBe(0);
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("the commands the panel tells you to type", () => {
  it("skips without grading, and does not deal the same card straight back", async () => {
    const e = fresh();
    const first = await json(["next", "--json"], e);
    const dealt = (first.card as { id: string }).id;

    const skipped = await json(["skip"], e);
    expect(skipped.skipped).toBe(true);
    // Nothing was graded: a skip is a delay, not a wrong answer.
    const progress = readProgress(e, "es") as {
      totalAnswered: number;
      items: Record<string, { correct?: number; lapses?: number } | undefined>;
    };
    expect(progress.totalAnswered).toBe(0);
    expect(progress.items[dealt]?.correct ?? 0).toBe(0);
    expect(progress.items[dealt]?.lapses ?? 0).toBe(0);
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(false);

    const second = await json(["next", "--json"], e);
    expect((second.card as { id: string }).id).not.toBe(dealt);
  });

  it("refuses to skip when nothing is outstanding", async () => {
    const e = fresh();
    const result = await json(["skip"], e);
    expect(result.error).toContain("no question is outstanding");
  });

  it("changes the language for good, and drops the question that came with the old one", async () => {
    const e = fresh();
    await json(["next", "--json"], e);
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(true);

    const changed = await json(["lang", "fr"], e);
    expect(changed).toMatchObject({ lang: "fr", englishName: "French", changed: true });
    // Grading it against the French deck would file the answer under the wrong word.
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(false);

    const card = await json(["next", "--json"], e);
    expect((card.card as { id: string }).id.startsWith("fr:")).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8"));
    expect(settings.lang).toBe("fr");
  });

  it("leaves the Spanish deck untouched when it moves to French", async () => {
    const e = fresh();
    await json(["next", "--json"], e);
    await json(["answer", "--choice", "1"], e);
    const before = fs.readFileSync(progressFile(e, "es"), "utf8");

    await json(["lang", "fr"], e);
    await json(["next", "--json"], e);
    await json(["answer", "--choice", "1"], e);

    expect(fs.readFileSync(progressFile(e, "es"), "utf8")).toBe(before);
  });

  it("names what is installed when asked for a language that is not", async () => {
    const e = fresh();
    const result = await json(["lang", "kl"], e);
    expect(result.error).toContain("no pack");
    expect(result.error).toContain("es");
    const settings = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8") || "{}");
    expect(settings.lang ?? "es").toBe("es");
  });

  it("turns the panel down to one line and back", async () => {
    const e = fresh();
    expect(await json(["panel"], e)).toMatchObject({ panel: true });
    expect(await json(["panel", "off"], e)).toMatchObject({ panel: false, changed: true });
    const { stdout } = await cli(["statusline", "--no-color"], e);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    await json(["panel", "on"], e);
    const back = await cli(["statusline", "--no-color"], e);
    expect(back.stdout.trimEnd().split("\n").length).toBeGreaterThan(1);
  });

  // `init` has always guarded this; the writers added later did not, and reset
  // every preference — including the language — while reporting success.
  it.each([
    ["lang", ["lang", "fr"]],
    ["panel", ["panel", "off"]],
  ])("refuses to overwrite a settings file it could not read (%s)", async (_name, args) => {
    const e = fresh();
    const file = path.join(e.home, "settings.json");
    fs.writeFileSync(file, '{"lang":"fr","model":"my-model","maxLearning":3,');
    const before = fs.readFileSync(file, "utf8");

    const result = await json(args, e);
    expect(String(result.error)).toContain("leaving it alone");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("does not turn a one-off flag into a saved preference", async () => {
    const e = fresh();
    await json(["panel", "on"], e);
    const before = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8"));
    expect(before.enrich).not.toBe(false);

    await json(["lang", "fr", "--no-enrich"], e);
    const after = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8"));
    expect(after.lang).toBe("fr");
    // The only thing that should have changed is the language.
    expect(after.enrich).toBe(before.enrich);
  });

  it("clears a pending file no other command can read", async () => {
    const e = fresh();
    await json(["next", "--json"], e);
    await json(["answer", "--choice", "1"], e); // so there is a deck on disk to compare
    // A question the panel will happily draw, but with no id to grade against.
    fs.writeFileSync(
      path.join(e.home, "pending-es.json"),
      JSON.stringify({ question: 'What does "el" mean?', choices: ["a", "b", "c", "d"] }),
    );
    const before = fs.readFileSync(progressFile(e, "es"), "utf8");

    const result = await json(["skip"], e);
    expect(result).toMatchObject({ skipped: true, unreadable: true });
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(false);
    // Nothing was graded on the way out.
    expect(fs.readFileSync(progressFile(e, "es"), "utf8")).toBe(before);
  });

  it("refuses to change the panel while a pane is open, as the skill promises", async () => {
    const e = fresh();
    await json(["panel", "on"], e);
    pane = new Pane([], e);
    await pane.until(() => fs.existsSync(path.join(e.home, "progress-es.lock")));

    const result = await json(["panel", "off"], e);
    expect(String(result.error)).toContain("pane");
    const settings = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8"));
    expect(settings.panel).not.toBe(false);
  });

  it("changes the language the file names, not the one a flag names", async () => {
    const e = fresh();
    await json(["next", "--json"], e);
    // `--lang it` must not make italian "the language being left": the pending
    // file that gets dropped would be the wrong one.
    await json(["lang", "fr", "--lang", "it"], e);
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(false);
    const settings = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8"));
    expect(settings.lang).toBe("fr");
  });

  it("erases the outstanding question along with the deck on reset", async () => {
    const e = fresh();
    await json(["next", "--json"], e);
    await json(["answer", "--choice", "1"], e);
    await json(["next", "--json"], e);
    const { code } = await cli(["reset", "--yes"], e);
    expect(code).toBe(0);
    // Grading it afterwards would file an answer against a word with no history.
    expect(fs.existsSync(path.join(e.home, "pending-es.json"))).toBe(false);
  });

  it("stands aside for a running pane, on every command that writes", async () => {
    const e = fresh();
    await json(["next", "--json"], e);
    pane = new Pane([], e);
    // Wait for it to actually hold the lock, or the refusal under test never fires.
    await pane.until(() => fs.existsSync(path.join(e.home, "progress-es.lock")));

    for (const args of [["skip"], ["lang", "fr"]]) {
      const result = await json(args, e);
      expect(String(result.error)).toContain("pane");
    }
    // …and the refusals changed nothing: the pane is still studying its own deck.
    const settings = JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8"));
    expect(settings.lang ?? "es").toBe("es");
    expect(await json(["lang"], e)).toMatchObject({ lang: "es" });
  });
});
