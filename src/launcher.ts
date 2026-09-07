import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Launch Claude Code with the quiz pane beside it.
 *
 * Claude Code draws its own terminal UI and does not host third-party widgets, so
 * an interactive pane has to be a separate process in a separate pane. What this
 * removes is the chore of arranging that by hand.
 *
 * Two rules shape everything below. The agent is started **exactly once** — no
 * retry path may contain it, or a failure produces two Claude Code instances in
 * the same working directory. And the agent's fate is the session's: it owns the
 * terminal, its exit code is the command's exit code, and its interrupts are its
 * own.
 */

export interface LaunchPlan {
  kind: "tmux-split" | "tmux-session" | "none";
  reason?: string;
}

type Runner = (command: string, args: string[]) => SpawnSyncReturns<string>;

/**
 * Every tmux call goes through this, including the foreground `attach`, so a test
 * can drive the whole flow without a tmux server — the branch that could not be
 * injected is the branch whose defects shipped green.
 */
const defaultRun: Runner = (command, args) =>
  spawnSync(command, args, {
    encoding: "utf8",
    // `attach` owns the terminal; the others are quiet queries.
    stdio: args[0] === "attach" ? "inherit" : ["ignore", "pipe", "pipe"],
  }) as SpawnSyncReturns<string>;

export interface LaunchOptions {
  /** Argv for the agent command, e.g. ["claude", "--model", "opus"]. */
  agent: string[];
  /** Argv for the pane. Absolute, so it does not depend on the new pane's PATH. */
  pane: string[];
  /**
   * Variables the pane needs that tmux would not otherwise give it.
   *
   * A new tmux pane inherits the tmux *server's* environment, not the environment
   * of the pane that spawned it, so anything set in this shell — a custom
   * CLAUDELINGO_HOME above all — has to be passed across explicitly.
   */
  passEnv?: Record<string, string>;
  paneWidthPercent?: number;
  env?: NodeJS.ProcessEnv;
  /** Whether this process owns a terminal. Injected for tests. */
  isTty?: boolean;
  /** Injected for tests; every tmux call goes through this. */
  run?: Runner;
}

export function planLaunch(
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = defaultRun,
  isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY),
): LaunchPlan {
  if (run("tmux", ["-V"]).status !== 0) {
    return {
      kind: "none",
      reason: "tmux is not installed, so the pane cannot be opened automatically",
    };
  }
  // Already inside tmux: split the window we are in, keeping the user's layout.
  if (env.TMUX) return { kind: "tmux-split" };
  // Building a session means attaching to it, and attaching needs a terminal.
  // Finding that out afterwards would mean the agent had already started inside
  // a session we then have to tear down.
  if (!isTty) {
    return {
      kind: "none",
      reason: "not running in a terminal, so tmux cannot open a pane",
    };
  }
  return { kind: "tmux-session" };
}

/** Quote one argument for a tmux shell command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface SplitOptions {
  target?: string;
  legacy?: boolean;
}

/**
 * The tmux command that opens the pane.
 *
 * It starts the pane and nothing else, which is what makes it safe to retry:
 * tmux 3.1 replaced `-p <percent>` with `-l <percent>%` and 3.4 removed the old
 * form ("size missing"), and `-e` needs 3.0, so several forms may be attempted.
 */
export function splitCommand(options: LaunchOptions, split: SplitOptions = {}): string[] {
  const percent = options.paneWidthPercent ?? 40;
  const size = split.legacy ? ["-p", String(percent)] : ["-l", `${percent}%`];
  const env = Object.entries(options.passEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return [
    "split-window",
    "-h",
    ...size,
    ...env,
    ...(split.target ? ["-t", split.target] : []),
    "-d", // focus stays on the agent; the pane is for glancing at
    "-P",
    "-F",
    "#{pane_id}",
    options.pane.map(shellQuote).join(" "),
  ];
}

/** Try the pane command in each supported tmux dialect. Returns its pane id. */
function openPane(options: LaunchOptions, run: Runner, target?: string): string | null {
  const attempts: SplitOptions[] = [
    { ...(target ? { target } : {}) },
    { ...(target ? { target } : {}), legacy: true },
  ];
  for (const attempt of attempts) {
    const result = run("tmux", splitCommand(options, attempt));
    if (result.status === 0) return (result.stdout ?? "").trim() || "";
  }
  // `-e` needs tmux 3.0; drop it and try once more before giving up on the pane.
  if (options.passEnv) {
    const bare: LaunchOptions = { ...options };
    delete bare.passEnv;
    for (const attempt of attempts) {
      const result = run("tmux", splitCommand(bare, attempt));
      if (result.status === 0) return (result.stdout ?? "").trim() || "";
    }
  }
  return null;
}

export interface LaunchResult {
  plan: LaunchPlan;
  /** Exit code of the agent process. */
  code: number;
}

/** Run the agent in this terminal and wait for it. */
function runAgent(agent: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...args] = agent;
  if (!command) return Promise.resolve(0);

  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...env } });

    // Ctrl-C belongs to the agent: in Claude Code it interrupts the turn rather
    // than quitting. The terminal delivers SIGINT to the whole foreground group,
    // so without a listener this wrapper dies and orphans the agent — the shell
    // prompt returns while Claude Code still owns the tty.
    const hold = () => {};
    process.on("SIGINT", hold);
    const forward = (signal: NodeJS.Signals) => () => {
      if (!child.killed) child.kill(signal);
    };
    const onTerm = forward("SIGTERM");
    const onHup = forward("SIGHUP");
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);

    const finish = (code: number) => {
      process.off("SIGINT", hold);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
      resolve(code);
    };
    child.on("error", () => finish(127));
    child.on("close", (status, signal) => finish(status ?? (signal ? 130 : 0)));
  });
}

