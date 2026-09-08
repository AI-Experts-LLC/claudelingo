import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLI, type Env, cli, makeEnv, requireBuild } from "./harness.js";

let env: Env;
beforeAll(requireBuild);
afterEach(() => env?.cleanup());

function fresh(): Env {
  env = makeEnv();
  return env;
}

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/** The payload Claude Code pipes to a SessionStart hook. */
const SESSION_JSON = JSON.stringify({
  session_id: "abc",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/repo",
  hook_event_name: "SessionStart",
  source: "startup",
});

function sessionStart(e: Env, extra: Record<string, string> = {}) {
  return cli(["session-start"], e, extra);
}

describe("opening the pane when a session starts", () => {
  it("does nothing outside tmux, where there is nowhere to put a pane", async () => {
    const e = fresh();
    const result = await sessionStart(e, { TMUX: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("never fails, whatever Claude Code hands it", async () => {
    // It is wired into session startup; a non-zero exit or noise on stdout would
    // land in the middle of someone opening Claude Code.
    const e = fresh();
    fs.writeFileSync(path.join(e.home, "settings.json"), "{ truncated");
    for (const extra of [{ TMUX: "" }, { TMUX: "not-a-real-socket" }]) {
      const result = await sessionStart(e, extra);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("can be turned off", async () => {
    const e = fresh();
    fs.writeFileSync(
      path.join(e.home, "settings.json"),
      JSON.stringify({ lang: "es", autoPane: false, onboarded: true }),
    );
    const result = await sessionStart(e, { TMUX: "fake" });
    expect(result.code).toBe(0);
  });

  it.skipIf(!hasTmux)("opens the pane beside the session, once", async () => {
    const e = fresh();
    const session = `claudelingo-sess-${process.pid}`;
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    spawnSync("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "40"]);
    try {
      const panes = () =>
        (spawnSync("tmux", ["list-panes", "-t", session, "-F", "#{pane_index}"], {
          encoding: "utf8",
        }).stdout ?? "").trim().split("\n").filter(Boolean).length;
      expect(panes()).toBe(1);

      // Exactly as the hook fires it: from inside the session, payload on stdin.
      spawnSync("tmux", [
        "send-keys", "-t", session,
        `CLAUDELINGO_HOME=${e.home} ${process.execPath} ${CLI} session-start <<'EOF'\n${SESSION_JSON}\nEOF`,
        "Enter",
      ]);
      await new Promise((r) => setTimeout(r, 4000));
      expect(panes()).toBe(2);

      const quiz = spawnSync("tmux", ["capture-pane", "-t", `${session}.1`, "-p"], {
        encoding: "utf8",
      }).stdout;
      expect(quiz).toContain("claudelingo");

      // A second session in the same window must not stack another pane: the
      // first one holds the lock, so a second would exit on a refusal anyway.
      spawnSync("tmux", [
        "send-keys", "-t", `${session}.0`,
        `CLAUDELINGO_HOME=${e.home} ${process.execPath} ${CLI} session-start </dev/null`,
        "Enter",
      ]);
      await new Promise((r) => setTimeout(r, 3000));
      expect(panes()).toBe(2);
    } finally {
      spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    }
  }, 30_000);
});
