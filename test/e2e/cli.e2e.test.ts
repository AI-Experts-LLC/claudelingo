import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Env, Pane, cli, makeEnv, readProgress, requireBuild, statusFile } from "./harness.js";

let env: Env;
beforeAll(requireBuild);
afterEach(() => env?.cleanup());

function fresh(): Env {
  env = makeEnv();
  return env;
}

describe("claudelingo --help", () => {
  it("prints usage and exits cleanly", async () => {
    const { stdout, code } = await cli(["--help"], fresh());
    expect(code).toBe(0);
    expect(stdout).toContain("learn a language while your coding agent works");
    expect(stdout).toContain("claudelingo init");
    expect(stdout).toContain("--lang");
  });
});

describe("claudelingo langs", () => {
  it("lists the three shipped languages with their sizes", async () => {
    const { stdout, code } = await cli(["langs"], fresh());
    expect(code).toBe(0);
    expect(stdout).toMatch(/es\s+Spanish\s+\d+ words/);
    expect(stdout).toMatch(/fr\s+French\s+\d+ words/);
    expect(stdout).toMatch(/it\s+Italian\s+\d+ words/);
  });
});

describe("claudelingo hook", () => {
  it("records busy and idle, and reports them back", async () => {
    const e = fresh();
    expect((await cli(["status"], e)).stdout).toContain("no agent state recorded yet");

    await cli(["hook", "UserPromptSubmit"], e);
    const busy = JSON.parse(fs.readFileSync(statusFile(e), "utf8"));
    expect(busy).toMatchObject({ state: "busy", source: "claude", event: "UserPromptSubmit" });
    expect((await cli(["status"], e)).stdout).toContain("busy");

    await cli(["hook", "Stop"], e);
    expect(JSON.parse(fs.readFileSync(statusFile(e), "utf8")).state).toBe("idle");
    expect((await cli(["status"], e)).stdout).toContain("idle");
  });

  it("treats a permission notification as idle", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    await cli(["hook", "Notification"], e);
    expect(JSON.parse(fs.readFileSync(statusFile(e), "utf8")).state).toBe("idle");
  });

  it("exits 0 and changes nothing for an event it does not model", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const before = fs.readFileSync(statusFile(e), "utf8");
    const { code } = await cli(["hook", "SomeFutureEvent"], e);
    expect(code).toBe(0);
    expect(fs.readFileSync(statusFile(e), "utf8")).toBe(before);
  });

  it("fails loudly when no event is given", async () => {
    const { code, stderr } = await cli(["hook"], fresh());
    expect(code).toBe(1);
    expect(stderr).toContain("needs an event name");
  });

  it("records the source when Codex calls it", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit", "--source", "codex"], e);
    expect(JSON.parse(fs.readFileSync(statusFile(e), "utf8")).source).toBe("codex");
  });
});

describe("claudelingo notify", () => {
  it("marks the agent idle on a Codex turn-complete payload", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    await cli(["notify", JSON.stringify({ type: "agent-turn-complete" })], e);
    const status = JSON.parse(fs.readFileSync(statusFile(e), "utf8"));
    expect(status).toMatchObject({ state: "idle", source: "codex" });
  });

  it("ignores an unrelated or malformed payload without failing", async () => {
    const e = fresh();
    for (const payload of [JSON.stringify({ type: "other" }), "not json", ""]) {
      const { code } = await cli(["notify", payload], e);
      expect(code).toBe(0);
    }
    expect(fs.existsSync(statusFile(e))).toBe(false);
  });
});

