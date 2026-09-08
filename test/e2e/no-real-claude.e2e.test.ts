import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Nothing in the suite may reach the real `claude` binary.
 *
 * `pack generate` and memory hooks shell out to Claude Code now, so a test that
 * does not shadow it on PATH spends the developer's own quota — silently, once
 * per run, at up to ten minutes a call. That happened: four pack-generate tests
 * were left pointing at an HTTP stub nothing reads any more, and passed anyway
 * because real Claude returned a plausible pack.
 */
describe("the suite never spends real quota", () => {
  // This file names the dead symbols in order to look for them, so it excludes
  // itself rather than matching its own text.
  const self = path.basename(fileURLToPath(import.meta.url));
  const files = fs
    .readdirSync(here)
    .filter((f) => f.endsWith(".test.ts") && f !== self)
    .map((f) => path.join(here, f));

  it("has no test left pointing at the removed Anthropic API", () => {
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      // These only ever meant "talk to the API directly", which nothing does now.
      for (const dead of ["ANTHROPIC_BASE_URL", "@anthropic-ai/sdk"]) {
        expect(source, `${path.basename(file)} still references ${dead}`).not.toContain(dead);
      }
      // Setting a credential to "" is a deliberate assertion that the feature
      // does not need one. Setting it to a VALUE means something still expects it.
      const withValue = source.match(/ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*:\s*"(?!")[^"]/g);
      expect(withValue, `${path.basename(file)} sets a credential to a real value`).toBeNull();
    }
  });

  it("shadows `claude` on PATH wherever a command that calls it is exercised", () => {
    // Every invocation of a model-backed command must be accompanied by a
    // stand-in binary. This catches the shape, not just the symptom.
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      if (!/"pack", "generate"/.test(source)) continue;
      expect(source, `${path.basename(file)} runs pack generate`).toMatch(/stubClaude|withStub/);
    }
  });
});
