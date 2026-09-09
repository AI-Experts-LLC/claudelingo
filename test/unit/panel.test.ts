import { describe, expect, it } from "vitest";
import {
  DRILL_MS,
  PANEL_ROWS,
  drillAt,
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

describe("the drill the panel runs while it waits", () => {
  function due(): Progress {
    const progress = testProgress();
    for (const word of pack.words) {
      progress.items[word.id] = {
        id: word.id, stage: "review", box: 2, step: 0,
        due: T0 - 5000, lastSeen: T0, seen: 4, correct: 3, lapses: 0,
      };
    }
    progress.streak = 6;
    return progress;
  }

  it("asks a real question and marks it only after the pause", () => {
    const progress = due();
    const start = Math.ceil(T0 / DRILL_MS) * DRILL_MS;
    const asking = drillAt(pack, progress, start);
    expect(asking?.revealed).toBe(false);

    // Through the whole asking phase the answer is not marked anywhere.
    for (let at = 0; at < 6000; at += 250) {
      const frame = drillAt(pack, progress, start + at);
      expect(frame?.revealed, `revealed ${at}ms in`).toBe(false);
      const rows = renderPanel(pack, progress, start + at, plain).join("\n");
      expect(rows).not.toContain("✓");
    }
    // …and then it is.
    const revealed = drillAt(pack, progress, start + 6000);
    expect(revealed?.revealed).toBe(true);
    expect(renderPanel(pack, progress, start + 6000, plain).join("\n")).toContain("✓");
  });

  it("shows the same card and the same options to every run inside one window", () => {
    // The status line keeps no memory between runs. Two runs a second apart have
    // to agree by computing the same thing, or the card flickers as you look.
    const progress = due();
    const start = Math.ceil(T0 / DRILL_MS) * DRILL_MS;
    const first = drillAt(pack, progress, start);
    for (let at = 0; at < 6000; at += 500) {
      const again = drillAt(pack, progress, start + at);
      expect(again?.card.word.id).toBe(first?.card.word.id);
      expect(again?.card.choices).toEqual(first?.card.choices);
      expect(again?.card.answerIndex).toBe(first?.card.answerIndex);
    }
    // …and it does move on afterwards.
    const next = drillAt(pack, progress, start + DRILL_MS);
    expect(next?.card.word.id).not.toBe(first?.card.word.id);
  });

  // On a young deck most of the pool is words never seen, which build `teach`
  // cards with nothing to ask. Stopping at the first one meant the drill almost
  // never ran for the people with the most to learn.
  it("walks past a card with nothing to ask, to one that has something", () => {
    const progress = testProgress();
    const [first, second] = pack.words;
    expect(first && second).toBeTruthy();
    // Ranked first, and unaskable: a `new` item builds a teach card.
    progress.items[first!.id] = {
      id: first!.id, stage: "new", box: 0, step: 0,
      due: T0 - 9000, lastSeen: 0, seen: 0, correct: 0, lapses: 0,
    };
    // Ranked second, and askable.
    progress.items[second!.id] = {
      id: second!.id, stage: "learning", box: 1, step: 0,
      due: T0 - 1000, lastSeen: T0, seen: 2, correct: 2, lapses: 0,
    };

    // A window whose slot lands on the unaskable one.
    const base = Math.ceil(T0 / DRILL_MS) * DRILL_MS;
    let landed: number | null = null;
    for (let window = 0; window < 8; window++) {
      const at = base + window * DRILL_MS;
      if (Math.abs(Math.floor(at / DRILL_MS)) % 2 === 0) {
        landed = at;
        break;
      }
    }
    expect(landed).not.toBeNull();

    const drill = drillAt(pack, progress, landed!);
    expect(drill, "the drill gave up instead of looking past the teach card").not.toBeNull();
    expect(drill!.card.word.id).toBe(second!.id);
    expect(drill!.card.choices.length).toBeGreaterThan(1);
  });

  it("stands down for anything that is actually being answered", () => {
    const progress = due();
    const start = Math.ceil(T0 / DRILL_MS) * DRILL_MS;
    for (const options of [
      { pending: { question: "q", choices: ["a", "b"] } },
      { outstanding: true },
      { paneOpen: true },
    ]) {
      const rows = renderPanel(pack, progress, start, { ...plain, ...options }).join("\n");
      expect(rows).not.toContain("✓");
      expect(rows).not.toContain("thinking…");
    }
  });

  it("keeps its three rows and its width while drilling", () => {
    const progress = due();
    const start = Math.ceil(T0 / DRILL_MS) * DRILL_MS;
    for (const width of [30, 46, 60, 88, 120]) {
      for (const at of [0, 3000, 6500, 9500]) {
        const rows = renderPanel(pack, progress, start + at, { ...plain, width });
        expect(rows).toHaveLength(PANEL_ROWS);
        for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("the panel and the agent's state", () => {
  function due(): Progress {
    const progress = testProgress();
    for (const word of pack.words) {
      progress.items[word.id] = {
        id: word.id, stage: "review", box: 2, step: 0,
        due: T0 - 5000, lastSeen: T0, seen: 4, correct: 3, lapses: 0,
      };
    }
    return progress;
  }

  const start = Math.ceil(T0 / DRILL_MS) * DRILL_MS;

  it("drills while Claude works and settles when the turn comes back", () => {
    const progress = due();
    const busy = renderPanel(pack, progress, start, {
      ...plain,
      agent: { state: "busy", since: start - 20_000 },
    }).join("\n");
    expect(busy).toContain("while you wait");

    const idle = renderPanel(pack, progress, start, {
      ...plain,
      agent: { state: "idle", since: start },
    }).join("\n");
    // The moment the turn is yours again, the panel stops asking things of you.
    expect(idle).not.toContain("while you wait");
    expect(idle).toMatch(/«.+»/);
    expect(idle).toContain("/lingo");
  });

  it("keeps drilling when the user asked to practise regardless", () => {
    const progress = due();
    const rows = renderPanel(pack, progress, start, {
      ...plain,
      agent: { state: "idle", since: start },
      alwaysOn: true,
    }).join("\n");
    expect(rows).toContain("while you wait");
  });

  it("counts the cards this wait has been long enough for", () => {
    const progress = due();
    const first = renderPanel(pack, progress, start, {
      ...plain,
      agent: { state: "busy", since: start },
    }).join("\n");
    // One card in, there is nothing to boast about yet.
    expect(first).not.toMatch(/\d+ while you wait/);

    const later = renderPanel(pack, progress, start + 4 * DRILL_MS, {
      ...plain,
      agent: { state: "busy", since: start },
    }).join("\n");
    expect(later).toContain("5 while you wait");
  });

  it("carries on as before when it cannot tell what the agent is doing", () => {
    // No hooks fired yet, or an unreadable status file: not knowing must not
    // silently stop the thing the product exists for.
    const rows = renderPanel(pack, due(), start, { ...plain, agent: null }).join("\n");
    expect(rows).toContain("while you wait");
  });

  it("shows a memory hook on the reveal, when one is already cached", () => {
    const progress = due();
    const hook = "«de» sounds like DEparting from somewhere";
    const revealed = renderPanel(pack, progress, start + 7000, {
      ...plain,
      agent: { state: "busy", since: start },
      hook,
    }).join("\n");
    expect(revealed).toContain("✓");
    expect(revealed).toContain("sounds like DEparting");
  });
});
