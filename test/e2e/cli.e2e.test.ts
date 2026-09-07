import fs from "node:fs";
import http from "node:http";
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

/** Serve one Anthropic streaming response, so the real client path runs. */
function stubStream(body: unknown): Promise<{ url: string; close(): void; calls: number }> {
  return new Promise((resolve) => {
    const state = { calls: 0 };
    const server = http.createServer((req, res) => {
      state.calls += 1;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_1", type: "message", role: "assistant", model: "claude-fable-5-1",
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      send("content_block_start", {
        type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: JSON.stringify(body) },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        get calls() {
          return state.calls;
        },
      } as { url: string; close(): void; calls: number });
    });
  });
}

describe("claudelingo pack generate", () => {
  it("writes a pack that loads back and can be studied", async () => {
    const e = fresh();
    const server = await stubStream({
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
    try {
      const generated = await cli(
        ["pack", "generate", "--lang", "Portuguese", "--code", "pt", "--count", "4"],
        e,
        { ANTHROPIC_API_KEY: "test-key-not-real", ANTHROPIC_BASE_URL: server.url },
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
    } finally {
      server.close();
    }
  });

  it("writes nothing when the model returns something unusable", async () => {
    const e = fresh();
    const server = await stubStream({ code: "pt", name: "P", englishName: "Portuguese", words: [] });
    try {
      const result = await cli(["pack", "generate", "--lang", "Portuguese", "--code", "pt"], e, {
        ANTHROPIC_API_KEY: "test-key-not-real",
        ANTHROPIC_BASE_URL: server.url,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no words");
      expect(fs.existsSync(path.join(e.home, "packs", "pt.json"))).toBe(false);
    } finally {
      server.close();
    }
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
    expect(result.stdout).toContain("Removed: Codex notify");
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).not.toContain(
      "claudelingo",
    );
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

    const server = await stubStream({
      code: "pt", name: "Polski", englishName: "Polish",
      words: [{ term: "jeden", gloss: "one", pos: "num" }],
    });
    try {
      const result = await cli(
        ["pack", "generate", "--lang", "Polish", "--code", "pt"],
        e,
        { ANTHROPIC_API_KEY: "test-key-not-real", ANTHROPIC_BASE_URL: server.url },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--overwrite");
      expect(fs.readFileSync(path.join(packs, "pt.json"), "utf8")).toBe(existing);
    } finally {
      server.close();
    }
  });

  it("replaces one when told to", async () => {
    const e = fresh();
    const packs = path.join(e.home, "packs");
    fs.mkdirSync(packs, { recursive: true });
    fs.writeFileSync(
      path.join(packs, "pt.json"),
      JSON.stringify({ code: "pt", name: "P", englishName: "Portuguese", words: [["um", "one", "num"]] }),
    );
    const server = await stubStream({
      code: "pt", name: "Polski", englishName: "Polish",
      words: [{ term: "jeden", gloss: "one", pos: "num" }],
    });
    try {
      const result = await cli(
        ["pack", "generate", "--lang", "Polish", "--code", "pt", "--overwrite"],
        e,
        { ANTHROPIC_API_KEY: "test-key-not-real", ANTHROPIC_BASE_URL: server.url },
      );
      expect(result.code).toBe(0);
      const langs = await cli(["langs"], e);
      expect(langs.stdout).toContain("Polish");
    } finally {
      server.close();
    }
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