describe("claudelingo init", () => {
  it("installs Claude Code hooks and the Codex notify hook", async () => {
    const e = fresh();
    const fakeHome = path.join(e.home, "fake-home");
    const codexHome = path.join(e.home, "fake-codex");
    fs.mkdirSync(fakeHome, { recursive: true });

    const { stdout, code } = await cli(["init", "--lang", "fr"], e, {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CODEX_HOME: codexHome,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Claude Code hooks installed");
    expect(stdout).toContain("Codex notify installed");
    expect(stdout).toContain("Studying French");

    const settings = JSON.parse(
      fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      "claudelingo hook UserPromptSubmit --source claude",
    );
    expect(settings.hooks.Stop).toBeDefined();

    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(toml).toContain('notify = ["claudelingo", "notify"]');

    // The chosen language is remembered for later runs.
    expect(JSON.parse(fs.readFileSync(path.join(e.home, "settings.json"), "utf8")).lang).toBe("fr");
  });

  it("preserves hooks that belong to other tools", async () => {
    const e = fresh();
    const fakeHome = path.join(e.home, "fake-home");
    const settingsFile = path.join(fakeHome, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
      }),
    );

    await cli(["init"], e, {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CODEX_HOME: path.join(e.home, "codex"),
    });
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(settings.model).toBe("opus");
    const commands = settings.hooks.Stop.flatMap((m: { hooks: { command: string }[] }) =>
      m.hooks.map((h) => h.command),
    );
    expect(commands).toContain("say done");
    expect(commands).toContain("claudelingo hook Stop --source claude");
  });

  it("uninstalls cleanly, leaving other tools' hooks behind", async () => {
    const e = fresh();
    const fakeHome = path.join(e.home, "fake-home");
    const codexHome = path.join(e.home, "codex");
    const settingsFile = path.join(fakeHome, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }),
    );

    const envVars = { HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: codexHome };
    await cli(["init"], e, envVars);
    await cli(["uninit"], e, envVars);

    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const commands = Object.values(settings.hooks ?? {})
      .flat()
      .flatMap((m) => (m as { hooks: { command: string }[] }).hooks.map((h) => h.command));
    expect(commands).toEqual(["say done"]);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).not.toContain(
      "claudelingo",
    );
  });

  it("is safe to run twice", async () => {
    const e = fresh();
    const fakeHome = path.join(e.home, "fake-home");
    const codexHome = path.join(e.home, "codex");
    const envVars = { HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: codexHome };
    await cli(["init"], e, envVars);
    const first = fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8");
    await cli(["init"], e, envVars);
    expect(fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8")).toBe(first);
    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(toml.match(/notify =/g)).toHaveLength(1);
  });
});

describe("claudelingo stats and reset", () => {
  it("reports an untouched deck", async () => {
    const { stdout, code } = await cli(["stats", "--lang", "it"], fresh());
    expect(code).toBe(0);
    expect(stdout).toContain("Italian (it)");
    expect(stdout).toMatch(/words started\s+0 of \d+/);
    expect(stdout).toContain("—");
  });

  it("refuses to erase progress without confirmation, then does it on --yes", async () => {
    const e = fresh();
    const refused = await cli(["reset", "--lang", "es"], e);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--yes");

    const done = await cli(["reset", "--lang", "es", "--yes"], e);
    expect(done.code).toBe(0);
    expect(readProgress(e, "es")).toMatchObject({ version: 1, lang: "es", items: {} });
  });
});

describe("unknown language", () => {
  it("explains how to make one instead of crashing", async () => {
    const { code, stderr } = await cli(["stats", "--lang", "qq"], fresh());
    expect(code).toBe(1);
    expect(stderr).toContain('no pack for "qq"');
    expect(stderr).toContain("pack generate");
  });
});

/**
 * A stand-in `claude` binary on PATH.
 *
 * `pack generate` shells out to Claude Code now, so a test that does not shadow
 * the real binary spends the developer's own quota on a full pack generation —
 * silently, and once per run.
 */
