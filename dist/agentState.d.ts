import type { AgentState, AgentStatus } from "./types.js";
export declare function stateForEvent(event: string): AgentState | null;
export type StatusRead = {
    ok: true;
    status: AgentStatus;
}
/** No status file yet — the hooks have simply not fired. Normal. */
 | {
    ok: false;
    reason: "missing";
}
/** A file exists but is unusable. NOT normal: the pane is now blind. */
 | {
    ok: false;
    reason: "unreadable";
    detail: string;
};
/**
 * Read the agent's state, keeping "the hooks have not fired yet" apart from "I
 * cannot read this file".
 *
 * Collapsing the two would make a corrupt status file look exactly like an idle
 * agent, and the pane would sit on "Standing by" forever while Claude worked.
 */
export declare function readStatusResult(file?: string): StatusRead;
export declare function readStatus(file?: string): AgentStatus | null;
export declare function writeStatus(status: AgentStatus, file?: string): void;
/**
 * The effective state, after ageing out a stale `busy`.
 *
 * If a Claude Code session is killed mid-turn its `Stop` hook never fires, so a naive
 * reader would quiz forever. Treat a `busy` older than `staleMs` as idle.
 */
export declare function effectiveState(status: AgentStatus | null, now: number, staleMs: number): AgentState;
export interface StatusWatcher {
    stop(): void;
}
/**
 * Watch the status file for changes.
 *
 * The poll is the load-bearing mechanism, not a fallback. Status is written with a
 * temp file and a rename, which replaces the inode, so an `fs.watch` handle stops
 * delivering events after the first write. The watch is still attached because it
 * makes the very first transition feel instant, but correctness rests on the poll.
 *
 * The callback is deduped on content, so a rewrite with identical values is quiet.
 */
export declare function watchStatus(onChange: (status: AgentStatus | null) => void, options?: {
    file?: string;
    intervalMs?: number;
    /** Called with a message when the status file becomes unreadable, null when it recovers. */
    onError?: (message: string | null) => void;
}): StatusWatcher;
