import { describe, expect, it } from "vitest";
import { WORD_MS, renderStatusLine, statusLineState } from "../../src/statusline.js";
import { loadPack } from "../../src/packs/index.js";
import type { ItemProgress, Progress } from "../../src/types.js";
import { MINUTE, T0, testPack, testProgress } from "../helpers.js";

const pack = testPack();

function withItems(entries: Array<Partial<ItemProgress> & { id: string }>): Progress {
  const items: Progress["items"] = {};
  for (const entry of entries) {
    items[entry.id] = {
      stage: "review", box: 2, step: 0, due: T0 - MINUTE,
      lastSeen: T0, seen: 4, correct: 3, lapses: 0, ...entry,
    };
  }
  return { ...testProgress(), items, streak: 5 };
}

/** A moment in the hidden half of a word's slot, and one in the revealed half. */
const hidden = Math.floor(T0 / WORD_MS) * WORD_MS + 1;
const shown = hidden + WORD_MS * 0.75;

describe("what the status line shows", () => {
  it("hides the meaning first, so there is something to retrieve", () => {
    const progress = withItems([{ id: "xx:1" }]);
    expect(statusLineState(pack, progress, hidden).revealed).toBe(false);
    const line = renderStatusLine(pack, progress, hidden, { color: false });
    expect(line).toContain("«uno»");
    expect(line).not.toContain("one");
    expect(line).toContain("= ?");
  });

  it("reveals it in the second half of the slot", () => {
    const progress = withItems([{ id: "xx:1" }]);
    expect(statusLineState(pack, progress, shown).revealed).toBe(true);
    const line = renderStatusLine(pack, progress, shown, { color: false });
    expect(line).toContain("«uno»");
    expect(line).toContain("one");
    expect(line).not.toContain("= ?");
  });

  it("moves on to another word in the next slot", () => {
    const progress = withItems([{ id: "xx:1" }, { id: "xx:2" }, { id: "xx:3" }]);
    const first = statusLineState(pack, progress, hidden).word?.id;
    const next = statusLineState(pack, progress, hidden + WORD_MS).word?.id;
    expect(first).toBeTruthy();
    expect(next).not.toBe(first);
  });

  it("shows progress and streak", () => {
    const line = renderStatusLine(pack, withItems([{ id: "xx:1" }]), hidden, { color: false });
    expect(line).toContain(`1/${pack.words.length}`);
    expect(line).toContain("streak 5");
  });

  it("prefers what is overdue over what is not yet due", () => {
    const progress = withItems([
      { id: "xx:4", due: T0 + 60 * MINUTE },
      { id: "xx:5", due: T0 - 30 * MINUTE },
    ]);
    // Only the overdue one is a candidate at this moment, so it must be shown.
    const ids = new Set<string>();
    for (let slot = 0; slot < 6; slot++) {
      ids.add(statusLineState(pack, progress, hidden + slot * WORD_MS).word?.id ?? "");
    }
    expect(ids.has("xx:5")).toBe(true);
  });

  it("teaches from the top of the deck when nothing has been learned yet", () => {
    const line = renderStatusLine(pack, testProgress(), hidden, { color: false });
    expect(line).toContain("«uno»");
    expect(line).toContain(`0/${pack.words.length}`);
  });

  it("says so when the deck is genuinely finished", () => {
    // Everything learned and nothing due: there is nothing to drill.
    const items: Progress["items"] = {};
    for (const word of pack.words) {
      items[word.id] = {
        id: word.id, stage: "review", box: 5, step: 0,
        due: T0 + 40 * 24 * 60 * MINUTE, lastSeen: T0, seen: 9, correct: 9, lapses: 0,
      };
    }
    const line = renderStatusLine(pack, { ...testProgress(), items }, hidden, { color: false });
    expect(line).toContain("all caught up");
  });

  it("never exceeds the width it is given", () => {
    const progress = withItems([{ id: "xx:1" }]);
    for (const width of [20, 30, 48, 80]) {
      const line = renderStatusLine(pack, progress, shown, { color: false, width });
      expect([...line].length).toBeLessThanOrEqual(width);
    }
  });

  it("emits colour only when asked", () => {
    const progress = withItems([{ id: "xx:1" }]);
    const esc = String.fromCharCode(27);
    expect(renderStatusLine(pack, progress, shown, { color: false })).not.toContain(esc);
    expect(renderStatusLine(pack, progress, shown, { color: true })).toContain(esc);
  });

  it("is a single line for every shipped language", () => {
    // Claude Code renders what it is given; a stray newline would push its own
    // footer around.
    for (const code of ["es", "fr", "it"]) {
      const real = loadPack(code);
      const line = renderStatusLine(real, testProgress(), shown, { color: false });
      expect(line).not.toContain("\n");
      expect(line.length).toBeGreaterThan(0);
    }
  });
});
