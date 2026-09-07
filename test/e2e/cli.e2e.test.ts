import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Env, cli, makeEnv, readProgress, requireBuild, statusFile } from "./harness.js";

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
