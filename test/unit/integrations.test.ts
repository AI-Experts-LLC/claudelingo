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
    const toml = '[tui]\nnotifications = true\n';
    const out = codex.withNotify(toml, "claudelingo");
    expect(out.indexOf("notify =")).toBeLessThan(out.indexOf("[tui]"));
  });

  it("replaces someone else's notify rather than adding a second one", () => {
    const out = codex.withNotify('notify = ["other-tool"]\n', "claudelingo");
    expect(out.match(/notify =/g)).toHaveLength(1);
    expect(out).toContain("claudelingo");
  });

  it("is idempotent", () => {
    const once = codex.withNotify("", "claudelingo");
    expect(codex.withNotify(once, "claudelingo")).toBe(once);
  });

  it("removes only its own line", () => {
    const toml = codex.withNotify("model = \"gpt\"\n", "claudelingo");
    const cleaned = codex.removeNotify(toml, "claudelingo");
    expect(cleaned).not.toContain("claudelingo");
    expect(cleaned).toContain('model = "gpt"');
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
