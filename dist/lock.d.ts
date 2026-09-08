export interface Lock {
    release(): void;
}
export type AcquireResult = {
    ok: true;
    lock: Lock;
}
/** Another live pane holds it. `pid` is null when the lock file is unreadable. */
 | {
    ok: false;
    reason: "held";
    pid: number | null;
}
/** The lock itself could not be created — the single-pane guarantee is off. */
 | {
    ok: false;
    reason: "unavailable";
    error: Error;
};
/**
 * Take an exclusive lock on one language's deck.
 *
 * Two panes on the same language each hold the whole deck in memory and save the
 * whole file, so the second one to answer a card silently erases everything the
 * first learned. One pane per language, enforced by an exclusive create.
 *
 * A lock left behind by a crashed pane is reclaimed; one held by a live process is
 * not. Failure to create the lock at all is reported rather than waved through —
 * quietly dropping the guarantee is how the data loss happens.
 */
export declare function acquire(file: string): AcquireResult;
export declare function holderPid(file: string): number | null;
/**
 * Whether a *live* process holds this lock.
 *
 * `holderPid` reports whatever the file says, which after a crash or a reboot is
 * a pid that no longer exists. Anything deciding "is a pane already running?"
 * needs the liveness check `acquire` does, or it stays permanently convinced.
 */
export declare function isHeld(file: string): boolean;
