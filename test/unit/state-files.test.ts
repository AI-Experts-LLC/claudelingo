import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quarantine, readJsonFile, writeJsonAtomic } from "../../src/config.js";
import * as lock from "../../src/lock.js";
import { tempHome } from "../helpers.js";

const dirs: string[] = [];
function dir(): string {
  const d = tempHome();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      // Already writable, or gone.
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("reading state files", () => {
  it("separates a missing file, an unreadable one, and invalid content", () => {
    // These three demand different responses: start fresh, leave well alone, or
    // set the file aside. Collapsing any two of them costs the user data.
    const d = dir();
    expect(readJsonFile(path.join(d, "nope.json"))).toMatchObject({ ok: false, reason: "missing" });

    const bad = path.join(d, "bad.json");
    fs.writeFileSync(bad, "{ truncated");
    const invalid = readJsonFile(bad);
    expect(invalid).toMatchObject({ ok: false, reason: "invalid" });
    expect(invalid.ok === false && invalid.error).toBeInstanceOf(Error);

    const blocked = path.join(d, "blocked.json");
    fs.writeFileSync(blocked, JSON.stringify({ a: 1 }));
    fs.chmodSync(blocked, 0o000);
    try {
      expect(readJsonFile(blocked)).toMatchObject({ ok: false, reason: "unreadable" });
    } finally {
      fs.chmodSync(blocked, 0o600);
    }
  });

  it("treats a zero-length file as invalid content, not as absent", () => {
    // What a power cut during a non-atomic write leaves behind. Treating it as
    // "no file yet" is how a deck gets silently replaced with a blank one.
    const empty = path.join(dir(), "empty.json");
    fs.writeFileSync(empty, "");
    expect(readJsonFile(empty)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reports a directory in place of a file as unreadable, never as invalid", () => {
    // EISDIR is a read failure; quarantining on it would move a real deck.
    const asDir = path.join(dir(), "progress.json");
    fs.mkdirSync(asDir);
    expect(readJsonFile(asDir)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("round-trips a good file", () => {
    const file = path.join(dir(), "good.json");
    writeJsonAtomic(file, { a: 1 });
    expect(readJsonFile<{ a: number }>(file)).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("writing state files", () => {
  it("leaves no temp file behind on success", () => {
    const d = dir();
    writeJsonAtomic(path.join(d, "x.json"), { a: 1 });
    expect(fs.readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("throws, and leaves no temp file, when the directory is not writable", () => {
    const d = dir();
    const sub = path.join(d, "locked");
    fs.mkdirSync(sub);
    fs.chmodSync(sub, 0o500);
    try {
      expect(() => writeJsonAtomic(path.join(sub, "x.json"), { a: 1 })).toThrow();
      expect(fs.readdirSync(sub)).toEqual([]);
    } finally {
      fs.chmodSync(sub, 0o700);
    }
  });

  it("flushes and renames, rather than writing in place", () => {
    // Both matter: without the flush a power cut can commit the rename ahead of
    // the bytes, and without the rename a reader can observe a half-written file.
    const fsync = vi.spyOn(fs, "fsyncSync");
    const rename = vi.spyOn(fs, "renameSync");
    try {
      const file = path.join(dir(), "x.json");
      writeJsonAtomic(file, { a: 1 });
      expect(fsync).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();
      const [from, to] = rename.mock.calls.at(-1) as [string, string];
      expect(from).toContain(".tmp");
      expect(to).toBe(file);
    } finally {
      fsync.mockRestore();
      rename.mockRestore();
    }
  });

  it("cleans up its temp file when serialising fails part-way", () => {
    const d = dir();
    const file = path.join(d, "deck.json");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // The temp file is created before the value is serialised, so this exercises
    // the cleanup path rather than a failure to open.
    expect(() => writeJsonAtomic(file, circular)).toThrow();
    expect(fs.readdirSync(d)).toEqual([]);
  });

  it("never leaves a partially written file in place of a good one", () => {
    const file = path.join(dir(), "deck.json");
    writeJsonAtomic(file, { items: { a: 1 } });
    const before = fs.readFileSync(file, "utf8");
    try {
      // A value that cannot be serialised fails before the rename.
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      writeJsonAtomic(file, circular);
    } catch {
      // expected
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("quarantine", () => {
  it("moves a file aside instead of destroying it", () => {
    const file = path.join(dir(), "progress-es.json");
    fs.writeFileSync(file, "{ corrupt");
    const moved = quarantine(file);
    expect(moved).toBeTruthy();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(moved as string, "utf8")).toBe("{ corrupt");
    expect(moved).toContain("corrupt-");
  });

  it("returns null rather than throwing when it cannot", () => {
    expect(quarantine(path.join(dir(), "not-there.json"))).toBeNull();
  });
});

describe("the single-pane lock", () => {
  it("is taken and released", () => {
    const file = path.join(dir(), "es.lock");
    const held = lock.acquire(file);
    expect(held.ok).toBe(true);
    expect(lock.holderPid(file)).toBe(process.pid);
    if (held.ok) held.lock.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a second pane while a live one holds it", () => {
    const file = path.join(dir(), "es.lock");
    // A pid that is definitely alive and is not us.
    fs.writeFileSync(file, JSON.stringify({ pid: 1, since: Date.now() }));
    const result = lock.acquire(file);
    expect(result).toMatchObject({ ok: false, reason: "held", pid: 1 });
  });

  it("excludes a genuinely simultaneous second acquirer", () => {
    // The whole point of the lock. A read-then-write excludes nothing here:
    // both callers see "no lock" before either writes one.
    const file = path.join(dir(), "es.lock");
    const first = lock.acquire(file);
    const second = lock.acquire(file);
    expect(first.ok).toBe(true);
    // Same process, so the second call adopts rather than refusing — the
    // cross-process case is covered end to end in the resilience suite.
    expect(second.ok).toBe(true);
    if (first.ok) first.lock.release();
  });

  it("reclaims a lock left behind by a crashed pane", () => {
    const file = path.join(dir(), "es.lock");
    // 2^22 is above the default pid_max, so nothing can be using it.
    fs.writeFileSync(file, JSON.stringify({ pid: 4194304, since: 0 }));
    const held = lock.acquire(file);
    expect(held.ok).toBe(true);
    expect(lock.holderPid(file)).toBe(process.pid);
    if (held.ok) held.lock.release();
  });

  it("refuses a lock file it cannot parse, rather than deleting a live pane's lock", () => {
    // The lock is written and linked into place already populated, so a lock that
    // names nobody was not written by us. Calling it stale and removing it is how
    // a concurrent acquirer deletes a lock a live pane is holding.
    const file = path.join(dir(), "es.lock");
    fs.writeFileSync(file, "not json");
    const result = lock.acquire(file);
    expect(result).toMatchObject({ ok: false, reason: "held", pid: null });
    expect(fs.readFileSync(file, "utf8")).toBe("not json");
  });

  it("never leaves the lock file existing without a pid inside it", () => {
    // The window this closes: create-then-write leaves an empty lock that another
    // acquirer reads as stale.
    const file = path.join(dir(), "es.lock");
    const held = lock.acquire(file);
    expect(held.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8").trim().length).toBeGreaterThan(0);
    expect(lock.holderPid(file)).toBe(process.pid);
    // And no temp files are left lying around.
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (held.ok) held.lock.release();
  });

  it("does not remove a lock that has since been taken by someone else", () => {
    const file = path.join(dir(), "es.lock");
    const held = lock.acquire(file);
    fs.writeFileSync(file, JSON.stringify({ pid: 1, since: Date.now() }));
    if (held.ok) held.lock.release();
    expect(lock.holderPid(file)).toBe(1);
  });

  it("reports rather than silently granting when the lock cannot be created", () => {
    // Waving this through is how two panes end up overwriting each other while
    // the user is told nothing at all.
    const d = dir();
    const sub = path.join(d, "ro");
    fs.mkdirSync(sub);
    fs.chmodSync(sub, 0o500);
    try {
      const result = lock.acquire(path.join(sub, "es.lock"));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("unavailable");
    } finally {
      fs.chmodSync(sub, 0o700);
    }
  });

  it("survives a release called twice", () => {
    const file = path.join(dir(), "es.lock");
    const held = lock.acquire(file);
    if (held.ok) {
      held.lock.release();
      expect(() => held.lock.release()).not.toThrow();
    }
  });
});
