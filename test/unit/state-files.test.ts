import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  it("tells a missing file apart from an unreadable one", () => {
    const d = dir();
    expect(readJsonFile(path.join(d, "nope.json"))).toMatchObject({ ok: false, reason: "missing" });

    const bad = path.join(d, "bad.json");
    fs.writeFileSync(bad, "{ truncated");
    const result = readJsonFile(bad);
    expect(result).toMatchObject({ ok: false, reason: "unreadable" });
    expect(result.ok === false && result.error).toBeInstanceOf(Error);
  });

  it("treats a zero-length file as unreadable, not as absent", () => {
    // This is what a power cut during a non-atomic write leaves behind, and
    // treating it as "no file yet" is how a deck gets silently replaced.
    const empty = path.join(dir(), "empty.json");
    fs.writeFileSync(empty, "");
    expect(readJsonFile(empty)).toMatchObject({ ok: false, reason: "unreadable" });
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
    expect(held).not.toBeNull();
    expect(lock.holderPid(file)).toBe(process.pid);
    held!.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a second pane while a live one holds it", () => {
    const file = path.join(dir(), "es.lock");
    // A pid that is definitely alive and is not us.
    fs.writeFileSync(file, JSON.stringify({ pid: 1, since: Date.now() }));
    expect(lock.acquire(file)).toBeNull();
  });

  it("reclaims a lock left behind by a crashed pane", () => {
    const file = path.join(dir(), "es.lock");
    // 2^22 is above the default pid_max, so nothing can be using it.
    fs.writeFileSync(file, JSON.stringify({ pid: 4194304, since: 0 }));
    const held = lock.acquire(file);
    expect(held).not.toBeNull();
    expect(lock.holderPid(file)).toBe(process.pid);
    held!.release();
  });

  it("reclaims a corrupt lock file", () => {
    const file = path.join(dir(), "es.lock");
    fs.writeFileSync(file, "not json");
    expect(lock.acquire(file)).not.toBeNull();
  });

  it("does not remove a lock that has since been taken by someone else", () => {
    const file = path.join(dir(), "es.lock");
    const held = lock.acquire(file);
    fs.writeFileSync(file, JSON.stringify({ pid: 1, since: Date.now() }));
    held!.release();
    expect(lock.holderPid(file)).toBe(1);
  });

  it("does not block the pane when the lock itself cannot be written", () => {
    const d = dir();
    const sub = path.join(d, "ro");
    fs.mkdirSync(sub);
    fs.chmodSync(sub, 0o500);
    try {
      // An unwritable home is reported by the save path with a far better message.
      expect(lock.acquire(path.join(sub, "es.lock"))).not.toBeNull();
    } finally {
      fs.chmodSync(sub, 0o700);
    }
  });
});
