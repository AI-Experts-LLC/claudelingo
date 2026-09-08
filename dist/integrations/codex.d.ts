import type { AgentState } from "../types.js";
export declare function codexHome(): string;
export declare function codexConfigPath(): string;
export declare function codexSessionsDir(): string;
/**
 * Locate the top-level `notify` assignment, including a value spread over several
 * lines, and report whose it is.
 *
 * Only lines above the first table header are considered: a `notify` key inside
 * `[tui]` is a different setting entirely, and rewriting it destroys the user's
 * configuration while leaving ours unwritten.
 */
export declare function findNotify(toml: string, bin: string): {
    start: number;
    end: number;
    ours: boolean;
} | null;
export declare class CodexConfigError extends Error {
}
/**
 * Add our `notify` entry to a Codex config.
 *
 * Codex supports exactly one notify program, so an entry belonging to something
 * else is never overwritten — that would silently disable the user's own tooling.
 * The caller is told instead.
 */
export declare function withNotify(toml: string, bin: string): string;
export declare function removeNotify(toml: string, bin: string): string;
/** Returns the path of the backup taken, when there was an existing config to back up. */
export declare function installNotify(bin: string, file?: string): string | null;
export declare function uninstallNotify(bin: string, file?: string): void;
/**
 * Classify one line of a Codex rollout transcript.
 *
 * The rollout format has shifted between Codex releases, so this matches on a few
 * tolerant markers rather than one exact schema, and returns null for anything it
 * does not recognise.
 */
export declare function classifyRolloutLine(line: string): AgentState | null;
/** Payload Codex hands to the `notify` program. */
export declare function classifyNotification(json: string): AgentState | null;
export interface SessionWatcher {
    stop(): void;
}
export interface WatchOptions {
    dir?: string;
    intervalMs?: number;
    /**
     * Called with a message when the watcher has failed repeatedly and is no longer
     * reliable, and with null once it reads successfully again. Without the null case
     * a recovered watcher leaves a permanent banner claiming it is broken.
     */
    onError?: (message: string | null) => void;
    /**
     * How often to look for a *different* transcript becoming the newest. Following
     * the current one is done on every tick; hunting for new sessions is not, because
     * that is the part whose cost grows with the user's Codex history.
     */
    scanIntervalMs?: number;
}
/**
 * Follow the newest Codex rollout transcript and report busy/idle transitions.
 *
 * Codex has no "turn started" hook, so the transcript is the only signal for the
 * busy edge. Transcripts that already existed when the watcher started are adopted
 * at their end — old history must never trigger a quiz — but a transcript that
 * *appears* afterwards is a new session and is read from the beginning, because
 * Codex writes the session header and the first user turn together and they would
 * otherwise be skipped, losing the busy edge for turn one of every session.
 */
export declare function watchCodexSession(onState: (state: AgentState) => void, options?: WatchOptions): SessionWatcher;
