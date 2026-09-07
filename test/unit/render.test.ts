import { describe, expect, it } from "vitest";
import { PLAIN, box, renderFrame, visibleWidth, wrap } from "../../src/ui/render.js";
import { COLOR } from "../../src/ui/render.js";
import { createState, reduce } from "../../src/ui/app.js";
import type { AppState, Event } from "../../src/ui/app.js";
import type { Progress } from "../../src/types.js";
import { MINUTE, T0, testPack, testProgress, testSettings } from "../helpers.js";

const pack = testPack();
const WIDTH = 56;

function frame(state: AppState, width = WIDTH): string[] {
  return renderFrame(state, pack, width, PLAIN);
}

function drive(state: AppState, events: Event[]): AppState {
  let current = state;
  for (const event of events) current = reduce(current, event, pack).state;
  return current;
}

const idle = () => createState(pack, testProgress(), testSettings(), "idle", T0);
const busy = () => drive(idle(), [{ type: "agent", state: "busy" }]);

describe("layout primitives", () => {
  it("ignores colour codes when measuring width", () => {
    expect(visibleWidth(`${COLOR.bold}hi${COLOR.reset}`)).toBe(2);
  });

  it("wraps on word boundaries", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("splits a token longer than the line", () => {
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("draws a box whose every line is exactly the requested width", () => {
    const lines = box(["a", "bb"], { width: 30, title: "t", footer: "f", theme: PLAIN });
    for (const line of lines) expect(visibleWidth(line)).toBe(30);
  });

  it("truncates a title that will not fit", () => {
    const lines = box([], { width: 20, title: "x".repeat(80), footer: "f", theme: PLAIN });
    expect(visibleWidth(lines[0]!)).toBe(20);
  });
});

describe("frames", () => {
  it("keeps every line the panel width, in colour and in plain text", () => {
    for (const theme of [PLAIN, COLOR]) {
      const lines = renderFrame(busy(), pack, WIDTH, theme);
      for (const line of lines) expect(visibleWidth(line)).toBe(WIDTH);
    }
  });

  it("holds its shape at awkward widths", () => {
    for (const width of [20, 33, 40, 72, 120]) {
      const lines = frame(busy(), width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
  });

  it("says it is standing by while the agent is idle", () => {
    const text = frame(idle()).join("\n");
    expect(text).toContain("Standing by");
    expect(text).toContain("agent idle");
    expect(text).toContain("claudelingo");
  });

  it("shows the word, its gloss and its rank on a teach card", () => {
    const text = frame(busy()).join("\n");
    expect(text).toContain("new word");
    expect(text).toContain("uno");
    expect(text).toContain("one");
    expect(text).toContain("#1 most common word");
    expect(text).toContain("agent working");
  });

  it("numbers the choices on a question card", () => {
    const learned: Progress = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "learning", box: 1, step: 0,
          due: T0 - MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
        },
      },
    };
    const state = drive(createState(pack, learned, testSettings(), "idle", T0), [
      { type: "agent", state: "busy" },
    ]);
    const text = frame(state).join("\n");
    expect(text).toContain("what does");
    for (const n of [1, 2, 3, 4]) expect(text).toContain(`${n})`);
    expect(text).toContain("1-4 answer");
  });

  it("shows the answer and the next interval after a wrong guess", () => {
    const learned: Progress = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "learning", box: 1, step: 0,
          due: T0 - MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
        },
      },
    };
    let state = drive(createState(pack, learned, testSettings(), "idle", T0), [
      { type: "agent", state: "busy" },
    ]);
    const wrong = String((((state.card?.answerIndex ?? 0) + 1) % 4) + 1);
    state = drive(state, [{ type: "key", key: { ch: wrong } }]);
    const text = frame(state).join("\n");
    expect(text).toContain("not quite");
    expect(text).toContain("uno");
    expect(text).toContain("box 1/5");
    expect(text).toContain("space next");
  });

  it("echoes what the user is typing on a spell-it card", () => {
    const mastered: Progress = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "review", box: 5, step: 0,
          due: T0 - MINUTE, lastSeen: T0, seen: 9, correct: 9, lapses: 0,
        },
      },
    };
    let state = drive(createState(pack, mastered, testSettings(), "idle", T0), [
      { type: "agent", state: "busy" },
    ]);
    state = drive(state, [
      { type: "key", key: { ch: "u" } },
      { type: "key", key: { ch: "n" } },
    ]);
    const text = frame(state).join("\n");
    expect(text).toContain("spell the word");
    expect(text).toContain("> un");
    expect(text).toContain("enter submit");
  });

  it("renders the help overlay", () => {
    const text = frame(drive(busy(), [{ type: "key", key: { ch: "?" } }])).join("\n");
    expect(text).toContain("keys");
    expect(text).toContain("memory hook");
    expect(text).toContain("any key to close");
  });

  it("renders a memory hook once it arrives, wrapped to the panel", () => {
    const state = drive(busy(), [
      {
        type: "enriched",
        wordId: "xx:1",
        text: "uno is one, as in unicycle and unicorn and universal and unilateral",
      },
    ]);
    const lines = frame(state);
    expect(lines.join("\n")).toContain("unicycle");
    for (const line of lines) expect(visibleWidth(line)).toBe(WIDTH);
  });

  it("marks practice mode in the title bar", () => {
    const state = drive(idle(), [{ type: "key", key: { ch: "p" } }]);
    expect(frame(state).join("\n")).toContain("practice");
  });

  it("shows the caught-up screen with the next review time", () => {
    const full: Progress = { ...testProgress(), items: {} };
    for (let i = 1; i <= 8; i++) {
      full.items[`xx:${i}`] = {
        id: `xx:${i}`, stage: "learning", box: 1, step: 0,
        due: T0 + 30 * MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
      };
    }
    const state = drive(createState(pack, full, testSettings(), "idle", T0), [
      { type: "agent", state: "busy" },
    ]);
    const text = frame(state).join("\n");
    expect(text).toContain("All caught up");
    expect(text).toContain("Next review in 30m");
  });

  it("emits no colour codes under the plain theme", () => {
    const text = frame(busy()).join("\n");
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(new RegExp(String.fromCharCode(27)));
  });
});