/**
 * Write the caller's environment as a sourceable script.
 *
 * A process started inside tmux inherits the tmux *server's* environment, which
 * on any machine where tmux is already running is whatever it was when that
 * server started. That is not a cosmetic difference: if `claude` is on the user's
 * PATH but not the old server's, the agent silently never starts. Forwarding via
 * `-e` per variable would need one flag each and hit argv limits, so the
 * environment is written out and sourced instead.
 */
function writeEnvScript(dir: string, env: NodeJS.ProcessEnv): string {
  const file = path.join(dir, "env.sh");
  const lines = Object.entries(env)
    // tmux sets these for the pane it is in; carrying ours across would lie.
    .filter(([key]) => key !== "TMUX" && key !== "TMUX_PANE")
    // Anything not a plain shell identifier cannot be exported portably.
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value ?? "")}`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

/**
 * The session could not be used.
 *
 * `agentStarted` is the important part: once tmux has run the agent, falling back
 * to running it again would put two Claude Code instances in the same directory —
 * so a failure after that point is reported, never retried.
 */
class SessionUnavailable extends Error {
  constructor(
    message: string,
    readonly agentStarted: boolean,
    readonly code = 1,
  ) {
    super(message);
  }
}

/**
 * Outside tmux: build the session around the agent.
 *
 * The agent goes in first, detached, so the pane can be split off beside it and
 * retried freely without ever re-running the agent. Its exit code is written to a
 * file and the session is killed the moment it finishes, so the pane cannot keep
 * the terminal hostage after Claude Code is done.
 */
async function launchSession(
  options: LaunchOptions,
  run: Runner,
  env: NodeJS.ProcessEnv,
  plan: LaunchPlan,
): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudelingo-launch-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

  try {
    const rcFile = path.join(dir, "agent.rc");
    const envFile = writeEnvScript(dir, env);
    // A pid alone collides after a crash, and a stale session of the same name
    // would make every later launch fall back to the bare agent.
    const session = `claudelingo-${process.pid}-${Date.now().toString(36)}`;
    const agent = options.agent.map(shellQuote).join(" ");
    const script =
      `. ${shellQuote(envFile)}; ${agent}; printf %s $? > ${shellQuote(rcFile)}; ` +
      `tmux kill-session -t ${shellQuote(session)}`;

    // `sh -c` explicitly: tmux would otherwise hand the string to the user's
    // default shell, and `$?` is a parse error in fish and csh.
    const created = run("tmux", ["new-session", "-d", "-s", session, "sh", "-c", script]);
    if (created.status !== 0) {
      // Nothing ran: safe for the caller to start the agent itself.
      throw new SessionUnavailable(
        (created.stderr || "tmux could not create a session").trim(),
        false,
      );
    }

    if (openPane(options, run, session) === null) {
      plan.reason = "tmux could not split the window, so the pane was not opened";
    }

    // Attach in the foreground; this returns when the session ends, which the
    // agent's own exit brings about.
    const attached = run("tmux", ["attach", "-t", session]);
    if (attached.status !== 0) {
      // The session exists, so the agent is already running inside it. Take it
      // down rather than orphaning it — but do NOT start it again.
      run("tmux", ["kill-session", "-t", session]);
      let code = 1;
      try {
        code = Number(fs.readFileSync(rcFile, "utf8").trim());
      } catch {
        // It never got far enough to record anything.
      }
      throw new SessionUnavailable(
        (attached.stderr || "tmux could not attach to the session").trim(),
        true,
        code,
      );
    }

    try {
      return Number(fs.readFileSync(rcFile, "utf8").trim());
    } catch {
      // The session ended without the agent recording anything — killed from
      // outside, or the server died. Reporting success would be a lie.
      return 130;
    }
  } finally {
    cleanup();
  }
}

export async function launch(options: LaunchOptions): Promise<LaunchResult> {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const plan = planLaunch(env, run, options.isTty ?? Boolean(process.stdout.isTTY && process.stdin.isTTY));

  if (plan.kind === "tmux-session") {
    try {
      return { plan, code: await launchSession(options, run, env, plan) };
    } catch (error) {
      const failure = error as SessionUnavailable;
      plan.reason = `${failure.message}; the pane was not opened`;
      // Only start the agent here if tmux never did. Losing the pane must not
      // cost the user their agent — and must not hand them two of them.
      if (failure.agentStarted) return { plan, code: failure.code ?? 1 };
      return { plan, code: await runAgent(options.agent, env) };
    }
  }

  let pane: string | null = null;
  if (plan.kind === "tmux-split") {
    pane = openPane(options, run);
    if (pane === null) {
      plan.reason = "tmux could not split the window, so the pane was not opened";
    }
  }

  const code = await runAgent(options.agent, env);

  // Take the pane away with the agent; three runs should not leave three panes.
  if (pane) run("tmux", ["kill-pane", "-t", pane]);
  return { plan, code };
}
