import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli.js";
import { parseKeys } from "../../src/ui/tui.js";

const ESC = String.fromCharCode(27);

describe("argument parsing", () => {
  it("defaults to opening the pane", () => {
    expect(parseArgs([]).command).toBe("run");
    expect(parseArgs(["--lang", "fr"]).command).toBe("run");
  });

  it("recognises subcommands and their arguments", () => {
    const args = parseArgs(["hook", "Stop", "--source", "codex"]);
    expect(args.command).toBe("hook");
    expect(args.rest).toEqual(["Stop"]);
    expect(args.flags.source).toBe("codex");
  });

  it("accepts both --flag value and --flag=value", () => {
    expect(parseArgs(["--lang", "it"]).flags.lang).toBe("it");
    expect(parseArgs(["--lang=it"]).flags.lang).toBe("it");
  });

  it("turns --no-x into x: false", () => {
    const flags = parseArgs(["--no-color", "--no-enrich"]).flags;
    expect(flags.color).toBe(false);
    expect(flags.enrich).toBe(false);
  });

  it("treats bare flags as true", () => {
    expect(parseArgs(["--always-on"]).flags["always-on"]).toBe(true);
  });

  it("handles help in either form", () => {
    expect(parseArgs(["-h"]).flags.help).toBe(true);
    expect(parseArgs(["--help"]).flags.help).toBe(true);
  });

  // It used to become "run", which opened the pane and sat on stdin: no output,
  // no error, no way to tell a typo from a hang.
  it("rejects an unknown word instead of opening the pane", () => {
    const args = parseArgs(["banana"]);
    expect(args.command).toBe("unknown");
    // The word survives, so the error can name what it rejected.
    expect(args.rest[0]).toBe("banana");
  });

  it("still opens the pane when there is no subcommand at all", () => {
    expect(parseArgs([]).command).toBe("run");
    expect(parseArgs(["--lang", "fr"]).command).toBe("run");
  });
});

describe("key parsing", () => {
  it("reads printable characters", () => {
    expect(parseKeys("ab1")).toEqual([{ ch: "a" }, { ch: "b" }, { ch: "1" }]);
  });

  it("names space, enter and backspace", () => {
    expect(parseKeys(" ")).toEqual([{ name: "space" }]);
    expect(parseKeys("\r")).toEqual([{ name: "enter" }]);
    expect(parseKeys("\n")).toEqual([{ name: "enter" }]);
    expect(parseKeys(String.fromCharCode(127))).toEqual([{ name: "backspace" }]);
    expect(parseKeys(String.fromCharCode(8))).toEqual([{ name: "backspace" }]);
  });

  it("collapses CRLF into one enter", () => {
    expect(parseKeys("\r\n")).toEqual([{ name: "enter" }]);
  });

  it("reads ctrl-c", () => {
    expect(parseKeys(String.fromCharCode(3))).toEqual([{ name: "ctrl-c" }]);
  });

  it("swallows arrow keys instead of typing junk", () => {
    expect(parseKeys(`${ESC}[A${ESC}[B`)).toEqual([]);
    expect(parseKeys(`${ESC}[Ax`)).toEqual([{ ch: "x" }]);
  });

  it("reports a bare escape", () => {
    expect(parseKeys(ESC)).toEqual([{ name: "escape" }]);
  });

  it("keeps accented characters", () => {
    expect(parseKeys("é")).toEqual([{ ch: "é" }]);
  });

  it("reads a whole typed word in one chunk", () => {
    expect(parseKeys("uno\r")).toEqual([
      { ch: "u" }, { ch: "n" }, { ch: "o" }, { name: "enter" },
    ]);
  });
});
