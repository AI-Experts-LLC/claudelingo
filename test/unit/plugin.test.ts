import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
);
const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));

describe("the Claude Code plugin", () => {
  it("declares what Claude Code needs to find it", () => {
    expect(manifest.name).toBe("claudelingo");
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(manifest.skills).toBe("./skills/");
    for (const rel of [manifest.hooks, manifest.skills]) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
  });

  it("wires every hook the pane depends on", () => {
    expect(Object.keys(hooks).sort()).toEqual(
      ["Notification", "SessionEnd", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit"],
    );
  });

  it("opens the pane in the background, so it cannot delay a session starting", () => {
    const entry = hooks.SessionStart[0].hooks[0];
    expect(entry.command).toContain("session-start");
    expect(entry.async).toBe(true);
  });

  it("addresses its own binary, not one it hopes is on PATH", () => {
    // A plugin is installed anywhere; ${CLAUDE_PLUGIN_ROOT} is how it finds itself.
    for (const event of Object.keys(hooks)) {
      for (const entry of hooks[event][0].hooks) {
        expect(entry.command, event).toContain("${CLAUDE_PLUGIN_ROOT}");
        // Quoted, because a plugin can be installed under a path with spaces.
        expect(entry.command, event).toMatch(/^"\$\{CLAUDE_PLUGIN_ROOT\}"/);
      }
    }
  });

  it("ships an executable entry point that resolves its own location", () => {
    const bin = path.join(root, "bin", "claudelingo");
    expect(fs.existsSync(bin)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(bin).mode & 0o111).toBeGreaterThan(0);
    const source = fs.readFileSync(bin, "utf8");
    expect(source.startsWith("#!/bin/sh")).toBe(true);
    expect(source).toContain("dirname");
    // No absolute path from any developer machine, not just this one.
    expect(source).not.toMatch(/^\/(Users|home|data)\//m);
  });

  it("ships the compiled output, because installing a plugin is a clone not a build", () => {
    expect(fs.existsSync(path.join(root, "dist", "cli.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist", "packs", "es.json"))).toBe(true);
    // And it is tracked, not merely present on this machine.
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).not.toMatch(/^dist\/?$/m);
  });

  it("has a skill Claude can find by description alone", () => {
    const skill = fs.readFileSync(path.join(root, "skills", "lingo", "SKILL.md"), "utf8");
    const frontmatter = skill.split("---")[1] ?? "";
    expect(frontmatter).toMatch(/^name: lingo$/m);
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    // Long enough to trigger on the things a user would actually say.
    expect(description.length).toBeGreaterThan(60);
    for (const cue of ["quiz", "practise", "flashcards"]) {
      expect(description.toLowerCase(), cue).toContain(cue);
    }
  });

  it("tells the skill not to reveal the answer", () => {
    // The commands withhold it on purpose; the skill must not undo that by
    // guessing or by reordering the options.
    const skill = fs.readFileSync(path.join(root, "skills", "lingo", "SKILL.md"), "utf8");
    expect(skill).toContain("not told");
    expect(skill).toContain("Do not reorder");
    expect(skill).toContain("AskUserQuestion");
  });
});
