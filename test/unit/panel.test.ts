import { describe, expect, it } from "vitest";
import {
  PANEL_ROWS,
  WORD_MS,
  renderPanel,
  renderStatusLine,
  statusLineState,
} from "../../src/statusline.js";
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

  // Counting array entries cannot see this: one row containing a newline is three
  // rows on screen, and the promise is about what the user sees.
  it("puts no newline inside a row, however the text arrived", () => {
    const nasty = "What does\n\nthis\r\nmean?";
    for (const options of [
      { pending: { question: nasty, choices: ["one\ntwo", "three"] } },
      { pending: { question: nasty, choices: [], kind: "teach" } },
    ]) {
      const rows = renderPanel(pack, seeded(), T0, { ...plain, ...options });
      expect(rows).toHaveLength(PANEL_ROWS);
      for (const row of rows) {
        expect(row).not.toContain("\n");
        expect(row).not.toContain("\r");
      }
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

  // The pending file may be unreadable — written by an older version, or
  // truncated. The drill ranks the most overdue word first, which is exactly the
  // card that was handed out, so falling back to it answers the question.
  it("stays quiet when a question is outstanding but could not be read", () => {
    const word = pack.words[0]!;
    const progress = seeded();
    for (let step = 0; step < 24; step++) {
      const rows = renderPanel(pack, progress, T0 + step * 1000, {
        ...plain,
        pending: null,
        outstanding: true,
      }).join("\n");
      expect(rows).not.toContain(word.gloss);
      expect(rows).toContain("waiting");
      expect(rows).toContain("/lingo");
    }
  });

  // Both forms, every clock offset, against the word the drill would have picked
  // — which is the overdue one, which is the card that was dealt. Naming the word
  // from `statusLineState` is what makes this test able to fail: asserting on a
  // word the drill was never going to show proves nothing.
  it.each([
    ["a readable question", { question: "What does it mean?", choices: ["a", "b"] }, false],
    ["an unreadable one", null, true],
  ])("never reveals the drill's own word while %s is outstanding", (_name, pending, outstanding) => {
    const progress = seeded();
    for (let step = 0; step < 60; step++) {
      const now = T0 + step * 500;
      const would = statusLineState(pack, progress, now).word;
      expect(would).toBeTruthy();
      const options = { ...plain, pending, outstanding };
      const panel = renderPanel(pack, progress, now, options).join("\n");
      const line = renderStatusLine(pack, progress, now, options);
      for (const rendered of [panel, line]) {
        expect(rendered).not.toContain(would!.gloss);
        expect(rendered).toContain("/lingo");
      }
    }
  });

  it("goes quiet in the one-line form too, at every width", () => {
    const progress = seeded();
    for (const width of [20, 24, 29, 30, 40, 80]) {
      for (let step = 0; step < 30; step++) {
        const now = T0 + step * 1000;
        const would = statusLineState(pack, progress, now).word!;
        const rows = renderPanel(pack, progress, now, {
          ...plain,
          width,
          pending: { question: "What does it mean?", choices: ["a", "b"] },
        });
        expect(rows.join("\n")).not.toContain(would.gloss);
      }
    }
  });

  // A running pane keeps its card in memory and writes no pending file, so the
  // line had no idea a question was on screen and drilled on — within one
  // rotation printing the answer to the card the pane was asking.
  it("goes quiet, and points at the pane, while a pane holds the deck", () => {
    const progress = seeded();
    for (let step = 0; step < 40; step++) {
      const now = T0 + step * 700;
      const would = statusLineState(pack, progress, now).word!;
      const options = { ...plain, paneOpen: true, outstanding: true };
      const panel = renderPanel(pack, progress, now, options).join("\n");
      const line = renderStatusLine(pack, progress, now, options);
      for (const rendered of [panel, line]) expect(rendered).not.toContain(would.gloss);
      expect(panel).toContain("on the pane");
      expect(line).toContain("in the pane");
      // …and it does not offer commands that pane would refuse.
      expect(panel).not.toContain("/lingo skip");
      expect(panel).not.toContain("/lingo show it");
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

  // A public export should not overflow whatever width it is handed, even one the
  // CLI would never pass.
  it("never exceeds the width it is given, however small", () => {
    for (let width = 1; width <= 20; width++) {
      for (const line of renderPanel(pack, seeded(), T0, { ...plain, width })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
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


