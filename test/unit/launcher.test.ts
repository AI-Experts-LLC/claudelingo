import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { launch, planLaunch, shellQuote, splitCommand } from "../../src/launcher.js";

const base = {
  agent: ["claude", "--model", "opus"],
  pane: ["/usr/bin/node", "/opt/cli.js", "--lang", "es"],
};

/** A stand-in tmux that records every call and answers with scripted statuses. */
function fakeTmux(statuses: Record<string, number[]> = {}) {
  const calls: string[][] = [];
  const counts: Record<string, number> = {};
  const run = vi.fn((_command: string, args: string[]) => {
    calls.push(args);
    const verb = args[0] as string;
    counts[verb] = (counts[verb] ?? 0) + 1;
    const scripted = statuses[verb];
    const status = scripted ? (scripted[counts[verb] - 1] ?? scripted.at(-1) ?? 0) : 0;
    return { status, stdout: "%7", stderr: "" } as never;
  });
  return { run, calls, counts, of: (verb: string) => calls.filter((c) => c[0] === verb) };
}

describe("choosing how to open the pane", () => {
  it("splits the current window when already inside tmux", () => {
    const { run } = fakeTmux();
    expect(planLaunch({ TMUX: "/tmp/tmux-1000/default,123,0" }, run).kind).toBe("tmux-split");
  });

  it("starts a session when outside tmux", () => {
    const { run } = fakeTmux();
    expect(planLaunch({}, run).kind).toBe("tmux-session");
  });

  it("gives up on the pane when tmux is missing", () => {
    const run = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }) as never);
    const plan = planLaunch({ TMUX: "x" }, run);
    expect(plan.kind).toBe("none");
    expect(plan.reason).toContain("tmux is not installed");
  });
});

describe("the pane command", () => {
  it("uses the modern percentage form by default and reports the pane id", () => {
    const args = splitCommand(base);
    expect(args.slice(0, 4)).toEqual(["split-window", "-h", "-l", "40%"]);
    expect(args).toContain("-d");
    expect(args.join(" ")).toContain("-P -F #{pane_id}");
  });

  it("falls back to the pre-3.1 sizing flag", () => {
    expect(splitCommand(base, { legacy: true }).slice(0, 4)).toEqual([
      "split-window", "-h", "-p", "40",
    ]);
  });

  it("passes the environment the pane needs across", () => {
    // A new tmux pane inherits the SERVER's environment, not this shell's.
    const args = splitCommand({ ...base, passEnv: { CLAUDELINGO_HOME: "/tmp/h" } });
    expect(args).toContain("-e");
    expect(args).toContain("CLAUDELINGO_HOME=/tmp/h");
  });

  it("starts the pane and nothing else, which is what makes it safe to retry", () => {
    // If the retried command contained the agent, a tmux failure would start a
    // second Claude Code in the same directory.
    const joined = splitCommand(base).join(" ");
    expect(joined).not.toContain("claude");
    expect(joined).toContain("cli.js");
  });

  it("quotes a path a shell would otherwise mangle", () => {
    for (const raw of ["/tmp/it's here", "/tmp/a b", '/tmp/"q"', "/tmp/$HOME", "/tmp/a;b"]) {
      const printed = execFileSync("sh", ["-c", `printf %s ${shellQuote(raw)}`], {
        encoding: "utf8",
      });
      expect(printed).toBe(raw);
    }
  });
});

