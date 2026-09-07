import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectiveState,
  readStatus,
  stateForEvent,
  watchStatus,
  writeStatus,
} from "../../src/agentState.js";
import { MINUTE, T0, tempHome } from "../helpers.js";

const homes: string[] = [];
function home(): string {
  const dir = tempHome();
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("event mapping", () => {
  it("treats prompt submission and tool use as working", () => {
    expect(stateForEvent("UserPromptSubmit")).toBe("busy");
    expect(stateForEvent("PreToolUse")).toBe("busy");
  });

  it("treats stopping and session end as idle", () => {
    expect(stateForEvent("Stop")).toBe("idle");
    expect(stateForEvent("SubagentStop")).toBe("idle");
    expect(stateForEvent("SessionEnd")).toBe("idle");
  });

  it("treats a permission prompt as idle, because the human is needed", () => {
    expect(stateForEvent("Notification")).toBe("idle");
  });

  it("maps the Codex turn-complete event", () => {
    expect(stateForEvent("agent-turn-complete")).toBe("idle");
  });

  it("ignores events it does not model", () => {
    expect(stateForEvent("SomethingNew")).toBeNull();
  });
});

describe("status file", () => {
  it("round-trips", () => {
    const file = path.join(home(), "status.json");
    writeStatus({ state: "busy", source: "claude", event: "UserPromptSubmit", ts: T0 }, file);
    expect(readStatus(file)).toEqual({
      state: "busy", source: "claude", event: "UserPromptSubmit", ts: T0,
    });
  });

  it("returns null for a missing or corrupt file", () => {
    const dir = home();
    expect(readStatus(path.join(dir, "nope.json"))).toBeNull();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ not json");
    expect(readStatus(bad)).toBeNull();
  });

  it("rejects a status with an unknown state", () => {
    const file = path.join(home(), "weird.json");
    fs.writeFileSync(file, JSON.stringify({ state: "confused" }));
    expect(readStatus(file)).toBeNull();
  });
});

describe("staleness", () => {
  it("keeps a fresh busy", () => {
    const status = { state: "busy" as const, source: "claude" as const, event: "x", ts: T0 };
    expect(effectiveState(status, T0 + MINUTE, 15 * MINUTE)).toBe("busy");
  });

  it("ages out a busy left behind by a killed session", () => {
    const status = { state: "busy" as const, source: "claude" as const, event: "x", ts: T0 };
    expect(effectiveState(status, T0 + 20 * MINUTE, 15 * MINUTE)).toBe("idle");
  });

  it("never ages an idle into busy", () => {
    const status = { state: "idle" as const, source: "claude" as const, event: "x", ts: T0 };
    expect(effectiveState(status, T0 + 90 * MINUTE, 15 * MINUTE)).toBe("idle");
  });

  it("treats a missing status as idle", () => {
    expect(effectiveState(null, T0, 15 * MINUTE)).toBe("idle");
  });
});

describe("watching", () => {
  it("reports changes and dedupes repeats", async () => {
    const file = path.join(home(), "status.json");
    writeStatus({ state: "idle", source: "manual", event: "startup", ts: T0 }, file);

    const seen: string[] = [];
    const watcher = watchStatus((status) => seen.push(status?.state ?? "none"), {
      file, intervalMs: 20,
    });

    writeStatus({ state: "busy", source: "claude", event: "UserPromptSubmit", ts: T0 + 1 }, file);
    await vi.waitFor(() => expect(seen).toContain("busy"), { timeout: 3000, interval: 20 });

    const before = seen.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(seen.length).toBe(before); // nothing changed, so nothing fired

    writeStatus({ state: "idle", source: "claude", event: "Stop", ts: T0 + 2 }, file);
    await vi.waitFor(() => expect(seen.at(-1)).toBe("idle"), { timeout: 3000, interval: 20 });
    watcher.stop();
  });

  it("picks up a status file created after the watcher starts", async () => {
    const file = path.join(home(), "later.json");
    const seen: string[] = [];
    const watcher = watchStatus((s) => seen.push(s?.state ?? "none"), { file, intervalMs: 20 });
    writeStatus({ state: "busy", source: "codex", event: "rollout", ts: T0 }, file);
    await vi.waitFor(() => expect(seen).toContain("busy"), { timeout: 3000, interval: 20 });
    watcher.stop();
  });
});
