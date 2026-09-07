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

/** TOML basic strings need their backslashes and quotes escaped — Windows paths bite. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function notifyLine(bin: string): string {
  return `notify = [${tomlString(bin)}, ${tomlString("notify")}]`;
}

/** Index of the first `[table]` header — a top-level key must live above it. */
function firstTableIndex(lines: string[]): number {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index === -1 ? lines.length : index;
}

/**
 * Locate the top-level `notify` assignment, including a value spread over several
 * lines, and report whose it is.
 *
 * Only lines above the first table header are considered: a `notify` key inside
 * `[tui]` is a different setting entirely, and rewriting it destroys the user's
 * configuration while leaving ours unwritten.
 */
export function findNotify(
  toml: string,
  bin: string,
): { start: number; end: number; ours: boolean } | null {
  const lines = toml.split("\n");
  const limit = firstTableIndex(lines);
  const start = lines.findIndex((line, i) => i < limit && /^\s*notify\s*=/.test(line));
  if (start === -1) return null;

  // Walk forward until the array closes, so a multi-line value is replaced whole
  // rather than beheaded — half a replaced array is invalid TOML.
  let end = start;
  const opens = (s: string) => (s.match(/\[/g) ?? []).length;
  const closes = (s: string) => (s.match(/\]/g) ?? []).length;
  let depth = opens(lines[start] as string) - closes(lines[start] as string);
  while (depth > 0 && end + 1 < lines.length) {
    end += 1;
    depth += opens(lines[end] as string) - closes(lines[end] as string);
  }

  const block = lines.slice(start, end + 1).join("\n");
  return { start, end, ours: block.includes(tomlString(bin)) };
}

export class CodexConfigError extends Error {}

/**
 * Add our `notify` entry to a Codex config.
 *
 * Codex supports exactly one notify program, so an entry belonging to something
 * else is never overwritten — that would silently disable the user's own tooling.
 * The caller is told instead.
 */
export function withNotify(toml: string, bin: string): string {
  const found = findNotify(toml, bin);
  if (found?.ours) return toml;
  if (found) {
    throw new CodexConfigError(
      `${codexConfigPath()} already sets a different notify program on line ${found.start + 1}. ` +
        "Codex allows only one, so claudelingo has left it alone. " +
        "Remove that line and re-run `claudelingo init` to use claudelingo instead.",
    );
  }

  const lines = toml.split("\n");
  lines.splice(firstTableIndex(lines), 0, notifyLine(bin), "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function removeNotify(toml: string, bin: string): string {
  const found = findNotify(toml, bin);
  if (!found?.ours) return toml;
  const lines = toml.split("\n");
  lines.splice(found.start, found.end - found.start + 1);
  return lines.join("\n");
}

function writeTextAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.claudelingo.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Never let a cleanup failure replace the write failure being reported.
    }
    throw error;
  }
}

/** Returns the path of the backup taken, when there was an existing config to back up. */
export function installNotify(bin: string, file = codexConfigPath()): string | null {
  const exists = fs.existsSync(file);
  const current = exists ? fs.readFileSync(file, "utf8") : "";
  const next = withNotify(current, bin);
  if (next === current) return null;

  let backup: string | null = null;
  if (exists) {
    backup = `${file}.claudelingo-backup`;
    fs.copyFileSync(file, backup);
  }
  writeTextAtomic(file, next);
  return backup;
}

export function uninstallNotify(bin: string, file = codexConfigPath()): void {
  if (!fs.existsSync(file)) return;
  const current = fs.readFileSync(file, "utf8");
  const next = removeNotify(current, bin);
  if (next !== current) writeTextAtomic(file, next);
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
  return null;
}

/** Payload Codex hands to the `notify` program. */
export function classifyNotification(json: string): AgentState | null {
  try {
    const payload = JSON.parse(json) as { type?: string };
    return payload.type === "agent-turn-complete" ? "idle" : null;
  } catch {
    return null;
  }
}

interface RolloutScan {
  files: Array<{ file: string; mtime: number; size: number }>;
  /** Set when any directory under the sessions root could not be listed. */
  error: Error | null;
}

/**
 * Every rollout transcript under `dir`, newest last.
 *
 * A failure to read ANY directory is reported rather than swallowed: an unreadable
 * folder silently kills the only signal that a Codex turn started, and the pane
 * would simply never wake up again.
 */
