import fs from "node:fs";
import { readJsonFile, writeJsonAtomic } from "./config.js";

interface LockFile {
  pid: number;
  since: number;
}

function alive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Lock {
  release(): void;
}

/**
 * Take an exclusive lock on one language's progress file.
 *
 * Two panes on the same language each hold progress in memory and save the whole
 * file, so the second one to answer a card silently erases everything the first
 * learned. One pane per language, and a clear message rather than lost work.
 *
 * Returns null when another live pane holds the lock. A lock left behind by a
 * crashed process is reclaimed.
 */
export function acquire(file: string): Lock | null {
  const existing = readJsonFile<LockFile>(file);
  if (existing.ok && typeof existing.value.pid === "number" && alive(existing.value.pid)) {
    if (existing.value.pid !== process.pid) return null;
  }

  try {
    writeJsonAtomic(file, { pid: process.pid, since: Date.now() } satisfies LockFile);
  } catch {
    // An unwritable home is reported by the save path, which gives a far better
    // message than failing to start; do not block the user over the lock alone.
    return { release() {} };
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      // Only remove a lock that is still ours — a reclaimed one may belong to
      // a pane that started after us.
      const current = readJsonFile<LockFile>(file);
      if (current.ok && current.value.pid !== process.pid) return;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A stale lock is reclaimable, so failing to remove it is not fatal.
      }
    },
  };
}

export function holderPid(file: string): number | null {
  const existing = readJsonFile<LockFile>(file);
  return existing.ok && typeof existing.value.pid === "number" ? existing.value.pid : null;
}
