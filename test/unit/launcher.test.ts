import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { launch, planLaunch, sessionCommand, shellQuote, splitCommand } from "../../src/launcher.js";

const base = { agent: ["claude", "--model", "opus"], pane: ["/usr/bin/node", "/opt/cli.js", "--lang", "es"] };

describe("choosing how to open the pane", () => {
  it("splits the current window when already inside tmux", () => {
    expect(planLaunch({ TMUX: "/tmp/tmux-1000/default,123,0" }).kind).toBe("tmux-split");
  });

  it("starts a session when outside tmux", () => {
    expect(planLaunch({}).kind).toBe("tmux-session");
  });
});

describe("the tmux commands", () => {
  it("uses the modern percentage form by default", () => {
    const args = splitCommand(base);
    expect(args.slice(0, 4)).toEqual(["split-window", "-h", "-l", "40%"]);
    expect(args).toContain("-d"); // focus stays on the agent
  });

  it("falls back to the pre-3.1 sizing flag", () => {
    // tmux 3.4 rejects `-p` with "size missing"; older tmux rejects `-l 40%`.
    expect(splitCommand(base, true).slice(0, 4)).toEqual(["split-window", "-h", "-p", "40"]);
  });

  it("passes the environment the pane needs across", () => {
    // A new tmux pane inherits the SERVER's environment, not this shell's.
    const args = splitCommand({ ...base, passEnv: { CLAUDELINGO_HOME: "/tmp/h" } });
    expect(args).toContain("-e");
    expect(args).toContain("CLAUDELINGO_HOME=/tmp/h");
  });

  it("quotes every argument of the pane command", () => {
    const args = splitCommand({ ...base, pane: ["/usr/bin/node", "/opt/my cli.js", "--lang", "es"] });
    expect(args.at(-1)).toBe("'/usr/bin/node' '/opt/my cli.js' '--lang' 'es'");
  });

  it("quotes a path a shell would otherwise mangle", () => {
    // Verified by running it through a real shell rather than by asserting on the
    // escaping by eye — that is how the wrong form gets written down twice.
    for (const raw of ["/tmp/it's here", "/tmp/a b", '/tmp/"q"', "/tmp/$HOME", "/tmp/a;b"]) {
      const printed = execFileSync("sh", ["-c", `printf %s ${shellQuote(raw)}`], {
        encoding: "utf8",
      });
      expect(printed).toBe(raw);
    }
  });

  it("builds a session that holds both the agent and the pane", () => {
    const args = sessionCommand(base);
    expect(args[0]).toBe("new-session");
    const script = args.at(-1) as string;
    expect(script).toContain("split-window");
    expect(script).toContain("'claude' '--model' 'opus'");
    // The pane is created first, then the agent runs in the original pane.
    expect(script.indexOf("split-window")).toBeLessThan(script.indexOf("'claude'"));
  });
});

describe("launching", () => {
  it("retries the legacy sizing when the modern form is rejected", async () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      // First form rejected, as tmux 3.4 does for `-p` and tmux 2.x for `-l %`.
      return { status: calls.length === 1 ? 1 : 0 } as never;
    });
    const result = await launch({
      ...base,
      agent: ["true"],
      env: { TMUX: "x" },
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[0]).toContain("-l");
    expect(calls[1]).toContain("-p");
    expect(result.plan.reason).toBeUndefined();
  });

  it("still starts the agent when the split fails outright", async () => {
    const run = vi.fn(() => ({ status: 1 }) as never);
    const result = await launch({ ...base, agent: ["true"], env: { TMUX: "x" }, run });
    // The pane is the extra; losing it must not cost the user their agent.
    expect(result.plan.reason).toContain("could not split");
    expect(result.code).toBe(0);
  });

  it("reports the agent's exit code", async () => {
    const run = vi.fn(() => ({ status: 0 }) as never);
    const result = await launch({ ...base, agent: ["false"], env: { TMUX: "x" }, run });
    expect(result.code).toBe(1);
  });

  it("reports a missing agent binary rather than hanging", async () => {
    const run = vi.fn(() => ({ status: 0 }) as never);
    const result = await launch({
      ...base,
      agent: ["definitely-not-a-real-binary-xyz"],
      env: { TMUX: "x" },
      run,
    });
    expect(result.code).toBe(127);
  });
});
