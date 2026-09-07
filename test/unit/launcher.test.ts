import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

  it("starts a session when outside tmux, given a terminal", () => {
    const { run } = fakeTmux();
    expect(planLaunch({}, run, true).kind).toBe("tmux-session");
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
    await launch({ ...base, env: {}, isTty: true, run: tmux.run });
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
    await launch({ ...base, env: {}, isTty: true, passEnv: { CLAUDELINGO_HOME: "/tmp/h" }, run: tmux.run });
    expect(tmux.of("new-session")).toHaveLength(1);
  });

  it("gives the agent the caller's environment, not the tmux server's", async () => {
    // A process started inside tmux inherits the SERVER's environment, which on
    // any machine where tmux is already running is whatever it was back then —
    // so if `claude` is on the user's PATH but not the server's, nothing runs.
    let exported = "";
    let envPath = "";
    const tmux = fakeTmux();
    const capture = vi.fn((command: string, args: string[]) => {
      if (args[0] === "new-session") {
        // Read it here: the file is deleted as soon as the launch finishes,
        // because it holds the user's entire environment.
        const match = /^\. '([^']+)'/.exec(args.at(-1) as string);
        envPath = match?.[1] ?? "";
        exported = envPath ? fs.readFileSync(envPath, "utf8") : "";
      }
      return tmux.run(command, args);
    });

    await launch({
      ...base,
      // No TMUX here — its presence would select the split path instead.
      env: { PATH: "/opt/mine:/usr/bin", ANTHROPIC_API_KEY: "fresh", TMUX_PANE: "%9" },
      isTty: true,
      run: capture as never,
    });

    expect(exported).toContain("export PATH='/opt/mine:/usr/bin'");
    expect(exported).toContain("export ANTHROPIC_API_KEY='fresh'");
    // tmux sets these per pane; carrying ours across would lie about where we are.
    expect(exported).not.toContain("TMUX_PANE=");
    // And it does not outlive the launch: it is a copy of the environment.
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it("kills the session when the agent finishes, so the pane cannot hold the terminal", async () => {
    const tmux = fakeTmux();
    await launch({ ...base, env: {}, isTty: true, run: tmux.run });
    const script = tmux.of("new-session")[0]?.at(-1) as string;
    expect(script).toContain("kill-session");
    expect(script).toContain("$?"); // and records the agent's exit code
  });

  it("runs the agent bare when the session cannot be created at all", async () => {
    // Otherwise the user gets tmux's raw error and no agent whatsoever.
    const tmux = fakeTmux({ "new-session": [1, 1] });
    const result = await launch({ ...base, agent: ["false"], env: {}, isTty: true, run: tmux.run });
    expect(result.plan.reason).toContain("was not opened");
    expect(result.code).toBe(1); // the agent still ran, and its code came back
  });
});

describe("what the agent inherits and when it is started", () => {
  it("will not build a session without a terminal to attach to", async () => {
    // Attaching needs a tty. Discovering that afterwards would mean the agent
    // had already started inside a session we then have to tear down.
    const tmux = fakeTmux();
    const plan = planLaunch({}, tmux.run, false);
    expect(plan.kind).toBe("none");
    expect(plan.reason).toContain("not running in a terminal");

    const result = await launch({ ...base, agent: ["true"], env: {}, isTty: false, run: tmux.run });
    expect(tmux.of("new-session")).toHaveLength(0);
    expect(result.code).toBe(0);
  });

  it("does not start the agent a second time when attaching fails", async () => {
    // By then tmux has already run it; running it again is two Claude Codes in
    // one directory.
    const tmux = fakeTmux({ attach: [1] });
    const result = await launch({
      ...base, agent: ["definitely-not-a-real-binary-xyz"], env: {}, isTty: true, run: tmux.run,
    });
    expect(tmux.of("new-session")).toHaveLength(1);
    // 127 would mean we spawned it ourselves; we must not have.
    expect(result.code).not.toBe(127);
    // And the session is torn down rather than left running detached.
    expect(tmux.of("kill-session")).toHaveLength(1);
    expect(result.plan.reason).toContain("attach");
  });

  it("does start the agent itself when the session never came up", async () => {
    const tmux = fakeTmux({ "new-session": [1] });
    const result = await launch({ ...base, agent: ["false"], env: {}, isTty: true, run: tmux.run });
    expect(result.code).toBe(1); // ran bare, code propagated
    expect(result.plan.reason).toContain("was not opened");
  });

  it("runs the agent through sh, not the user's login shell", async () => {
    // tmux would otherwise hand the string to `default-shell`, and `$?` is a
    // parse error in fish and csh.
    const tmux = fakeTmux();
    await launch({ ...base, env: {}, isTty: true, run: tmux.run });
    const args = tmux.of("new-session")[0] as string[];
    expect(args).toContain("sh");
    expect(args[args.indexOf("sh") + 1]).toBe("-c");
  });

  it("says so when the pane cannot be opened outside tmux", async () => {
    // The inside-tmux path warns; this one used to stay silent.
    const tmux = fakeTmux({ "split-window": [1, 1, 1, 1] });
    const result = await launch({ ...base, env: {}, isTty: true, run: tmux.run });
    expect(result.plan.reason).toContain("could not split");
  });

  it("gives each session a name that cannot collide with a stale one", async () => {
    const first = fakeTmux();
    const second = fakeTmux();
    await launch({ ...base, env: {}, isTty: true, run: first.run });
    await new Promise((r) => setTimeout(r, 2));
    await launch({ ...base, env: {}, isTty: true, run: second.run });
    const nameOf = (t: typeof first) =>
      (t.of("new-session")[0] as string[])[(t.of("new-session")[0] as string[]).indexOf("-s") + 1];
    expect(nameOf(first)).not.toBe(nameOf(second));
  });
});
