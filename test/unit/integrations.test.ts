import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateForEvent } from "../../src/agentState.js";
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
  /**
   * Written out literally rather than looped over `HOOK_EVENTS`, which would be
   * the implementation compared against itself — deleting an event from the list
   * would then silently disable that behaviour with a green suite.
   */
  const EXPECTED_HOOKS = [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "SessionEnd",
    "Notification",
  ];

  it("installs exactly the hooks the product depends on", () => {
    const settings = claudeCode.withHooks({}, "claudelingo");
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([...EXPECTED_HOOKS].sort());
    for (const event of EXPECTED_HOOKS) {
      // SessionStart opens the pane rather than reporting agent state, so it is
      // the one hook wired to a different command.
      const expected =
        event === "SessionStart"
          ? "claudelingo session-start"
          : `claudelingo hook ${event} --source claude`;
      expect(settings.hooks?.[event]?.[0]?.hooks[0]?.command, event).toBe(expected);
    }
  });

  it("opens the pane on SessionStart, in the background", () => {
    // Hooks block the session by default; making the user wait on a tmux split
    // before they can type would be a poor trade.
    const settings = claudeCode.withHooks({}, "claudelingo");
    const entry = settings.hooks?.SessionStart?.[0]?.hooks[0];
    expect(entry?.command).toBe("claudelingo session-start");
    expect(entry?.async).toBe(true);
    // It reports no agent state — it is not that kind of hook.
    expect(stateForEvent("SessionStart")).toBeNull();
  });

  it("installs Notification, which is what stands the pane down for a prompt", () => {
    // Called out on its own because it is the least obvious of the five and the
    // easiest to drop: Claude fires it when it wants a permission decision.
    const settings = claudeCode.withHooks({}, "claudelingo");
    expect(settings.hooks?.Notification?.[0]?.hooks[0]?.command).toContain("hook Notification");
    expect(stateForEvent("Notification")).toBe("idle");
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
    claudeCode.uninstall(file, "claudelingo");
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
      scanIntervalMs: 20,
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

  it("survives a missing sessions directory without reporting it as a fault", async () => {
    // Codex simply may not be installed; that is not something to warn about.
    const states: string[] = [];
    const errors: Array<string | null> = [];
    const watcher = codex.watchCodexSession((s) => states.push(s), {
      dir: path.join(dir(), "does-not-exist"),
      intervalMs: 20,
      scanIntervalMs: 20,
      onError: (m) => errors.push(m),
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(states).toEqual([]);
    expect(errors).toEqual([]);
    expect(() => watcher.stop()).not.toThrow();
  });

  it("reports a sessions directory it cannot read", async () => {
    // Distinct from "not installed": Codex IS there and the watcher is blind.
    const home = dir();
    const sessions = path.join(home, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.chmodSync(sessions, 0o000);
    const errors: Array<string | null> = [];
    const watcher = codex.watchCodexSession(() => {}, {
      dir: sessions, intervalMs: 10, scanIntervalMs: 10, onError: (m) => errors.push(m),
    });
    try {
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
        timeout: 3000, interval: 20,
      });
      expect(errors[0]).toContain("cannot read");
    } finally {
      fs.chmodSync(sessions, 0o700);
      watcher.stop();
    }
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
      dir: sessions, intervalMs: 20, scanIntervalMs: 20,
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
      dir: sessions, intervalMs: 20, scanIntervalMs: 20,
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
      dir: sessions, intervalMs: 20, scanIntervalMs: 20,
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
      dir: sessions, intervalMs: 20, scanIntervalMs: 20,
    });
    await settle(60);

    // Two turns, so the read offset ends up well past what the shorter rewrite
    // below will contain.
    const started = `${JSON.stringify({ type: "task_started" })}\n`;
    fs.appendFileSync(file, started + `${JSON.stringify({ type: "task_complete" })}\n` + started);
    await vi.waitFor(() => expect(seen).toEqual(["busy", "idle", "busy"]), {
      timeout: 3000, interval: 20,
    });

    // A rewrite that shrinks the file must resync, not re-read from zero and fire
    // a spurious busy while the user is typing. The replacement is deliberately
    // SHORTER than the current offset and still contains a turn marker — an empty
    // truncation, or one no shorter than the offset, would pass either way.
    fs.writeFileSync(file, started);
    expect(fs.statSync(file).size).toBeLessThan(started.length * 2);
    await settle(400);
    expect(seen).toEqual(["busy", "idle", "busy"]);
    watcher.stop();
  });

  it("starts working when the sessions directory appears later", async () => {
    // Opening the pane before Codex has ever run must not disable the integration
    // for the life of the pane.
    const home = dir();
    const sessions = path.join(home, "sessions");
    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 20, scanIntervalMs: 20,
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

    const errors: Array<string | null> = [];
    const watcher = codex.watchCodexSession(() => {}, {
      dir: sessions, intervalMs: 10, scanIntervalMs: 10, onError: (m) => errors.push(m),
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

describe("Codex watcher: reporting and recovering", () => {
  async function settle(ms = 150) {
    await new Promise((r) => setTimeout(r, ms));
  }

  it("reports a nested directory it cannot read, where Codex actually stores transcripts", async () => {
    // Rollouts live at sessions/YYYY/MM/DD, so a check that only covers the root
    // misses every directory that realistically becomes unreadable.
    const sessions = path.join(dir(), "sessions");
    const nested = path.join(sessions, "2026", "09", "07");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "rollout-1.jsonl"), "");
    fs.chmodSync(path.join(sessions, "2026"), 0o000);

    const errors: Array<string | null> = [];
    const watcher = codex.watchCodexSession(() => {}, {
      dir: sessions, intervalMs: 10, scanIntervalMs: 10, onError: (m) => errors.push(m),
    });
    try {
      await vi.waitFor(() => expect(errors.filter(Boolean).length).toBeGreaterThan(0), {
        timeout: 3000, interval: 20,
      });
      expect(errors[0]).toContain("cannot read");
    } finally {
      fs.chmodSync(path.join(sessions, "2026"), 0o700);
      watcher.stop();
    }
  });

  it("clears the report once it can read again", async () => {
    // Without the null case the banner claims the watcher is broken forever, while
    // it is in fact happily reading turns.
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.chmodSync(sessions, 0o000);

    const errors: Array<string | null> = [];
    const states: string[] = [];
    const watcher = codex.watchCodexSession((s) => states.push(s), {
      dir: sessions, intervalMs: 10, scanIntervalMs: 10, onError: (m) => errors.push(m),
    });
    try {
      await vi.waitFor(() => expect(errors.filter(Boolean).length).toBeGreaterThan(0), {
        timeout: 3000, interval: 20,
      });

      fs.chmodSync(sessions, 0o700);
      fs.writeFileSync(
        path.join(sessions, "rollout-live.jsonl"),
        `${JSON.stringify({ type: "task_started" })}\n`,
      );
      await vi.waitFor(() => expect(states).toContain("busy"), { timeout: 3000, interval: 20 });
      // The recovery has to reach the UI, not just reset an internal counter.
      expect(errors.at(-1)).toBeNull();
    } finally {
      fs.chmodSync(sessions, 0o700);
      watcher.stop();
    }
  });

  it("does not replay a transcript when the newest one flips back to it", async () => {
    // Two Codex sessions alternating. Falling back to the startup snapshot would
    // re-read everything since the pane opened, including a stale idle that would
    // stand the pane down mid-turn.
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const a = path.join(sessions, "rollout-a.jsonl");
    const b = path.join(sessions, "rollout-b.jsonl");
    fs.writeFileSync(a, "");

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 20, scanIntervalMs: 20,
    });
    await settle(60);

    const line = (type: string) => `${JSON.stringify({ type })}\n`;
    fs.appendFileSync(a, line("task_started") + line("task_complete"));
    await vi.waitFor(() => expect(seen).toEqual(["busy", "idle"]), { timeout: 3000, interval: 20 });

    // Session B becomes newest.
    await settle(30);
    fs.writeFileSync(b, line("task_started"));
    await vi.waitFor(() => expect(seen).toEqual(["busy", "idle", "busy"]), {
      timeout: 3000, interval: 20,
    });

    // Back to A with one new turn: only that turn should be reported.
    await settle(30);
    fs.appendFileSync(a, line("task_started"));
    await vi.waitFor(() => expect(seen).toEqual(["busy", "idle", "busy", "busy"]), {
      timeout: 3000, interval: 20,
    });
    await settle(200);
    expect(seen).toEqual(["busy", "idle", "busy", "busy"]);
    watcher.stop();
  });
});

describe("Codex watcher: cost and correctness of the scan", () => {
  it("notices a new session at the default cadence, without being told to hurry", async () => {
    // The production sweep is throttled so that idle cost does not grow with Codex
    // history; it still has to notice a session well inside the time a turn takes.
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), { dir: sessions });
    try {
      fs.writeFileSync(
        path.join(sessions, "rollout-new.jsonl"),
        `${JSON.stringify({ type: "task_started" })}\n`,
      );
      await vi.waitFor(() => expect(seen).toContain("busy"), { timeout: 5000, interval: 50 });
    } finally {
      watcher.stop();
    }
  });

  it("does not re-list a directory that has not changed", async () => {
    // The whole point of the cache: an established Codex history must not be
    // re-walked twice a second for the life of the pane.
    const sessions = path.join(dir(), "sessions");
    const nested = path.join(sessions, "2026", "09", "07");
    fs.mkdirSync(nested, { recursive: true });
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(nested, `rollout-${i}.jsonl`), "{}\n");
    }
    // Real Codex history is days old. A directory touched moments ago is treated
    // as volatile on purpose, because mtime granularity would hide a new file.
    const old = new Date(Date.now() - 30 * 86_400_000);
    for (
      let d = nested;
      d.startsWith(sessions);
      d = path.dirname(d)
    ) {
      fs.utimesSync(d, old, old);
    }

    const readdir = vi.spyOn(fs, "readdirSync");
    const watcher = codex.watchCodexSession(() => {}, {
      dir: sessions, intervalMs: 10, scanIntervalMs: 10,
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      // ~30 sweeps have run over settled history; the tree is listed once at
      // startup and then served from cache, so the count stays in single figures
      // rather than growing with every sweep.
      expect(readdir.mock.calls.length).toBeLessThan(10);
    } finally {
      readdir.mockRestore();
      watcher.stop();
    }
  });

  it("re-lists as soon as a directory actually changes", async () => {
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "rollout-1.jsonl"), "{}\n");

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 10, scanIntervalMs: 10,
    });
    try {
      await new Promise((r) => setTimeout(r, 60));
      fs.writeFileSync(
        path.join(sessions, "rollout-2.jsonl"),
        `${JSON.stringify({ type: "task_started" })}\n`,
      );
      await vi.waitFor(() => expect(seen).toContain("busy"), { timeout: 3000, interval: 20 });
    } finally {
      watcher.stop();
    }
  });
});

