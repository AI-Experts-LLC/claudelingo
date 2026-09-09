import fs from "node:fs";
import { paths, readJsonFile, writeJsonAtomic } from "./config.js";
/**
 * Hook and event names that mean "the agent is now working, go ahead and quiz".
 *
 * `Notification` is deliberately on the idle side: Claude Code fires it when it needs
 * a permission decision, which is exactly when the human should be looking at Claude
 * rather than at a vocabulary card.
 *
 * `SubagentStop` is deliberately on *neither*. A subagent finishing says nothing
 * about the turn that spawned it — the parent is usually still working, and often
 * for a long time yet. Treating it as idle stopped the drill during exactly the
 * waits worth filling: a session that farms work out to subagents would go quiet
 * the moment the first one came back.
 */
const BUSY_EVENTS = new Set([
    "UserPromptSubmit",
    "PreToolUse",
    "PreCompact",
    "task_started",
    "turn_started",
    "user_message",
    "busy",
]);
const IDLE_EVENTS = new Set([
    "Stop",
    "SessionEnd",
    "Notification",
    "agent-turn-complete",
    "turn_complete",
    "idle",
]);
export function stateForEvent(event) {
    if (BUSY_EVENTS.has(event))
        return "busy";
    if (IDLE_EVENTS.has(event))
        return "idle";
    return null;
}
/**
 * Read the agent's state, keeping "the hooks have not fired yet" apart from "I
 * cannot read this file".
 *
 * Collapsing the two would make a corrupt status file look exactly like an idle
 * agent, and the pane would sit on "Standing by" forever while Claude worked.
 */
export function readStatusResult(file = paths.status()) {
    const raw = readJsonFile(file);
    if (!raw.ok) {
        if (raw.reason === "missing")
            return { ok: false, reason: "missing" };
        return { ok: false, reason: "unreadable", detail: raw.error?.message ?? "unknown error" };
    }
    const value = raw.value;
    if (!value || (value.state !== "busy" && value.state !== "idle")) {
        return { ok: false, reason: "unreadable", detail: "no recognisable agent state" };
    }
    return {
        ok: true,
        status: {
            state: value.state,
            source: value.source === "claude" || value.source === "codex" ? value.source : "manual",
            event: typeof value.event === "string" ? value.event : "unknown",
            ts: typeof value.ts === "number" ? value.ts : 0,
        },
    };
}
export function readStatus(file = paths.status()) {
    const result = readStatusResult(file);
    return result.ok ? result.status : null;
}
export function writeStatus(status, file = paths.status()) {
    writeJsonAtomic(file, status);
}
/**
 * The effective state, after ageing out a stale `busy`.
 *
 * If a Claude Code session is killed mid-turn its `Stop` hook never fires, so a naive
 * reader would quiz forever. Treat a `busy` older than `staleMs` as idle.
 */
export function effectiveState(status, now, staleMs) {
    if (!status)
        return "idle";
    if (status.state === "busy" && now - status.ts > staleMs)
        return "idle";
    return status.state;
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
export function watchStatus(onChange, options = {}) {
    const file = options.file ?? paths.status();
    const intervalMs = options.intervalMs ?? 250;
    let last = "";
    let reportedUnreadable = false;
    const check = () => {
        const result = readStatusResult(file);
        // An unreadable status file leaves the pane blind, so it has to be said. A
        // missing one is just "no hook has fired yet" and is silent.
        if (!result.ok && result.reason === "unreadable") {
            if (!reportedUnreadable) {
                reportedUnreadable = true;
                options.onError?.(`cannot read ${file} (${result.detail}) — the pane cannot see the agent`);
            }
        }
        else if (reportedUnreadable) {
            reportedUnreadable = false;
            options.onError?.(null);
        }
        const status = result.ok ? result.status : null;
        const key = status ? `${status.state}:${status.ts}:${status.event}` : "";
        if (key === last)
            return;
        last = key;
        onChange(status);
    };
    const timer = setInterval(check, intervalMs);
    if (typeof timer.unref === "function")
        timer.unref();
    let watcher = null;
    try {
        watcher = fs.watch(file, { persistent: false }, check);
        // An `error` event with no listener is thrown, which would take the pane down.
        // Losing the watch is survivable; the poll carries on regardless.
        watcher.on("error", () => {
            watcher?.close();
            watcher = null;
        });
    }
    catch {
        // File may not exist yet; the poll will pick it up.
    }
    check();
    return {
        stop() {
            clearInterval(timer);
            try {
                watcher?.close();
            }
            catch {
                // Already closed.
            }
        },
    };
}
//# sourceMappingURL=agentState.js.map