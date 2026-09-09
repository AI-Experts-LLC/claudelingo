import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type PanelOptions, renderPanel } from "../../src/statusline.js";
import { T0, testPack, testProgress } from "../helpers.js";
import type { Progress } from "../../src/types.js";

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

  // The panel is the only control surface, and the skill is the only thing that
  // acts on it. A hint the skill does not recognise falls through to its
  // catch-all — which grades the outstanding card, the opposite of what
  // `/lingo quiz me` asks for.
  it("documents in the skill every command the panel tells people to type", () => {
    const skill = fs.readFileSync(path.join(root, "skills", "lingo", "SKILL.md"), "utf8");
    const pack = testPack();
    const fresh = testProgress();
    // Everything learned and nothing due: the "all caught up" panel, which has
    // hints of its own and is easy to leave out of a sweep like this.
    const caughtUp = testProgress();
    for (const word of pack.words) {
      caughtUp.items[word.id] = {
        id: word.id, stage: "review", box: 5, step: 0,
        due: T0 + 30 * 24 * 3600_000, lastSeen: T0, seen: 9, correct: 9, lapses: 0,
      };
    }
    const states: [Progress, PanelOptions][] = [
      [fresh, {}],
      [caughtUp, {}],
      [fresh, { outstanding: true }],
      [fresh, { pending: { question: "q", choices: ["a", "b"] } }],
      [fresh, { pending: { question: "q", choices: [], kind: "teach" } }],
    ];
    // Whole hints, split on the panel's own gap. The previous version of this
    // matched `/lingo` plus ONE word, so `/lingo quiz me` became `/lingo quiz`
    // and was satisfied by the word "quiz" in the skill's frontmatter — the row
    // it was written to protect could be deleted with the suite still green.
    const printed = new Set<string>();
    for (const [progress, options] of states) {
      for (const line of renderPanel(pack, progress, T0, { ...options, color: false })) {
        for (const segment of line.split(/\s{2,}/)) {
          const hint = segment.trim();
          if (hint.startsWith("/lingo")) printed.add(hint);
        }
      }
    }

    // What each hint obliges SKILL.md to say. A hint with no entry here fails:
    // that is the point — a new control must be taught to the skill, or it falls
    // through its catch-all and grades the outstanding card.
    const required: Record<string, string> = {
      "/lingo quiz me": "`/lingo quiz me`",
      "/lingo stats": "`/lingo stats`",
      "/lingo lang": "`/lingo lang`",
      "/lingo skip": "`/lingo skip`",
      "/lingo ok got it": "`/lingo ok`",
      "/lingo N-N answer": "`/lingo 1`",
      "/lingo <answer>": "answer --text",
      "/lingo show it": "Deal a card",
    };

    expect(printed.size).toBeGreaterThanOrEqual(6);
    for (const raw of printed) {
      // The range depends on how many choices the card had; the obligation does not.
      const hint = raw.replace(/\b\d+-\d+\b/, "N-N");
      const phrase = required[hint];
      expect(phrase, `the panel prints "${hint}" and this test does not know it`).toBeTruthy();
      expect(skill, `the panel prints "${hint}" but SKILL.md never says ${phrase}`).toContain(
        phrase as string,
      );
    }
  });

  // A card dealt and acknowledged in the same turn never appears on the panel,
  // which is the whole point of the panel — and it answers on the user's behalf.
  it("tells the skill to wait for the person between dealing and grading", () => {
    const skill = fs.readFileSync(path.join(root, "skills", "lingo", "SKILL.md"), "utf8");
    expect(skill).toContain("Do not deal a card and acknowledge it in the same breath");
    expect(skill).toContain("Never `next` immediately followed by `answer`");
    // Including the teach card, which is where it used to happen every time.
    expect(skill).toMatch(/teach.*(?:\n.*){0,12}AskUserQuestion/);
  });

  it("does not offer the grader an index no card has", () => {
    // Cards carry at most four choices; `/lingo 9` used to be graded as a miss.
    const skill = fs.readFileSync(path.join(root, "skills", "lingo", "SKILL.md"), "utf8");
    expect(skill).not.toContain("`/lingo 9`");
    expect(skill).toContain("`/lingo 4`");
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
