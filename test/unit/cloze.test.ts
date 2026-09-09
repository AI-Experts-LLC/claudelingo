import { describe, expect, it } from "vitest";
import { BLANK, blankTerm, canCloze } from "../../src/cloze.js";

describe("blanking a word out of its sentence", () => {
  it("blanks every occurrence, not just the first", () => {
    // One left behind is the answer printed beside its own gap.
    const out = blankTerm("La casa grande y la casa pequeña", "casa");
    expect(out).toBe(`La ${BLANK} grande y la ${BLANK} pequeña`);
    expect(out.toLowerCase()).not.toContain("casa");
  });

  it("leaves a word alone when it is only part of another", () => {
    expect(blankTerm("Este es mi libro", "es")).toBe(`Este ${BLANK} mi libro`);
    expect(blankTerm("Los sonidos son fuertes", "son")).toBe(`Los sonidos ${BLANK} fuertes`);
  });

  it("counts an accented letter as part of a word, which \\b does not", () => {
    expect(blankTerm("Está más allá", "má")).toBe("Está más allá");
    expect(blankTerm("Está más allá", "más")).toBe(`Está ${BLANK} allá`);
  });

  it("matches whatever case the sentence starts with", () => {
    expect(blankTerm("Casa mía, casa tuya", "casa")).toBe(`${BLANK} mía, ${BLANK} tuya`);
  });

  it("treats a term with regex characters as text", () => {
    expect(blankTerm("el c++ es raro", "c++")).toBe(`el ${BLANK} es raro`);
    expect(blankTerm("a.b y axb", "a.b")).toBe(`${BLANK} y axb`);
  });

  it("agrees with itself about what can be blanked", () => {
    // The guard and the blanker are the same question asked twice; when they
    // disagreed, a sentence passed the guard and was asked with the answer in it.
    for (const [text, term] of [
      ["Los sonidos altos", "son"],
      ["Este libro", "es"],
      ["La casa", "casa"],
      ["Casa mía", "casa"],
      ["nothing here", "casa"],
      ["", "casa"],
    ] as const) {
      const blanked = blankTerm(text, term);
      expect(canCloze(text, term), `${term} in "${text}"`).toBe(blanked !== text);
      if (canCloze(text, term)) expect(blanked).toContain(BLANK);
    }
  });
});