function scanRollouts(dir: string): RolloutScan {
  const files: RolloutScan["files"] = [];
  let rootError: Error | null = null;

  const walk = (current: string, depth: number) => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // A missing directory is normal (Codex not installed, or a date folder
      // removed mid-scan); anything else means we are blind to whatever is inside.
      // Reporting only at depth 0 would miss every real case: Codex stores
      // transcripts at sessions/YYYY/MM/DD, so the unreadable directory is nested.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !rootError) rootError = error as Error;
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(full);
          files.push({ file: full, mtime: stat.mtimeMs, size: stat.size });
        } catch {
          // Vanished between readdir and stat.
        }
      }
    }
  };

  walk(dir, 0);
  files.sort((a, b) => a.mtime - b.mtime);
  return { files, error: rootError };
}

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
}

/** Consecutive read failures tolerated before the user is told the tailer is broken. */
const FAILURE_LIMIT = 5;

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
export function watchCodexSession(
  onState: (state: AgentState) => void,
  options: WatchOptions = {},
): SessionWatcher {
  const dir = options.dir ?? codexSessionsDir();
  const intervalMs = options.intervalMs ?? 500;

  let file: string | null = null;
  let offset = 0;
  let carry = "";
  let failures = 0;
  let reported = false;

  /**
   * Every transcript that exists right now, with the size it had, is history and
   * must never trigger a quiz. Anything written past that size — or in a file that
   * appears later — is a live turn.
   *
   * Sizes matter as well as names: a session resumed in an older transcript would
   * otherwise only be noticed once that file became the newest one.
   */
  // Seeded with the size each transcript had at startup, then updated as bytes are
  // consumed. Falling back to the startup size when the newest file changes would
  // re-read everything since the pane opened whenever two sessions alternate —
  // replaying a stale `idle` that stands the pane down mid-turn.
  const consumed = new Map(scanRollouts(dir).files.map((f) => [f.file, f.size] as const));

  const fail = (message: string) => {
    failures += 1;
    if (failures >= FAILURE_LIMIT && !reported) {
      reported = true;
      options.onError?.(message);
    }
  };

  /**
   * Called only after transcript bytes are genuinely read.
   *
   * A poll that finds nothing new is not evidence that reading works again, so it
   * must not clear the failure count — otherwise a watcher failing on every
   * append never reaches the reporting threshold, because the quiet polls in
   * between keep resetting it.
   */
  const recovered = () => {
    failures = 0;
    if (reported) {
      // Tell the UI it is working again, and allow a later, different failure to
      // be reported too.
      reported = false;
      options.onError?.(null);
    }
  };

  const poll = () => {
    // The directory may not exist yet; keep looking, so opening the pane before
    // Codex has ever run does not disable the integration for the whole session.
    const scan = scanRollouts(dir);
    if (scan.error) {
      fail(`cannot read ${dir}: ${scan.error.message}`);
      return;
    }
    const newest = scan.files.at(-1);
    if (!newest) return;

    if (newest.file !== file) {
      if (file) consumed.set(file, offset);
      file = newest.file;
      carry = "";
      // Resume where we left off in this file; one never seen before starts at zero.
      offset = consumed.get(file) ?? 0;
    }

    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch (error) {
      fail(`cannot stat ${file}: ${(error as Error).message}`);
      return;
    }
    if (size < offset) {
      // Truncated or rewritten. Re-reading from zero would replay every past turn
      // and fire a spurious busy, so resync to the new end instead.
      offset = size;
      carry = "";
      consumed.set(file, offset);
      return;
    }
    if (size === offset) return;

    let chunk: string;
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(size - offset);
      // Honour the byte count actually read; the tail of the buffer would
      // otherwise be zero-fill parsed as transcript content.
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      chunk = buffer.subarray(0, read).toString("utf8");
      size = offset + read;
    } catch (error) {
      fail(`cannot read ${file}: ${(error as Error).message}`);
      // Skip the bytes we could not read; retrying the same offset forever would
      // wedge the watcher silently on a permanently unreadable file. Drop the
      // partial line too, or it is spliced onto the next chunk and that line is
      // silently discarded as unrecognised.
      offset = size;
      carry = "";
      consumed.set(file, offset);
      return;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Nothing useful to do; the descriptor is gone either way.
        }
      }
    }
    offset = size;
    consumed.set(file, offset);
    recovered();

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
