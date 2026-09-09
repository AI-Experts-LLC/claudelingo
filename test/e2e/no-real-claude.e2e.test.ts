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
/**
 * The end of the call starting at `from`, by matching parens.
 *
 * Looking for the next `");"` ran past calls that did not end that way — an
 * unshielded `cli(["start"], e)` with no trailing semicolon was swallowed by the
 * assertion on the following line, and passed.
 */
function endOfCall(source: string, from: number): number {
  let depth = 0;
  for (let i = source.indexOf("(", from); i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/**
 * Call sites that could reach the real `claude` with nothing shadowing it.
 *
 * Separated from the file scan so it can be tested against fixtures: while every
 * call in the tree is shielded, a broken scan looks exactly like a clean tree.
 */
export function unshieldedCalls(source: string): string[] {
  const launches = /\bcli\(\s*\[\s*"(?:start|claude)"|"pack",\s*"generate"/g;
  const found: string[] = [];
  for (const match of source.matchAll(launches)) {
    const from = match.index ?? 0;
    const call = source.slice(from, endOfCall(source, from));
    if (!/withStub|stubClaude|PATH/.test(call)) found.push(call);
  }
  return found;
}

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

  it("shadows `claude` on PATH at every call site that could reach it", () => {
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const call of unshieldedCalls(source)) {
        expect(
          call,
          `${path.basename(file)} can reach the real claude with nothing shadowing it: ${call}`,
        ).toBe("");
      }
    }
  });

  // A guard nobody has seen fail is a guard nobody knows works. These fixtures
  // are what make the scan above provable: without them, breaking it could only
  // be noticed by an unshielded call actually existing in the tree.
  it("finds the unshielded shapes, including the ones that used to slip through", () => {
    const bad = [
      'const r = await cli(["start", "--model", "opus"], e);',
      // No trailing semicolon: the old scan ran on and found "PATH" below.
      'const r = await cli(["start"], e)\n    expect(r.stderr).toContain("PATH");',
      'await cli(\n      ["pack", "generate", "--lang", "Xhosa"],\n      e,\n    );',
      'await cli(["claude", "--help"], e);',
    ];
    for (const source of bad) {
      expect(unshieldedCalls(source), `missed: ${source}`).toHaveLength(1);
    }
  });

  it("passes the shielded shapes, so it is not simply always failing", () => {
    const good = [
      'const r = await cli(["start", "--model", "opus"], e, withStub(bin));',
      'await cli(["pack", "generate", "--lang", "Xhosa"], e, withStub(stubClaude(e, {})));',
      'await cli(\n      ["claude"],\n      e,\n      { PATH: `${bin}:${process.env.PATH}` },\n    );',
      // Not a launch at all.
      'await cli(["stats"], e);',
    ];
    for (const source of good) {
      expect(unshieldedCalls(source), `false alarm: ${source}`).toHaveLength(0);
    }
  });
});
