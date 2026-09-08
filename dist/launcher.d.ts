import { type SpawnSyncReturns } from "node:child_process";
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
    /** Injected for tests; every short tmux call goes through this. */
    run?: Runner;
    /**
     * Attach to a session and resolve when it ends.
     *
     * Separate from `run` because it must NOT block: a synchronous attach freezes
     * the event loop, so a SIGHUP from a closing terminal is queued and never
     * handled, leaving the session detached and the agent orphaned.
     */
    attach?: (session: string) => Promise<number>;
}
export declare function planLaunch(env?: NodeJS.ProcessEnv, run?: Runner, isTty?: boolean): LaunchPlan;
/** Quote one argument for a tmux shell command string. */
export declare function shellQuote(value: string): string;
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
export declare function splitCommand(options: LaunchOptions, split?: SplitOptions): string[];
export interface LaunchResult {
    plan: LaunchPlan;
    /** Exit code of the agent process. */
    code: number;
}
export declare function launch(options: LaunchOptions): Promise<LaunchResult>;
/**
 * Open the quiz pane beside the current tmux pane and return.
 *
 * Used by the SessionStart hook, which has no agent to run — Claude Code is
 * already running, and it is what started us.
 */
export declare function openPaneBeside(options: {
    pane: string[];
    passEnv?: Record<string, string>;
    paneWidthPercent?: number;
    run?: Runner;
}): boolean;
export {};
