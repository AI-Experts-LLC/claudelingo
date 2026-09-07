import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentState } from "../types.js";

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function codexConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

export function codexSessionsDir(): string {
  return path.join(codexHome(), "sessions");
}

const NOTIFY_LINE = (bin: string) => `notify = ["${bin}", "notify"]`;

/**
 * Point Codex's `notify` program at us.
 *
 * Codex only notifies on turn completion, so this half of the integration supplies
 * the idle edge; `SessionWatcher` below supplies the busy edge.
 */
export function withNotify(toml: string, bin: string): string {
  const line = NOTIFY_LINE(bin);
  const lines = toml.split("\n");

  // `notify` is a top-level key, so it has to land before the first [table] header.
  let firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstTable === -1) firstTable = lines.length;

  const existing = lines.findIndex((l) => /^\s*notify\s*=/.test(l));
  if (existing !== -1) {
    if ((lines[existing] as string).includes(`"${bin}"`)) return toml;
    lines[existing] = line;
    return lines.join("\n");
  }

  lines.splice(firstTable, 0, line, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function removeNotify(toml: string, bin: string): string {
  return toml
    .split("\n")
    .filter((l) => !(/^\s*notify\s*=/.test(l) && l.includes(`"${bin}"`)))
    .join("\n");
}

export function installNotify(bin: string, file = codexConfigPath()): void {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, withNotify(current, bin), "utf8");
}

export function uninstallNotify(bin: string, file = codexConfigPath()): void {
  if (!fs.existsSync(file)) return;
  fs.writeFileSync(file, removeNotify(fs.readFileSync(file, "utf8"), bin), "utf8");
}

/**
 * Classify one line of a Codex rollout transcript.
 *
 * The rollout format has shifted between Codex releases, so this matches on a few
 * tolerant markers rather than one exact schema, and returns null for anything it
 * does not recognise.
 */
export function classifyRolloutLine(line: string): AgentState | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const payload = (entry.payload ?? entry) as Record<string, unknown>;
  const type = String(payload.type ?? entry.type ?? "");

  if (type === "task_started" || type === "turn_started" || type === "user_message") return "busy";
  if (type === "message" && payload.role === "user") return "busy";
  if (type === "task_complete" || type === "turn_complete" || type === "agent-turn-complete") {
    return "idle";
  }
  if (type === "token_count" || type === "shutdown_complete") return null;
  return null;
}

/** Payload Codex hands to the `notify` program. */
export function classifyNotification(json: string): AgentState | null {
  try {
    const payload = JSON.parse(json) as { type?: string };
    if (payload.type === "agent-turn-complete") return "idle";
    return null;
  } catch {
    return null;
  }
}

function newestRollout(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  let best: { file: string; mtime: number } | null = null;
  const walk = (current: string, depth: number) => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (!best || mtime > best.mtime) best = { file: full, mtime };
        } catch {
          // File vanished between readdir and stat; ignore.
        }
      }
    }
  };
  walk(dir, 0);
  return best ? (best as { file: string }).file : null;
}

export interface SessionWatcher {
  stop(): void;
}

/**
 * Follow the newest Codex rollout transcript and report busy/idle transitions.
 *
 * Codex has no "turn started" hook, so the transcript is the only signal available
 * for the busy edge. Only bytes appended after the watcher starts are read, so an
 * old session on disk can never trigger a spurious quiz.
 */
export function watchCodexSession(
  onState: (state: AgentState) => void,
  options: { dir?: string; intervalMs?: number } = {},
): SessionWatcher {
  const dir = options.dir ?? codexSessionsDir();
  const intervalMs = options.intervalMs ?? 500;
  let file: string | null = null;
  let offset = 0;
  let carry = "";

  const poll = () => {
    const newest = newestRollout(dir);
    if (!newest) return;
    if (newest !== file) {
      file = newest;
      carry = "";
      // Start at the end of a pre-existing file; a brand-new one is read in full.
      try {
        offset = fs.statSync(newest).size;
      } catch {
        offset = 0;
      }
      return;
    }

    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // truncated or rotated
    if (size === offset) return;

    let chunk = "";
    try {
      const fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      fs.closeSync(fd);
      chunk = buffer.toString("utf8");
    } catch {
      return;
    }
    offset = size;

    const lines = (carry + chunk).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const state = classifyRolloutLine(line);
      if (state) onState(state);
    }
  };

  const timer = setInterval(poll, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  poll();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
