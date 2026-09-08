import { describe, expect, it } from "vitest";
import { PANEL_ROWS, renderPanel } from "../../src/statusline.js";
import { visibleWidth } from "../../src/ui/render.js";
import { MASCOT_HEIGHT } from "../../src/ui/mascot.js";
import { T0, testPack, testProgress } from "../helpers.js";
import type { Progress } from "../../src/types.js";

const pack = testPack();
const plain = { color: false } as const;

function seeded(): Progress {
  const progress = testProgress();
  progress.items["xx:1"] = {
    id: "xx:1", stage: "review", box: 3, step: 0,
    due: T0 - 1000, lastSeen: T0, seen: 4, correct: 3, lapses: 0,
  };
  progress.streak = 5;
  return progress;
}

describe("the panel under the prompt", () => {
  it("is exactly as tall as the owl, so the conversation never shifts", () => {
    expect(PANEL_ROWS).toBe(MASCOT_HEIGHT);
    for (const now of [T0, T0 + 3000, T0 + 60_000]) {
      expect(renderPanel(pack, seeded(), now, plain)).toHaveLength(PANEL_ROWS);
    }
  });

  it("always names a command, because it cannot take a keypress", () => {
    const states = [
      renderPanel(pack, seeded(), T0, plain),
      renderPanel(pack, testProgress(), T0, plain),
      renderPanel(pack, seeded(), T0, {
        ...plain,
        pending: { question: "What does «uno» mean?", choices: ["one", "two"] },
      }),
    ];
    for (const rows of states) expect(rows[rows.length - 1]).toContain("/lingo");
  });

  it("shows every choice and marks none of them", () => {
    const choices = ["one", "two", "three", "four"];
    const rows = renderPanel(pack, seeded(), T0, {
      ...plain,
      pending: { question: "What does «uno» mean?", choices },
    }).join("\n");
    for (const [i, choice] of choices.entries()) expect(rows).toContain(`${i + 1} ${choice}`);
    expect(rows).toContain("/lingo 1-4");
  });

  // The drill reveals meanings on a timer. While a question is outstanding that
  // reveal would be handing over the answer to the card on screen.
  it("never reveals a meaning while a question is outstanding", () => {
    const word = pack.words[0]!;
    const progress = seeded();
    for (let step = 0; step < 24; step++) {
      const rows = renderPanel(pack, progress, T0 + step * 1000, {
        ...plain,
        pending: { question: `What does "${word.term}" mean?`, choices: ["a", "b"] },
      }).join("\n");
      expect(rows).not.toContain(word.gloss);
    }
  });

  it("says there is nothing to answer on a teach card", () => {
    const rows = renderPanel(pack, seeded(), T0, {
      ...plain,
      pending: { question: 'New word: "uno" means "one".', choices: [], kind: "teach" },
    }).join("\n");
    expect(rows).toContain("nothing to answer");
    expect(rows).toContain("/lingo ok");
    expect(rows).not.toContain("/lingo 1-");
  });

  it("fits the width it is given, at every width worth having", () => {
    for (const width of [30, 40, 46, 60, 80, 120]) {
      for (const rows of [
        renderPanel(pack, seeded(), T0, { ...plain, width }),
        renderPanel(pack, seeded(), T0, {
          ...plain,
          width,
          pending: { question: "q".repeat(200), choices: ["a".repeat(60), "b".repeat(60)] },
        }),
      ]) {
        for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("falls back to the single line when there is no room for a panel", () => {
    expect(renderPanel(pack, seeded(), T0, { ...plain, width: 24 })).toHaveLength(1);
  });

  it("drops the owl before it drops the words", () => {
    const wide = renderPanel(pack, seeded(), T0, { ...plain, width: 80 }).join("\n");
    const narrow = renderPanel(pack, seeded(), T0, { ...plain, width: 40 }).join("\n");
    expect(wide).toContain(",___,");
    expect(narrow).not.toContain(",___,");
    expect(narrow).toContain("/lingo");
  });
});
