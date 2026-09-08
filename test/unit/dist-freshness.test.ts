import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the committed build", () => {
  it("matches what src/ compiles to", () => {
    // `dist/` is committed because installing a Claude Code plugin is a clone,
    // not a build. That trade means the tree can drift from its source in a
    // commit and nobody would notice until a user ran stale code.
    expect(() =>
      execFileSync("node", ["scripts/check-dist.mjs"], { cwd: root, stdio: "pipe" }),
    ).not.toThrow();
  }, 60_000);
});
