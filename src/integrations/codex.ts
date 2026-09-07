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

interface RolloutFile {
  file: string;
  mtime: number;
  size: number;
}

interface RolloutScan {
  files: RolloutFile[];
  /** Set when any directory under the sessions root could not be listed. */
  error: Error | null;
}

/**
 * How long after a directory's mtime its listing is still treated as volatile.
 * Covers one-second mtime granularity with room to spare.
 */
const MTIME_GRANULARITY_MS = 2000;

interface DirCache {
  mtimeMs: number;
  files: Map<string, { mtime: number; size: number }>;
  subdirs: string[];
}

/**
 * Walks the sessions tree, reusing what it saw last time.
 *
 * The naive version re-listed and re-stat'd every transcript on every tick. Codex
 * history is never pruned, so for an established user that is thousands of stats a
 * second, ~99.9% of them discarded — a companion pane meant to sit quietly ends up
 * competing for CPU with the agent it is waiting on.
 *
 * A directory's mtime changes when a transcript is created or removed inside it, so
 * an unchanged directory can be served entirely from cache. Appends do NOT change
 * the parent's mtime, so files that might be appended to — the ones we are actually
 * following — are always re-stat'd by the caller.
 */
class RolloutScanner {
  private dirs = new Map<string, DirCache>();

  constructor(private readonly root: string) {}

  /**
   * Every transcript in the tree. Used once, to seed history.
   */
  all(): RolloutScan {
    const files: RolloutFile[] = [];
    const error = this.walk((file) => files.push(file));
    files.sort((a, b) => a.mtime - b.mtime);
    return { files, error };
  }

  /**
   * The most recently modified transcript.
   *
   * Tracked as the walk proceeds rather than by collecting and sorting every file:
   * on a long Codex history that array was thousands of entries rebuilt and sorted
   * on every sweep, which was most of the watcher's cost.
   */
  newest(): { file: RolloutFile | null; error: Error | null } {
    let best: RolloutFile | null = null;
    const error = this.walk((file) => {
      if (!best || file.mtime > best.mtime) best = file;
    });
    return { file: best, error };
  }

  private walk(visit: (file: RolloutFile) => void): Error | null {
    let error: Error | null = null;
    const seen = new Set<string>();

    const descend = (current: string, depth: number) => {
      if (depth > 5) return;
      seen.add(current);

      let dirMtime: number;
      try {
        dirMtime = fs.statSync(current).mtimeMs;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !error) error = err as Error;
        this.dirs.delete(current);
        return;
      }

      // Directory mtimes are coarse — one second on many filesystems — so a
      // directory listed in the same tick as a file created inside it comes back
      // with an unchanged mtime and the cache would never invalidate. Anything
      // recently touched is re-listed; that is only ever the active date folder,
      // so the established history still comes from cache.
      const cached = this.dirs.get(current);
      const settled = Date.now() - dirMtime > MTIME_GRANULARITY_MS;
      if (cached && settled && cached.mtimeMs === dirMtime) {
        for (const [file, stat] of cached.files) visit({ file, ...stat });
        // Sub-directories still need visiting: a new transcript inside one of them
        // changes that directory's mtime, not this one's.
        for (const child of cached.subdirs) descend(child, depth + 1);
        return;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (err) {
        // A missing directory is normal (Codex not installed, or a date folder
        // removed mid-scan); anything else means we are blind to what is inside.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !error) error = err as Error;
        this.dirs.delete(current);
        return;
      }

      const found = new Map<string, { mtime: number; size: number }>();
      const subdirs: string[] = [];
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          subdirs.push(full);
          descend(full, depth + 1);
        } else if (entry.name.endsWith(".jsonl")) {
          try {
            const stat = fs.statSync(full);
            found.set(full, { mtime: stat.mtimeMs, size: stat.size });
            visit({ file: full, mtime: stat.mtimeMs, size: stat.size });
          } catch {
            // Vanished between readdir and stat.
          }
        }
      }
      this.dirs.set(current, { mtimeMs: dirMtime, files: found, subdirs });
    };

    descend(this.root, 0);
    for (const known of [...this.dirs.keys()]) {
      if (!seen.has(known)) this.dirs.delete(known);
    }
    return error;
  }

  /**
   * Refresh one file's cached mtime.
   *
   * Appending to a transcript does not touch its directory's mtime, so without this
   * a followed file could never become "newest" again from the cache alone.
   */
  refresh(file: string): void {
    const dir = path.dirname(file);
    const cached = this.dirs.get(dir);
    if (!cached) return;
    try {
      const stat = fs.statSync(file);
      cached.files.set(file, { mtime: stat.mtimeMs, size: stat.size });
    } catch {
      cached.files.delete(file);
    }
  }
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
  /**
   * How often to look for a *different* transcript becoming the newest. Following
   * the current one is done on every tick; hunting for new sessions is not, because
   * that is the part whose cost grows with the user's Codex history.
   */
  scanIntervalMs?: number;
}