describe("launching inside tmux", () => {
  it("retries the legacy sizing when the modern form is rejected", async () => {
    const tmux = fakeTmux({ "split-window": [1, 0] });
    const result = await launch({ ...base, agent: ["true"], env: { TMUX: "x" }, run: tmux.run });
    const splits = tmux.of("split-window");
    expect(splits).toHaveLength(2);
    expect(splits[0]).toContain("-l");
    expect(splits[1]).toContain("-p");
    expect(result.plan.reason).toBeUndefined();
  });

  it("drops the env flags for a tmux too old to know them", async () => {
    const tmux = fakeTmux({ "split-window": [1, 1, 0] });
    await launch({
      ...base, agent: ["true"], env: { TMUX: "x" },
      passEnv: { CLAUDELINGO_HOME: "/tmp/h" }, run: tmux.run,
    });
    const splits = tmux.of("split-window");
    expect(splits[0]).toContain("-e");
    expect(splits.at(-1)).not.toContain("-e");
  });

  it("still starts the agent when the split fails outright", async () => {
    const tmux = fakeTmux({ "split-window": [1] });
    const result = await launch({ ...base, agent: ["true"], env: { TMUX: "x" }, run: tmux.run });
    expect(result.plan.reason).toContain("could not split");
    expect(result.code).toBe(0);
  });

  it("closes the pane it opened when the agent exits", async () => {
    // Three runs in one window should not leave three panes behind.
    const tmux = fakeTmux();
    await launch({ ...base, agent: ["true"], env: { TMUX: "x" }, run: tmux.run });
    expect(tmux.of("kill-pane")[0]).toEqual(["kill-pane", "-t", "%7"]);
  });

  it("reports the agent's exit code", async () => {
    const tmux = fakeTmux();
    const result = await launch({ ...base, agent: ["false"], env: { TMUX: "x" }, run: tmux.run });
    expect(result.code).toBe(1);
  });

  it("reports a missing agent binary rather than hanging", async () => {
    const tmux = fakeTmux();
    const result = await launch({
      ...base, agent: ["definitely-not-a-real-binary-xyz"], env: { TMUX: "x" }, run: tmux.run,
    });
    expect(result.code).toBe(127);
  });
});

describe("launching outside tmux", () => {
  it("creates the session around the agent, then splits the pane off", async () => {
    const tmux = fakeTmux();
    await launch({ ...base, env: {}, run: tmux.run });
    const created = tmux.of("new-session");
    expect(created).toHaveLength(1);
    // The agent lives in the session, detached, and is started exactly once.
    expect(created[0]).toContain("-d");
    expect(created[0]?.join(" ")).toContain("'claude' '--model' 'opus'");
    // The pane is split off separately, so retrying it cannot restart the agent.
    expect(tmux.of("split-window")).toHaveLength(1);
    // And the terminal is handed to the session.
    expect(tmux.of("attach")).toHaveLength(1);
  });

  it("never re-runs the agent when a retry is needed", async () => {
    // The blocker this guards: a retry of a command containing the agent starts a
    // second Claude Code in the same working directory.
    const tmux = fakeTmux({ "split-window": [1, 1, 0] });
    await launch({ ...base, env: {}, passEnv: { CLAUDELINGO_HOME: "/tmp/h" }, run: tmux.run });
    expect(tmux.of("new-session")).toHaveLength(1);
  });

  it("retries the session without env flags, still only once with the agent", async () => {
    const tmux = fakeTmux({ "new-session": [1, 0] });
    await launch({ ...base, env: {}, passEnv: { CLAUDELINGO_HOME: "/tmp/h" }, run: tmux.run });
    const created = tmux.of("new-session");
    expect(created).toHaveLength(2);
    expect(created[0]).toContain("-e");
    expect(created[1]).not.toContain("-e");
  });

  it("kills the session when the agent finishes, so the pane cannot hold the terminal", async () => {
    const tmux = fakeTmux();
    await launch({ ...base, env: {}, run: tmux.run });
    const script = tmux.of("new-session")[0]?.at(-1) as string;
    expect(script).toContain("kill-session");
    expect(script).toContain("$?"); // and records the agent's exit code
  });

  it("runs the agent bare when the session cannot be created at all", async () => {
    // Otherwise the user gets tmux's raw error and no agent whatsoever.
    const tmux = fakeTmux({ "new-session": [1, 1] });
    const result = await launch({ ...base, agent: ["false"], env: {}, run: tmux.run });
    expect(result.plan.reason).toContain("was not opened");
    expect(result.code).toBe(1); // the agent still ran, and its code came back
  });
});