function stubClaude(e: Env, payload: unknown, options: { fail?: boolean } = {}): string {
  const bin = path.join(e.home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const reply = options.fail
    ? { type: "result", subtype: "error", is_error: true, result: "stub failure" }
    : {
        type: "result",
        subtype: "success",
        is_error: false,
        result: typeof payload === "string" ? payload : JSON.stringify(payload),
      };
  const file = path.join(bin, "claude");
  fs.writeFileSync(
    file,
    `#!/bin/sh\ncat <<'CLAUDELINGO_EOF'\n${JSON.stringify(reply)}\nCLAUDELINGO_EOF\n`,
  );
  fs.chmodSync(file, 0o755);
  return bin;
}

/** Every pack-generate test runs with the stand-in first on PATH. */
function withStub(bin: string): Record<string, string> {
  return { PATH: `${bin}:${process.env.PATH}` };
}

describe("claudelingo pack generate", () => {
  it("writes a pack that loads back and can be studied", async () => {
    const e = fresh();
    const bin = stubClaude(e, {
      code: "pt",
      name: "Português",
      englishName: "Portuguese",
      words: [
        { term: "de", gloss: "of, from", pos: "prep" },
        { term: "casa", gloss: "house", pos: "noun", note: "feminine" },
        { term: "ser", gloss: "to be", pos: "verb" },
        { term: "grande", gloss: "big", pos: "adj" },
        { term: "de", gloss: "duplicate to be dropped", pos: "prep" },
      ],
    });
    {
      const generated = await cli(
        ["pack", "generate", "--lang", "Portuguese", "--code", "pt", "--count", "4"],
        e,
        withStub(bin),
      );
      expect(generated.code).toBe(0);
      expect(generated.stdout).toContain("Wrote 4 words");
      expect(generated.stdout).toContain("--lang pt");

      const written = JSON.parse(
        fs.readFileSync(path.join(e.home, "packs", "pt.json"), "utf8"),
      ) as { words: string[][] };
      // The duplicate the model slipped in must have been dropped before writing.
      expect(written.words).toHaveLength(4);
      expect(written.words[1]).toEqual(["casa", "house", "noun", "feminine"]);

      // It is a real pack now: listed, and studiable.
      const langs = await cli(["langs"], e);
      expect(langs.stdout).toMatch(/pt\s+Portuguese\s+4 words/);

      await cli(["hook", "UserPromptSubmit"], e);
      const pane = new Pane(["--lang", "pt", "--width", "58", "--no-color", "--no-enrich"], e);
      try {
        await pane.waitForText("#1 most common word in Portuguese");
        expect(pane.lastFrame).toContain("of, from");
      } finally {
        pane.kill();
      }
    }
  });

  it("writes nothing when the model returns something unusable", async () => {
    const e = fresh();
    const bin = stubClaude(e, { code: "pt", name: "P", englishName: "Portuguese", words: [] });
    const result = await cli(
      ["pack", "generate", "--lang", "Portuguese", "--code", "pt"],
      e,
      withStub(bin),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no words");
    expect(fs.existsSync(path.join(e.home, "packs", "pt.json"))).toBe(false);
  });
});

describe("init reports what actually happened", () => {
  /** A fake HOME/CODEX_HOME pair so nothing real is touched. */
  function fakeEnvs(e: Env) {
    const home = path.join(e.home, "fake-home");
    const codexHome = path.join(e.home, "fake-codex");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    return { home, codexHome, vars: { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome } };
  }

  // `/lingo` is how anyone outside tmux uses this at all. It ships with the
  // plugin, and used to ship with *nothing* on the standalone install route —
  // "Unknown command: /lingo" with no explanation anywhere.
  it("links the /lingo skill so the standalone install has it too", async () => {
    const e = fresh();
    const { home, vars } = fakeEnvs(e);
    const result = await cli(["init"], e, vars);
    expect(result.code).toBe(0);

    const link = path.join(home, ".claude", "skills", "lingo");
    expect(fs.existsSync(path.join(link, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(link, "SKILL.md"), "utf8")).toContain("name: lingo");
    expect(result.stdout).toContain("/lingo");

    // Re-running says so rather than relinking, and uninit takes it away again.
    const again = await cli(["init"], e, vars);
    expect(again.stdout).toContain("already installed");
    await cli(["uninit"], e, vars);
    expect(fs.existsSync(link)).toBe(false);
  });

  // A plugin brings its own hooks and skill; the one thing it cannot bring is the
  // status line, which Claude Code takes only from the main config.
  // A relative link is anchored at the directory holding it, not at the process's
  // cwd. Resolving it wrongly made another tool's live skill look like a dead
  // link of ours — and whether it survived depended on where init was run from.
  it("leaves a relative symlink to another tool's skill alone", async () => {
    const e = fresh();
    const { home, vars } = fakeEnvs(e);
    const theirs = path.join(home, "othertool", "skills", "lingo");
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(theirs, "SKILL.md"), "name: someone else\n");
    const skills = path.join(home, ".claude", "skills");
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(path.join("..", "..", "othertool", "skills", "lingo"), path.join(skills, "lingo"));

    const result = await cli(["init"], e, vars);
    expect(result.stderr).toContain("not ours");
    expect(fs.readlinkSync(path.join(skills, "lingo"))).toBe("../../othertool/skills/lingo");
    expect(fs.readFileSync(path.join(theirs, "SKILL.md"), "utf8")).toContain("someone else");

    await cli(["uninit"], e, vars);
    expect(fs.existsSync(path.join(theirs, "SKILL.md"))).toBe(true);
    expect(fs.readlinkSync(path.join(skills, "lingo"))).toBe("../../othertool/skills/lingo");
  });

  it("installs just the status line with --statusline-only", async () => {
    const e = fresh();
    const { home, codexHome, vars } = fakeEnvs(e);
    const result = await cli(["init", "--statusline-only"], e, vars);
    expect(result.code).toBe(0);

    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    ) as { statusLine?: unknown; hooks?: unknown };
    expect(settings.statusLine).toBeTruthy();
    expect(settings.hooks).toBeUndefined();
    expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "lingo"))).toBe(false);
    // It also must not claim to have installed hooks it deliberately skipped.
    expect(result.stdout).not.toContain("hooks installed");
  });

  it("leaves another tool's settings alone when only the status line is wanted", async () => {
    const e = fresh();
    const { home, vars } = fakeEnvs(e);
    const file = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks: { Stop: ["theirs"] } }));

    await cli(["init", "--statusline-only"], e, vars);
    const settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(settings.model).toBe("opus");
    expect(settings.hooks).toEqual({ Stop: ["theirs"] });
    expect(settings.statusLine).toBeTruthy();
  });

  it("never replaces someone else's lingo skill, and never removes it", async () => {
    const e = fresh();
    const { home, vars } = fakeEnvs(e);
    const theirs = path.join(e.home, "their-skill");
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(theirs, "SKILL.md"), "name: someone else's\n");
    const link = path.join(home, ".claude", "skills", "lingo");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(theirs, link);

    const result = await cli(["init"], e, vars);
    expect(result.stderr).toContain("not ours");
    expect(fs.readlinkSync(link)).toBe(theirs);
    expect(fs.readFileSync(path.join(theirs, "SKILL.md"), "utf8")).toContain("someone else");

    await cli(["uninit"], e, vars);
    expect(fs.readlinkSync(link)).toBe(theirs);
  });

  it("exits non-zero when the Claude Code side cannot be installed", async () => {
    // Reporting success here is how a user ends up staring at a pane that never
    // wakes up, with no idea why.
    const e = fresh();
    const { home, vars } = fakeEnvs(e);
    const settingsFile = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, "{ not valid json");

    const result = await cli(["init"], e, vars);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Claude Code hooks NOT installed");
    expect(result.stderr).toContain("not active");
    // The unparseable file is left exactly as it was.
    expect(fs.readFileSync(settingsFile, "utf8")).toBe("{ not valid json");
  });

  it("exits non-zero when Codex already has another notify program", async () => {
    const e = fresh();
    const { codexHome, vars } = fakeEnvs(e);
    const config = path.join(codexHome, "config.toml");
    const original = 'notify = ["/usr/local/bin/my-notifier", "--flag"]\n';
    fs.writeFileSync(config, original);

    const result = await cli(["init"], e, vars);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Codex notify NOT installed");
    expect(result.stderr).toContain("already sets a different notify program");
    expect(fs.readFileSync(config, "utf8")).toBe(original);
  });

  it("exits zero and says so when both sides install", async () => {
    const e = fresh();
    const { vars } = fakeEnvs(e);
    const result = await cli(["init"], e, vars);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Claude Code hooks installed");
    expect(result.stdout).toContain("Codex notify installed");
    expect(result.stderr).not.toContain("not active");
  });

  it("leaves an unparseable settings.json alone instead of resetting the language", async () => {
    const e = fresh();
    const { vars } = fakeEnvs(e);
    const settings = path.join(e.home, "settings.json");
    fs.writeFileSync(settings, '{ "lang": "it", broken');

    const result = await cli(["init", "--lang", "fr"], e, vars);
    // The user's file is untouched — silently overwriting it would discard their
    // language and model choice with no way to get them back.
    expect(fs.readFileSync(settings, "utf8")).toBe('{ "lang": "it", broken');
    expect(result.stderr).toContain("leaving it alone");
  });

  it("reports each half of uninit separately", async () => {
    const e = fresh();
    const { home, codexHome, vars } = fakeEnvs(e);
    await cli(["init"], e, vars);
    // Break the Claude Code side only; the Codex side must still be cleaned up.
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ broken now");

    const result = await cli(["uninit"], e, vars);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NOT removed");
    expect(result.stderr).toContain("Claude Code hooks");
    // The half that could be cleaned up still was, and is named.
    expect(result.stdout).toMatch(/^Removed: .*Codex notify/m);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).not.toContain(
      "claudelingo",
    );
  });
});

