import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "./types.js";

export const DEFAULT_SETTINGS: Settings = {
  lang: "es",
  maxLearning: 8,
  newPerDay: 20,
  staleBusyMs: 15 * 60 * 1000,
  alwaysOn: false,
  enrich: true,
  model: "claude-fable-5-1",
};

/**
 * Root for all state. `CLAUDELINGO_HOME` exists so tests (and anyone running two
 * languages side by side) get a clean, isolated directory.
 */
export function home(): string {
  return process.env.CLAUDELINGO_HOME || path.join(os.homedir(), ".claudelingo");
}

export const paths = {
  home,
  settings: () => path.join(home(), "settings.json"),
  status: () => path.join(home(), "status.json"),
  progress: (lang: string) => path.join(home(), `progress-${lang}.json`),
  lock: (lang: string) => path.join(home(), `progress-${lang}.lock`),
  cache: () => path.join(home(), "cache"),
  packs: () => path.join(home(), "packs"),
};

export function ensureHome(): string {
  const dir = home();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write via a temp file, flushed and renamed, so a crash mid-write can never leave a
 * half-written or zero-length file behind. The temp file is cleaned up on failure so
 * a full disk does not litter the directory with orphans.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    // Without the flush the rename can reach disk before the bytes do, which is
    // exactly how a power cut produces an empty file where state used to be.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed or never opened cleanly; the throw below is what matters.
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort — never mask the original write failure with a cleanup failure.
    }
    throw error;
  }
}

/**
 * Why a JSON file could not be turned into a value.
 *
 * The distinction that matters is not which errno came back, but whether the READ
 * failed or the CONTENT did:
 *
 * - `missing`     — no such file. Normal; the caller starts fresh.
 * - `unreadable`  — the bytes could not be fetched (permissions, a stale NFS
 *                   handle, too many open files, a disk error). Says NOTHING about
 *                   the contents, which are probably perfectly good.
 * - `invalid`     — the bytes were read and are not what they should be. This is
 *                   the only case where replacing the file can be justified.
 *
 * Deciding that from an allow-list of errnos gets the default backwards: every
 * errno nobody thought of — ESTALE and ETIMEDOUT on a networked home, say — would
 * be treated as corruption and cost the user their data.
 */
export type ReadFailure = "missing" | "unreadable" | "invalid";

export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ReadFailure; error?: Error };

export function readJsonFile<T>(file: string): ReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unreadable", error: error as Error };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    // Read fine, parsed badly: genuinely bad content.
    return { ok: false, reason: "invalid", error: error as Error };
  }
}

/** Convenience for callers where a missing and a bad file genuinely are the same. */
export function readJson<T>(file: string): T | null {
  const result = readJsonFile<T>(file);
  return result.ok ? result.value : null;
}

/**
 * Move a file that could not be read out of the way, returning its new path.
 *
 * Nothing is ever deleted: if the data turns out to be salvageable the user still
 * has it, and the caller can tell them exactly where it went.
 */
export function quarantine(file: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, target);
    return target;
  } catch {
    return null;
  }
}

export interface LoadedSettings {
  settings: Settings;
  /** Set when an existing settings file could not be read. */
  problem?: string;
}

export function loadSettings(): LoadedSettings {
  const result = readJsonFile<Partial<Settings>>(paths.settings());
  if (result.ok) return { settings: { ...DEFAULT_SETTINGS, ...result.value } };
  if (result.reason === "missing") return { settings: { ...DEFAULT_SETTINGS } };
  const what = result.reason === "invalid" ? "is not valid JSON" : "could not be read";
  return {
    settings: { ...DEFAULT_SETTINGS },
    problem:
      `${paths.settings()} ${what} (${result.error?.message ?? "unknown error"}); ` +
      "using defaults and leaving it alone.",
  };
}

export function saveSettings(settings: Settings): void {
  writeJsonAtomic(paths.settings(), settings);
}