describe("Codex watcher: the cache must not hide an append", () => {
  it("notices a followed transcript being appended to in a settled directory", async () => {
    // The subtle failure the directory cache can cause: appending to a file does
    // NOT change its directory's mtime, so a settled directory keeps serving the
    // stale entry and an earlier session that resumes is never seen again.
    const sessions = path.join(dir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const a = path.join(sessions, "rollout-a.jsonl");
    const b = path.join(sessions, "rollout-b.jsonl");
    const line = (type: string) => `${JSON.stringify({ type })}\n`;
    fs.writeFileSync(a, "");
    fs.writeFileSync(b, "");

    // Age the directory so the scanner genuinely serves it from cache.
    const old = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(sessions, old, old);

    const seen: string[] = [];
    const watcher = codex.watchCodexSession((s) => seen.push(s), {
      dir: sessions, intervalMs: 20, scanIntervalMs: 20,
    });
    try {
      await new Promise((r) => setTimeout(r, 80));

      fs.appendFileSync(a, line("task_started"));
      await vi.waitFor(() => expect(seen).toEqual(["busy"]), { timeout: 3000, interval: 20 });

      fs.appendFileSync(b, line("task_complete"));
      await vi.waitFor(() => expect(seen).toEqual(["busy", "idle"]), {
        timeout: 3000, interval: 20,
      });

      // Back to A. Its directory has not changed, so only an explicit refresh of
      // the transcripts we have followed can see this.
      fs.appendFileSync(a, line("task_started"));
      await vi.waitFor(() => expect(seen).toEqual(["busy", "idle", "busy"]), {
        timeout: 3000, interval: 20,
      });
    } finally {
      watcher.stop();
    }
  });
});

describe("Claude Code status line", () => {
  it("points at us and asks for a refresh timer", () => {
    // Claude Code's own updates are event-driven and go quiet while it is
    // thinking, which is exactly when the line is supposed to be teaching.
    const settings = claudeCode.withStatusLine({}, "claudelingo");
    expect(settings.statusLine).toMatchObject({
      type: "command",
      command: "claudelingo statusline",
    });
    expect(settings.statusLine?.refreshInterval).toBeGreaterThanOrEqual(1);
  });

  it("refuses to take a slot another tool is using", () => {
    // Unlike hooks, there is exactly one status line and nowhere for both to live.
    const theirs = { statusLine: { type: "command", command: "~/.claude/mine.sh" } };
    expect(() => claudeCode.withStatusLine(theirs, "claudelingo")).toThrow(
      claudeCode.StatusLineTaken,
    );
  });

  it("is idempotent", () => {
    const once = claudeCode.withStatusLine({}, "claudelingo");
    expect(claudeCode.withStatusLine(once, "claudelingo")).toEqual(once);
  });

  it("removes only its own", () => {
    const ours = claudeCode.withStatusLine({ model: "opus" }, "claudelingo");
    const cleaned = claudeCode.removeStatusLine(ours, "claudelingo");
    expect(cleaned.statusLine).toBeUndefined();
    expect(cleaned.model).toBe("opus");

    const theirs = { statusLine: { type: "command", command: "theirs.sh" } };
    expect(claudeCode.removeStatusLine(theirs, "claudelingo")).toEqual(theirs);
  });

  it("still installs the hooks when the status line slot is taken", () => {
    const file = path.join(dir(), "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ statusLine: { type: "command", command: "theirs.sh" } }),
    );
    const result = claudeCode.install(file, "claudelingo");
    // The hooks are what make the pane work at all; losing them over a status
    // line would be a poor trade.
    expect(result.statusLineProblem).toContain("already configured");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.statusLine.command).toBe("theirs.sh");
  });

  it("can be told not to touch the status line at all", () => {
    const file = path.join(dir(), "settings.json");
    claudeCode.install(file, "claudelingo", { statusLine: false });
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(settings.statusLine).toBeUndefined();
    expect(settings.hooks.Stop).toBeDefined();
  });
});