describe("a mistyped command", () => {
  it("says so instead of opening the pane and waiting on stdin", async () => {
    const e = fresh();
    for (const typo of ["bogusnonsense", "stat", "skipp", "Lang"]) {
      const result = await cli([typo], e);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unknown command");
      // Naming the word is the whole point: a typo must not read as a hang.
      expect(result.stderr).toContain(typo);
      expect(result.stdout).toBe("");
    }
  });

  it("still knows every command the panel and the skill tell people to type", async () => {
    const e = fresh();
    for (const args of [["skip"], ["lang"], ["panel"], ["stats"], ["langs"]]) {
      const result = await cli(args, e);
      expect(result.stderr).not.toContain("unknown command");
    }
  });
});

describe("claudelingo status", () => {
  it("distinguishes never-written from unreadable", async () => {
    const e = fresh();
    const missing = await cli(["status"], e);
    expect(missing.stdout).toContain("no agent state recorded yet");

    fs.writeFileSync(statusFile(e), "{ truncated");
    const broken = await cli(["status"], e);
    // Telling them to re-run init would be useless; the fix is to delete the file.
    expect(broken.stdout).toContain("unreadable");
    expect(broken.stdout).toContain("delete it");
  });
});

describe("generated pack codes", () => {
  it("refuses a code that would be shadowed by a bundled pack", async () => {
    // `--lang Estonian` defaults to code "es". Writing it would cost a real
    // generation, print "Study it with: claudelingo --lang es", and study Spanish.
    const e = fresh();
    const result = await cli(["pack", "generate", "--lang", "Estonian"], e);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already in use");
    expect(result.stderr).toContain("--code");
    expect(fs.existsSync(path.join(e.home, "packs", "es.json"))).toBe(false);
  });

  it("refuses to silently overwrite a pack already generated", async () => {
    // Progress is keyed by position, so replacing a pack in place re-attaches box
    // levels earned on one language to the words of another.
    const e = fresh();
    const packs = path.join(e.home, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const existing = JSON.stringify({
      code: "pt", name: "P", englishName: "Portuguese",
      words: [["um", "one", "num"]],
    });
    fs.writeFileSync(path.join(packs, "pt.json"), existing);

    const bin = stubClaude(e, {
      code: "pt", name: "Polski", englishName: "Polish",
      words: [{ term: "jeden", gloss: "one", pos: "num" }],
    });
    const result = await cli(
      ["pack", "generate", "--lang", "Polish", "--code", "pt"],
      e,
      withStub(bin),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--overwrite");
    expect(fs.readFileSync(path.join(packs, "pt.json"), "utf8")).toBe(existing);
  });

  it("replaces one when told to", async () => {
    const e = fresh();
    const packs = path.join(e.home, "packs");
    fs.mkdirSync(packs, { recursive: true });
    fs.writeFileSync(
      path.join(packs, "pt.json"),
      JSON.stringify({ code: "pt", name: "P", englishName: "Portuguese", words: [["um", "one", "num"]] }),
    );
    const bin = stubClaude(e, {
      code: "pt", name: "Polski", englishName: "Polish",
      words: [{ term: "jeden", gloss: "one", pos: "num" }],
    });
    const result = await cli(
      ["pack", "generate", "--lang", "Polish", "--code", "pt", "--overwrite"],
      e,
      withStub(bin),
    );
    expect(result.code).toBe(0);
    const langs = await cli(["langs"], e);
    expect(langs.stdout).toContain("Polish");
  });

  it("lets a user pack take precedence over a bundled one when placed by hand", async () => {
    const e = fresh();
    const packs = path.join(e.home, "packs");
    fs.mkdirSync(packs, { recursive: true });
    fs.writeFileSync(
      path.join(packs, "es.json"),
      JSON.stringify({
        code: "es", name: "MiEspanol", englishName: "MySpanish",
        words: [["uno", "one", "num"], ["dos", "two", "num"], ["tres", "three", "num"], ["cuatro", "four", "num"]],
      }),
    );
    const langs = await cli(["langs"], e);
    expect(langs.stdout).toContain("MySpanish");
    expect(langs.stdout).not.toContain("312 words");
  });
});

describe("flags that need a value", () => {
  it("rejects a trailing --lang instead of silently using the default", async () => {
    const result = await cli(["stats", "--lang"], fresh());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--lang needs a value");
  });
});
