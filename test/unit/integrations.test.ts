import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as claudeCode from "../../src/integrations/claudeCode.js";
import * as codex from "../../src/integrations/codex.js";
import { tempHome } from "../helpers.js";

const dirs: string[] = [];
function dir(): string {
  const d = tempHome();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("Claude Code hooks", () => {
  it("installs a hook for every event it models", () => {
    const settings = claudeCode.withHooks({}, "claudelingo");
    for (const event of claudeCode.HOOK_EVENTS) {
      expect(settings.hooks?.[event]?.[0]?.hooks[0]?.command).toBe(
        `claudelingo hook ${event} --source claude`,
      );
    }
  });

  it("leaves unrelated settings and other people's hooks alone", () => {
    const original = {
      model: "opus",
      permissions: { allow: ["Bash"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier" }] }],
      },
    };
    const settings = claudeCode.withHooks(original, "claudelingo");
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash"] });
    expect(settings.hooks?.PostToolUse).toEqual(original.hooks.PostToolUse);
    const stopCommands = settings.hooks?.Stop?.flatMap((m) => m.hooks.map((h) => h.command));
    expect(stopCommands).toContain("notify-send done");
    expect(stopCommands).toContain("claudelingo hook Stop --source claude");
  });

  it("is idempotent — installing twice does not duplicate entries", () => {
    const once = claudeCode.withHooks({}, "claudelingo");
    const twice = claudeCode.withHooks(once, "claudelingo");
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(twice.hooks?.Stop).toHaveLength(1);
  });

  it("removes only its own hooks", () => {
    const withOurs = claudeCode.withHooks(
      { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } },
      "claudelingo",
    );
    const cleaned = claudeCode.removeHooks(withOurs);
    const commands = Object.values(cleaned.hooks ?? {})
      .flat()
      .flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands).toEqual(["notify-send done"]);
  });

  it("drops the hooks key entirely when nothing is left", () => {
    const cleaned = claudeCode.removeHooks(claudeCode.withHooks({}, "claudelingo"));
    expect(cleaned.hooks).toBeUndefined();
  });

  it("writes and re-reads a settings file", () => {
    const file = path.join(dir(), ".claude", "settings.json");
    claudeCode.install(file, "claudelingo");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.hooks.UserPromptSubmit).toBeDefined();
    claudeCode.uninstall(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).hooks).toBeUndefined();
  });

  it("refuses to clobber a settings file it cannot parse", () => {
    const file = path.join(dir(), "settings.json");
    fs.writeFileSync(file, "{ broken");
    expect(() => claudeCode.install(file, "claudelingo")).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
  });
});

