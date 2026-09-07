import fs from "node:fs";
import path from "node:path";

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

export type AcquireResult =
  | { ok: true; lock: Lock }
  /** Another live pane holds it. `pid` is null when the lock file is unreadable. */
  | { ok: false; reason: "held"; pid: number | null }
  /** The lock itself could not be created — the single-pane guarantee is off. */
  | { ok: false; reason: "unavailable"; error: Error };

function read(file: string): LockFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function claim(file: string): Lock | null {
  let fd: number;
  try {
    // "wx" creates exclusively: if the file exists the open fails. This is the
    // whole mechanism — a read-then-write excludes nothing, because two panes
    // starting together both read "no lock" before either writes one.
    fd = fs.openSync(file, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }

  try {
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, since: Date.now() })}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      // Only remove a lock that is still ours: a reclaimed one may already
      // belong to a pane that started after us.
      const current = read(file);
      if (current && current.pid !== process.pid) return;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A lock whose owner is gone is reclaimable anyway.
      }
    },
  };
}

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
export function acquire(file: string): AcquireResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = claim(file);
      if (lock) return { ok: true, lock };
    } catch (error) {
      return { ok: false, reason: "unavailable", error: error as Error };
    }

    // The file exists. Decide whether its owner is still around.
    const current = read(file);
    if (current) {
      if (current.pid === process.pid) {
        // Our own lock from earlier in this process; adopt it.
        return { ok: true, lock: { release: () => fs.rmSync(file, { force: true }) } };
      }
      if (alive(current.pid)) return { ok: false, reason: "held", pid: current.pid };
    }

    // Either the holder is gone, or the lock file is unreadable and names nobody.
    // Both are stale: clear it and try the exclusive create once more. A live
    // pane that recreates it in between wins the next attempt, and we back off.
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      return { ok: false, reason: "unavailable", error: error as Error };
    }
  }

  return { ok: false, reason: "held", pid: read(file)?.pid ?? null };
}

export function holderPid(file: string): number | null {
  return read(file)?.pid ?? null;
}
