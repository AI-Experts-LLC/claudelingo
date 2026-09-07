import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";

/**
 * Launch Claude Code with the quiz pane beside it.
 *
 * Claude Code draws its own terminal UI and does not host third-party widgets, so
 * an interactive pane has to be a separate process in a separate pane. What this
 * removes is the chore of arranging that by hand: one command, both panes.
 */

export interface LaunchPlan {
  /** How the pane will be opened, or why it will not be. */
  kind: "tmux-split" | "tmux-session" | "none";
  reason?: string;
}

function hasTmux(): boolean {
  const probe = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return probe.status === 0;
}

export function planLaunch(env: NodeJS.ProcessEnv = process.env): LaunchPlan {
  if (!hasTmux()) {
    return {
      kind: "none",
      reason: "tmux is not installed, so the pane cannot be opened automatically",
    };
  }
  // Already inside tmux: split the window we are in, which keeps the user's
  // existing session and layout.
  if (env.TMUX) return { kind: "tmux-split" };
  return { kind: "tmux-session" };
}

/** Quote one argument for a tmux shell command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
  /** Fraction of the window the pane takes. */
  paneWidthPercent?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  run?: (command: string, args: string[]) => SpawnSyncReturns<Buffer>;
}

/**
 * Build the tmux command that opens the pane beside the current one.
 *
 * tmux 3.1 replaced `-p <percent>` with `-l <percent>%`, and 3.4 removed the old
 * form outright — it fails with "size missing". The modern form is tried first and
 * the legacy one is the fallback, so both eras of tmux work.
 */
export function splitCommand(options: LaunchOptions, legacy = false): string[] {
  const percent = options.paneWidthPercent ?? 40;
  const size = legacy ? ["-p", String(percent)] : ["-l", `${percent}%`];
  const env = Object.entries(options.passEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return [
    "split-window",
    "-h",
    ...size,
    ...env,
    "-d", // stay focused on the agent; the pane is for glancing at
    options.pane.map(shellQuote).join(" "),
  ];
}

/** Build the tmux command that creates a fresh session holding both. */
export function sessionCommand(options: LaunchOptions, legacy = false): string[] {
  const percent = options.paneWidthPercent ?? 40;
  const size = legacy ? `-p ${percent}` : `-l ${percent}%`;
  const agent = options.agent.map(shellQuote).join(" ");
  const pane = options.pane.map(shellQuote).join(" ");
  const env = Object.entries(options.passEnv ?? {})
    .map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`)
    .join(" ");
  // The pane is split off from inside the new session, once it exists.
  return [
    "new-session",
    "-s",
    `claudelingo-${process.pid}`,
    `tmux split-window -h ${size} ${env} -d ${shellQuote(pane)} ; ${agent}`,
  ];
}

export interface LaunchResult {
  plan: LaunchPlan;
  /** Exit code of the agent process. */
  code: number;
}

/**
 * Open the pane, then run the agent in the foreground.
 *
 * The agent keeps this terminal: it is the thing being typed into, and its exit
 * is what ends the session.
 */
export async function launch(options: LaunchOptions): Promise<LaunchResult> {
  const env = options.env ?? process.env;
  const run = options.run ?? ((command, args) => spawnSync(command, args, { stdio: "ignore" }));
  const plan = planLaunch(env);

  if (plan.kind === "tmux-session") {
    // Not inside tmux: hand the whole thing to a new tmux session, which then
    // owns both panes. This call blocks until the session ends.
    const result = spawnSync("tmux", sessionCommand(options), { stdio: "inherit" });
    if (result.status !== 0) {
      const legacy = spawnSync("tmux", sessionCommand(options, true), { stdio: "inherit" });
      return { plan, code: legacy.status ?? 0 };
    }
    return { plan, code: result.status ?? 0 };
  }

  if (plan.kind === "tmux-split") {
    let result = run("tmux", splitCommand(options));
    // `-l <percent>%` needs tmux 3.1+, and `-e` needs 3.0+; retry the old sizing,
    // then without the env pass-through, before giving up on the pane.
    if (result.status !== 0) result = run("tmux", splitCommand(options, true));
    if (result.status !== 0) {
      const bare = { ...options };
      delete bare.passEnv;
      result = run("tmux", splitCommand(bare));
      if (result.status !== 0) result = run("tmux", splitCommand(bare, true));
    }
    if (result.status !== 0) {
      // A failure here must not stop the agent starting; the pane is the extra.
      plan.reason = "tmux could not split the window, so the pane was not opened";
    }
  }

  const [command, ...args] = options.agent;
  if (!command) return { plan, code: 0 };

  const code = await new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...env } });
    child.on("error", () => resolve(127));
    child.on("close", (status) => resolve(status ?? 0));
  });
  return { plan, code };
}