describe("Codex notify config", () => {
  it("adds a notify line to an empty config", () => {
    expect(codex.withNotify("", "claudelingo")).toContain('notify = ["claudelingo", "notify"]');
  });

  it("puts notify above the first table, where a top-level key belongs", () => {
    const out = codex.withNotify("[tui]\nnotifications = true\n", "claudelingo");
    expect(out.indexOf("notify =")).toBeLessThan(out.indexOf("[tui]"));
  });

  it("refuses to overwrite another tool's notify program", () => {
    // Codex allows exactly one notify program, so replacing it would silently
    // disable whatever the user already had wired up.
    const toml = 'notify = ["/usr/local/bin/my-notifier", "--flag"]\n';
    expect(() => codex.withNotify(toml, "claudelingo")).toThrow(codex.CodexConfigError);
    expect(() => codex.withNotify(toml, "claudelingo")).toThrow(/already sets a different notify/);
  });

  it("leaves a table-scoped notify key alone", () => {
    // `[tui] notify` is a completely different setting; rewriting it would destroy
    // the user's config AND fail to install ours.
    const toml = "[tui]\nnotify = true\n";
    const out = codex.withNotify(toml, "claudelingo");
    expect(out).toContain("[tui]");
    expect(out).toContain("notify = true");
    expect(out.indexOf('notify = ["claudelingo"')).toBeLessThan(out.indexOf("[tui]"));
  });

  it("sees a notify value spread over several lines as one entry", () => {
    const toml = 'notify = [\n  "my-notifier",\n  "--flag"\n]\n';
    const found = codex.findNotify(toml, "claudelingo");
    expect(found).toMatchObject({ start: 0, end: 3, ours: false });
    // and therefore refuses rather than beheading it into invalid TOML
    expect(() => codex.withNotify(toml, "claudelingo")).toThrow(codex.CodexConfigError);
  });

  it("removes its own multi-line entry whole", () => {
    const toml = 'notify = [\n  "claudelingo",\n  "notify"\n]\nmodel = "gpt"\n';
    const cleaned = codex.removeNotify(toml, "claudelingo");
    expect(cleaned).not.toContain("claudelingo");
    expect(cleaned).not.toContain("notify");
    expect(cleaned).toContain('model = "gpt"');
  });

  it("is idempotent", () => {
    const once = codex.withNotify("", "claudelingo");
    expect(codex.withNotify(once, "claudelingo")).toBe(once);
  });

  it("leaves a foreign notify alone on uninstall", () => {
    const toml = 'notify = ["someone-else"]\n';
    expect(codex.removeNotify(toml, "claudelingo")).toBe(toml);
  });

  it("escapes a path that would otherwise break the TOML", () => {
    const out = codex.withNotify("", String.raw`C:\tools\claudelingo.exe`);
    expect(out).toContain(String.raw`"C:\\tools\\claudelingo.exe"`);
  });

  it("backs the config up before writing, and writes atomically", () => {
    const file = path.join(dir(), "config.toml");
    fs.writeFileSync(file, 'model = "gpt"\n');
    const backup = codex.installNotify("claudelingo", file);
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(backup as string, "utf8")).toBe('model = "gpt"\n');
    expect(fs.readFileSync(file, "utf8")).toContain("claudelingo");
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("reports rather than writes when the config already has a foreign notify", () => {
    const file = path.join(dir(), "config.toml");
    const original = 'notify = ["other"]\n';
    fs.writeFileSync(file, original);
    expect(() => codex.installNotify("claudelingo", file)).toThrow(codex.CodexConfigError);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });
});

describe("Codex transcript classification", () => {
  it("reads a turn starting", () => {
    expect(codex.classifyRolloutLine(JSON.stringify({ type: "task_started" }))).toBe("busy");
    expect(
      codex.classifyRolloutLine(
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
      ),
    ).toBe("busy");
  });

  it("reads a turn ending", () => {
    expect(
      codex.classifyRolloutLine(JSON.stringify({ payload: { type: "task_complete" } })),
    ).toBe("idle");
  });

  it("ignores assistant messages, noise and malformed lines", () => {
    expect(
      codex.classifyRolloutLine(
        JSON.stringify({ payload: { type: "message", role: "assistant" } }),
      ),
    ).toBeNull();
    expect(codex.classifyRolloutLine(JSON.stringify({ payload: { type: "token_count" } }))).toBeNull();
    expect(codex.classifyRolloutLine("not json at all")).toBeNull();
    expect(codex.classifyRolloutLine("")).toBeNull();
  });

  it("classifies the notify payload", () => {
    expect(codex.classifyNotification(JSON.stringify({ type: "agent-turn-complete" }))).toBe("idle");
    expect(codex.classifyNotification(JSON.stringify({ type: "something-else" }))).toBeNull();
    expect(codex.classifyNotification("garbage")).toBeNull();
  });
});

describe("Codex session watcher", () => {
  it("reports a turn starting and ending in a live transcript", async () => {
    const sessions = path.join(dir(), "sessions", "2026", "09", "07");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "rollout-1.jsonl");
    fs.writeFileSync(file, "");

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: path.join(sessions, "..", "..", ".."),
      intervalMs: 20,
    });
    // First poll adopts the file; appends after that are what we react to.
    await new Promise((r) => setTimeout(r, 60));

    fs.appendFileSync(file, `${JSON.stringify({ type: "task_started" })}\n`);
    await vi.waitFor(() => expect(seen).toContain("busy"), { timeout: 3000, interval: 20 });

    fs.appendFileSync(file, `${JSON.stringify({ payload: { type: "task_complete" } })}\n`);
    await vi.waitFor(() => expect(seen).toContain("idle"), { timeout: 3000, interval: 20 });
    watcher.stop();
  });

  it("ignores history already on disk when it starts", async () => {
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "rollout-old.jsonl"),
      `${JSON.stringify({ type: "task_started" })}\n`,
    );

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), { dir: sessions, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toHaveLength(0);
    watcher.stop();
  });

  it("survives a missing sessions directory", () => {
    const watcher = codex.watchCodexSession(() => {}, {
      dir: path.join(dir(), "does-not-exist"),
      intervalMs: 20,
    });
    watcher.stop();
  });

  it("handles a partial line split across two appends", async () => {
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "rollout-2.jsonl");
    fs.writeFileSync(file, "");

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), { dir: sessions, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 60));

    const line = JSON.stringify({ type: "task_started" });
    fs.appendFileSync(file, line.slice(0, 10));
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toHaveLength(0);

    fs.appendFileSync(file, `${line.slice(10)}\n`);
    await vi.waitFor(() => expect(seen).toContain("busy"), { timeout: 3000, interval: 20 });
    watcher.stop();
  });
});

