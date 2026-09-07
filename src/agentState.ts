import fs from "node:fs";
import { paths, readJson, writeJsonAtomic } from "./config.js";
import type { AgentState, AgentStatus } from "./types.js";

/**
 * Hook and event names that mean "the agent is now working, go ahead and quiz".
 *
 * `Notification` is deliberately on the idle side: Claude Code fires it when it needs
 * a permission decision, which is exactly when the human should be looking at Claude
 * rather than at a vocabulary card.
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
  "SubagentStop",
  "SessionEnd",
  "Notification",
  "agent-turn-complete",
  "turn_complete",
  "idle",
]);

export function stateForEvent(event: string): AgentState | null {
  if (BUSY_EVENTS.has(event)) return "busy";
  if (IDLE_EVENTS.has(event)) return "idle";
  return null;
}

export function readStatus(file = paths.status()): AgentStatus | null {
  const raw = readJson<Partial<AgentStatus>>(file);
  if (!raw || (raw.state !== "busy" && raw.state !== "idle")) return null;
  return {
    state: raw.state,
    source: raw.source === "claude" || raw.source === "codex" ? raw.source : "manual",
    event: typeof raw.event === "string" ? raw.event : "unknown",
    ts: typeof raw.ts === "number" ? raw.ts : 0,
  };
}

export function writeStatus(status: AgentStatus, file = paths.status()): void {
  writeJsonAtomic(file, status);
}

/**
 * The effective state, after ageing out a stale `busy`.
 *
 * If a Claude Code session is killed mid-turn its `Stop` hook never fires, so a naive
 * reader would quiz forever. Treat a `busy` older than `staleMs` as idle.
 */
export function effectiveState(
  status: AgentStatus | null,
  now: number,
  staleMs: number,
): AgentState {
  if (!status) return "idle";
  if (status.state === "busy" && now - status.ts > staleMs) return "idle";
  return status.state;
}

export interface StatusWatcher {
  stop(): void;
}

/**
 * Watch the status file for changes.
 *
 * `fs.watch` is the fast path but is unreliable across platforms and editors, so a
 * modest poll runs alongside it and the callback is deduped on content.
 */
export function watchStatus(
  onChange: (status: AgentStatus | null) => void,
  options: { file?: string; intervalMs?: number } = {},
): StatusWatcher {
  const file = options.file ?? paths.status();
  const intervalMs = options.intervalMs ?? 250;
  let last = "";

  const check = () => {
    const status = readStatus(file);
    const key = status ? `${status.state}:${status.ts}:${status.event}` : "";
    if (key === last) return;
    last = key;
    onChange(status);
  };

  const timer = setInterval(check, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(file, { persistent: false }, check);
  } catch {
    // File may not exist yet; the poll will pick it up.
  }

  check();
  return {
    stop() {
      clearInterval(timer);
      watcher?.close();
    },
  };
}
