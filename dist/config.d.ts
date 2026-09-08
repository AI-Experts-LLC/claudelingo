import type { Settings } from "./types.js";
export declare const DEFAULT_SETTINGS: Settings;
/**
 * Root for all state. `CLAUDELINGO_HOME` exists so tests (and anyone running two
 * languages side by side) get a clean, isolated directory.
 */
export declare function home(): string;
export declare const paths: {
    home: typeof home;
    settings: () => string;
    status: () => string;
    progress: (lang: string) => string;
    lock: (lang: string) => string;
    pending: (lang: string) => string;
    cache: () => string;
    packs: () => string;
};
export declare function ensureHome(): string;
/**
 * Write via a temp file, flushed and renamed, so a crash mid-write can never leave a
 * half-written or zero-length file behind. The temp file is cleaned up on failure so
 * a full disk does not litter the directory with orphans.
 */
export declare function writeJsonAtomic(file: string, value: unknown): void;
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
export type ReadResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: ReadFailure;
    error?: Error;
};
export declare function readJsonFile<T>(file: string): ReadResult<T>;
/**
 * Move a file that could not be read out of the way, returning its new path.
 *
 * Nothing is ever deleted: if the data turns out to be salvageable the user still
 * has it, and the caller can tell them exactly where it went.
 */
export declare function quarantine(file: string): string | null;
export interface LoadedSettings {
    settings: Settings;
    /** Set when an existing settings file could not be read. */
    problem?: string;
}
export declare function loadSettings(): LoadedSettings;
export declare function saveSettings(settings: Settings): void;