describe("Codex watcher: which bytes it reads", () => {
  async function settle(ms = 150) {
    await new Promise((r) => setTimeout(r, ms));
  }

  it("reads a session that starts after the watcher, from its very first line", async () => {
    // Codex writes the session header and the first user turn together, so seeking
    // to EOF on a newly-seen file loses the busy edge for turn one of every session.
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 20,
    });
    await settle(60);

    fs.writeFileSync(
      path.join(sessions, "rollout-new.jsonl"),
      `${JSON.stringify({ type: "session_meta" })}\n${JSON.stringify({ type: "task_started" })}\n`,
    );
    await vi.waitFor(() => expect(seen).toContain("busy"), { timeout: 3000, interval: 20 });
    watcher.stop();
  });

  it("still ignores a session that already existed", async () => {
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "rollout-old.jsonl"),
      `${JSON.stringify({ type: "task_started" })}\n`,
    );

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 20,
    });
    await settle(200);
    expect(seen).toEqual([]);
    watcher.stop();
  });

  it("follows a rotation to a new session file", async () => {
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const first = path.join(sessions, "rollout-1.jsonl");
    fs.writeFileSync(first, `${JSON.stringify({ type: "task_started" })}\n`);

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 20,
    });
    await settle(80);
    expect(seen).toEqual([]); // pre-existing history ignored

    // A new session rotates in; its first turn must register.
    await settle(20);
    fs.writeFileSync(
      path.join(sessions, "rollout-2.jsonl"),
      `${JSON.stringify({ type: "task_started" })}\n`,
    );
    await vi.waitFor(() => expect(seen).toEqual(["busy"]), { timeout: 3000, interval: 20 });
    watcher.stop();
  });

  it("does not replay history when a transcript is truncated", async () => {
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "rollout-t.jsonl");
    fs.writeFileSync(file, "");

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 20,
    });
    await settle(60);

    fs.appendFileSync(file, `${JSON.stringify({ type: "task_started" })}\n`);
    await vi.waitFor(() => expect(seen).toEqual(["busy"]), { timeout: 3000, interval: 20 });

    // A rewrite that shrinks the file must resync, not re-read from zero and fire
    // a second busy while the user is typing.
    fs.writeFileSync(file, "");
    await settle(200);
    expect(seen).toEqual(["busy"]);
    watcher.stop();
  });

  it("starts working when the sessions directory appears later", async () => {
    // Opening the pane before Codex has ever run must not disable the integration
    // for the life of the pane.
    const home = dir();
    const sessions = path.join(home, "sessions");
    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 20,
    });
    await settle(60);

    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "rollout-late.jsonl"),
      `${JSON.stringify({ type: "task_started" })}\n`,
    );
    await vi.waitFor(() => expect(seen).toContain("busy"), { timeout: 3000, interval: 20 });
    watcher.stop();
  });

  it("reports once when it can no longer read the transcript", async () => {
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "rollout-x.jsonl");
    fs.writeFileSync(file, "");

    const errors: string[] = [];
    const watcher = codex.watchCodexSession(() => {}, {
      dir: sessions, intervalMs: 10, onError: (m) => errors.push(m),
    });
    await settle(40);

    // Make it unreadable, then keep giving it new bytes to try to read.
    fs.appendFileSync(file, `${JSON.stringify({ type: "task_started" })}\n`);
    fs.chmodSync(file, 0o000);
    for (let i = 0; i < 8; i++) {
      fs.chmodSync(file, 0o200);
      fs.appendFileSync(file, `${JSON.stringify({ type: "task_started" })}\n`);
      fs.chmodSync(file, 0o000);
      await settle(30);
    }
    fs.chmodSync(file, 0o600);
    // A silent watcher is the failure mode this guards against.
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThanOrEqual(1);
    watcher.stop();
  });
});
