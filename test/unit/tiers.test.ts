import { describe, expect, it } from "vitest";
import { TIERS, standing } from "../../src/ui/tiers.js";

describe("where you stand", () => {
  it("has the thresholds it says it has", () => {
    // Named outright: half of these were unpinned, so a threshold could move
    // without a single test noticing.
    expect(TIERS.map((t) => [t.name, t.at])).toEqual([
      ["just arrived", 0],
      ["first words", 10],
      ["finding your feet", 50],
      ["getting by", 100],
      ["holding a conversation", 250],
      ["comfortable", 500],
      ["most of a day's speech", 1000],
    ]);
    // …and they only ever go up.
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i]!.at).toBeGreaterThan(TIERS[i - 1]!.at);
    }
  });

  it("names the tier you have actually reached, not the next one", () => {
    expect(standing(0).tier.name).toBe("just arrived");
    expect(standing(9).tier.name).toBe("just arrived");
    expect(standing(10).tier.name).toBe("first words");
    expect(standing(249).tier.name).toBe("getting by");
    expect(standing(250).tier.name).toBe("holding a conversation");
  });

  it("says how many words are left, which is the number that motivates", () => {
    expect(standing(90).next?.at).toBe(100);
    expect(standing(90).toGo).toBe(10);
    expect(standing(100).toGo).toBe(150);
  });

  it("tops out without pretending there is more above", () => {
    const top = TIERS[TIERS.length - 1]!;
    const done = standing(top.at + 500);
    expect(done.tier).toEqual(top);
    expect(done.next).toBeNull();
    expect(done.toGo).toBe(0);
    expect(done.progress).toBe(1);
  });

  it("survives a count that is not a sensible number", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, 3.7]) {
      const s = standing(bad);
      expect(s.tier).toBeTruthy();
      expect(s.progress).toBeGreaterThanOrEqual(0);
      expect(s.progress).toBeLessThanOrEqual(1);
    }
  });
});