/** Consecutive read failures tolerated before the user is told the tailer is broken. */
const FAILURE_LIMIT = 5;

/**
 * How many pre-existing transcripts stay under active watch, newest first.
 * `codex resume` reopens a recent session; anything older is history.
 */
const RESUME_CANDIDATES = 8;

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
  const scanIntervalMs = options.scanIntervalMs ?? 1000;

  let file: string | null = null;
  let offset = 0;
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
  const scanner = new RolloutScanner(dir);

  // Seeded with the size each transcript had at startup, then updated as bytes are
  // consumed. Falling back to the startup size when the newest file changes would
  // re-read everything since the pane opened whenever two sessions alternate —
  // replaying a stale `idle` that stands the pane down mid-turn.
  const seed = scanner.all();
  const consumed = new Map(seed.files.map((f) => [f.file, f.size] as const));
  // A subtree we could not read at startup contributed no seed entries. If it later
  // becomes readable, its transcripts must be adopted as history rather than read
  // from the beginning — replaying them would act on a long-dead agent state.
  const seedIncomplete = seed.error !== null;
  const startedAt = Date.now();
  /**
   * Transcripts whose mtimes are re-checked on every sweep.
   *
   * Appending to a file does not change its directory's mtime, so a transcript in
   * a settled directory would otherwise keep serving a stale cached entry and
   * never look like the newest again. Two kinds need watching: the ones we have
   * followed, and the handful most recently written before we started — which is
   * what `codex resume` reopens. Bounded on purpose; watching the whole history is
   * exactly the cost the cache exists to avoid.
   */
  const watchlist = new Set<string>(
    seed.files.slice(-RESUME_CANDIDATES).map((f) => f.file),
  );
  // Partial lines are per-file: keeping one shared buffer splices the tail of one
  // transcript onto the head of another when the newest file changes.
  const carries = new Map<string, string>();

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
  const carry = () => (file ? (carries.get(file) ?? "") : "");
  const setCarry = (value: string) => {
    if (file) carries.set(file, value);
  };

  const recovered = () => {
    failures = 0;
    if (reported) {
      // Tell the UI it is working again, and allow a later, different failure to
      // be reported too.
      reported = false;
      options.onError?.(null);
    }
  };

  let lastScan = 0;

  const poll = () => {
    const now = Date.now();
    // Hunting for a newer transcript walks the tree; following the one already
    // open does not. Separating them keeps the steady-state cost flat no matter
    // how much Codex history has piled up, and a session that starts is still
    // noticed well inside the time a turn takes.
    const due = file === null || now - lastScan >= scanIntervalMs;

    if (due) {
      lastScan = now;
      // Appends do not change a directory's mtime, so a cached entry goes stale the
      // moment a transcript is written to. Refresh every transcript we have
      // followed this run — a bounded set, one per session seen — or flipping back
      // to an earlier session would never be noticed.
      for (const seen of watchlist) scanner.refresh(seen);

      // The directory may not exist yet; keep looking, so opening the pane before
      // Codex has ever run does not disable the integration for the whole session.
      const scan = scanner.newest();
      if (scan.error) {
        fail(`cannot read ${dir}: ${scan.error.message}`);
        // Carry on with whatever was readable: one unreadable stray directory must
        // not disable the integration for every transcript we CAN see.
      }
      if (!scan.file) return;
      adopt(scan.file);
    }

    if (!file) return;
    readNewBytes(file);
  };

  function adopt(newest: { file: string; size: number; mtime: number }): void {
    if (newest.file !== file) {
      if (file) {
        consumed.set(file, offset);
        carries.set(file, carry());
      }
      file = newest.file;
      watchlist.add(file);
      if (!consumed.has(file) && seedIncomplete && newest.mtime < startedAt) {
        // The startup scan could not see everything, so this may have been hidden
        // behind an unreadable directory rather than being new. Its mtime settles
        // it: last written before we started, so it is history — adopt it at its
        // current size instead of replaying a long-dead agent state.
        consumed.set(file, newest.size);
      }
      // Resume where we left off in this file; one never seen before starts at zero.
      offset = consumed.get(file) ?? 0;
    }
  }

  function readNewBytes(file: string): void {
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
      setCarry("");
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
      setCarry("");
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

    const lines = (carry() + chunk).split("\n");
    setCarry(lines.pop() ?? "");
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
