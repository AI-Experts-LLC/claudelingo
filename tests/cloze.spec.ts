/**
 * Blanking a word out of its own sentence.
 *
 * Carried over from the CLI's suite unchanged but for its imports: `cloze.ts`
 * survived the move to a mod, and so does the reasoning behind every case here.
 */
import { describe, expect, it } from "vitest";
import { BLANK, blankTerm, canCloze } from "../hooks/cloze";

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

  it("finds words in scripts written without spaces", () => {
    // Every letter beside の is another word's, so the spaced rule kept two
    // Japanese examples in a hundred.
    expect(blankTerm("これは私の本です。", "の")).toBe(`これは私${BLANK}本です。`);
    expect(blankTerm("毎日、本を読む。", "毎日")).toBe(`${BLANK}、本を読む。`);
    expect(blankTerm("ฉันกินข้าวทุกวัน", "กิน")).toBe(`ฉัน${BLANK}ข้าวทุกวัน`);
  });

  it("still leaves a word alone when it is only part of another, without spaces", () => {
    // A substring test would blank 年 out of 来年 and の out of もの.
    expect(canCloze("私は来年、日本に行く。", "年")).toBe(false);
    expect(blankTerm("これは私のものだ", "の")).toBe(`これは私${BLANK}ものだ`);
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
      ["これは私のものだ", "の"],
      ["私は来年、日本に行く。", "年"],
    ] as const) {
      const blanked = blankTerm(text, term);
      expect(canCloze(text, term), `${term} in "${text}"`).toBe(blanked !== text);
      if (canCloze(text, term)) expect(blanked).toContain(BLANK);
    }
  });
});
