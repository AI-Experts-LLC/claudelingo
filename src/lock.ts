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

type LockRead =
  /** A lock naming a live or dead pid. */
  | { state: "held"; lock: LockFile }
  /** The file is not there — it was released between our attempt and this read. */
  | { state: "gone" }
  /** The file exists but names nobody. Never something we wrote. */
  | { state: "unreadable" };

function read(file: string): LockRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Distinguishing this from a parse failure matters: refusing on ENOENT rejects
    // a pane started the instant another exits, naming a file that is already gone.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "gone" }
      : { state: "unreadable" };
  }
  try {
    const parsed = JSON.parse(raw) as LockFile;
    if (typeof parsed?.pid === "number") return { state: "held", lock: parsed };
  } catch {
    // Falls through to unreadable.
  }
  return { state: "unreadable" };
}

function releaseFor(file: string): Lock {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      // Only remove a lock that is still ours: a reclaimed one may already
      // belong to a pane that started after us.
      const current = read(file);
      if (current.state === "held" && current.lock.pid !== process.pid) return;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A lock whose owner is gone is reclaimable anyway.
      }
    },
  };
}

/**
 * Create the lock, fully populated, in one atomic step.
 *
 * The pid is written to a temp file and only then linked into place. Creating an
 * empty file first and writing the pid afterwards leaves a window in which the lock
 * exists but names nobody — and a concurrent acquirer that reads it in that window
 * sees an unparseable lock, concludes it is stale, and deletes a LIVE pane's lock.
 *
 * `link` fails with EEXIST rather than overwriting, which is what makes it a lock.
 */
function claim(file: string): Lock | null {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx");
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, since: Date.now() })}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    return releaseFor(file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The link (if it succeeded) is what matters; the temp name is disposable.
    }
  }
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

    // The link failed, so something was there. Work out what.
    const current = read(file);
    if (current.state === "gone") continue; // released in between; try again

    if (current.state === "unreadable") {
      // A lock that names nobody. Since `claim` links the file into place already
      // populated, we cannot have produced this — so it is either someone else's
      // corruption or a truly ancient artefact. Refusing is the safe answer: a
      // wrong "stale" call here deletes a live pane's lock.
      return { ok: false, reason: "held", pid: null };
    }
    if (current.lock.pid === process.pid) return { ok: true, lock: releaseFor(file) };
    if (alive(current.lock.pid)) return { ok: false, reason: "held", pid: current.lock.pid };

    // The holder is gone. Clear it and try the exclusive create once more; a live
    // pane that recreates it in between wins, and we back off on the next pass.
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      return { ok: false, reason: "unavailable", error: error as Error };
    }
  }

  const final = read(file);
  return { ok: false, reason: "held", pid: final.state === "held" ? final.lock.pid : null };
}

export function holderPid(file: string): number | null {
  const current = read(file);
  return current.state === "held" ? current.lock.pid : null;
}
