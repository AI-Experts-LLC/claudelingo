import { describe, expect, it } from "vitest";
import { PLAIN, box, renderFrame, visibleWidth, wrap } from "../../src/ui/render.js";
import { COLOR } from "../../src/ui/render.js";
import { createState, reduce } from "../../src/ui/app.js";
import { MASCOT_HEIGHT, MASCOT_WIDTH, owl } from "../../src/ui/mascot.js";
import type { AppState, Event } from "../../src/ui/app.js";
import { materialize } from "../../src/packs/index.js";
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
    expect(text).toContain("then enter");
  });

  it("renders the help overlay", () => {
    const text = frame(drive(busy(), [{ type: "key", key: { ch: "?" } }])).join("\n");
    expect(text).toContain("keys");
    expect(text).toContain("hint about it");
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

describe("the title bar", () => {
  it("marks practice mode in the title, not only in the body message", () => {
    // The body message is transient; the title is what tells you, at a glance and
    // for as long as it lasts, that cards are running with no agent working.
    const state = drive(idle(), [{ type: "key", key: { ch: "p" } }]);
    const title = frame(state)[0] as string;
    expect(title).toContain("practice");
    expect(title).toContain("agent idle");
  });

  it("shows the agent as working without a practice marker when it really is", () => {
    const title = frame(busy())[0] as string;
    expect(title).toContain("agent working");
    expect(title).not.toContain("practice");
  });
});

describe("caught up", () => {
  it("moves from waiting to caught up on a tick when nothing is due", () => {
    const full: Progress = { ...testProgress(), items: {} };
    for (let i = 1; i <= 8; i++) {
      full.items[`xx:${i}`] = {
        id: `xx:${i}`, stage: "learning", box: 1, step: 0,
        due: T0 + 30 * MINUTE, lastSeen: T0, seen: 1, correct: 1, lapses: 0,
      };
    }
    // Practice mode makes the pane active without an agent, so the tick path is
    // the only thing that can move it off "waiting".
    const state = createState(pack, full, testSettings({ alwaysOn: true }), "idle", T0);
    expect(state.mode).toBe("waiting");
    const ticked = drive(state, [{ type: "tick", now: T0 + MINUTE }]);
    expect(ticked.mode).toBe("caughtup");
    expect(frame(ticked).join("\n")).toContain("All caught up");
  });
});

describe("problems on screen", () => {
  it("renders every live problem, not just the first", () => {
    // The keyed-problems guarantee is only worth anything if the frame shows all
    // of them; one clearing must never hide another that is still true.
    let state = busy();
    state = drive(state, [
      { type: "problem", key: "save", message: "progress is not saving: ENOSPC" },
      { type: "problem", key: "codex", message: "Codex turns not detected: EACCES" },
      { type: "problem", key: "lock", message: "could not take the single-pane lock" },
    ]);
    const text = frame(state, 72).join("\n");
    expect(text).toContain("not saving");
    expect(text).toContain("Codex turns not detected");
    expect(text).toContain("single-pane lock");
  });

  it("drops only the problem that cleared", () => {
    let state = busy();
    state = drive(state, [
      { type: "problem", key: "save", message: "progress is not saving: ENOSPC" },
      { type: "problem", key: "codex", message: "Codex turns not detected: EACCES" },
      { type: "problem", key: "save", message: null },
    ]);
    const text = frame(state, 72).join("\n");
    expect(text).not.toContain("not saving");
    expect(text).toContain("Codex turns not detected");
  });

  // A language switch on the very first run can quarantine a deck. That notice
  // is the one message a user must not have to press enter to discover.
  it.each(["welcome", "howItWorks"] as const)("shows a deck problem on the %s screen", (mode) => {
    let state = createState(pack, testProgress(), testSettings({ onboarded: false }), "idle", T0);
    if (mode === "howItWorks") state = { ...state, mode: "howItWorks" };
    state = drive(state, [
      { type: "problem", key: "deck", message: "kept a copy at progress-fr.json.corrupt-1" },
    ]);
    expect(state.mode).toBe(mode);
    const text = frame(state, 72).join("\n");
    expect(text).toContain("kept a copy at progress-fr.json.corrupt-1");
    // …and still no stats panel, which is what onboarding suppresses.
    expect(text).not.toContain("learned ");
  });

  it("shows a problem exactly once on the picker, which draws its own", () => {
    let state = createState(pack, testProgress(), testSettings({ onboarded: false }), "idle", T0);
    state = drive(state, [
      { type: "problem", key: "deck", message: "kept a copy at progress-fr.json.corrupt-1" },
      { type: "key", key: { name: "enter" } },
    ]);
    expect(state.mode).toBe("pickLanguage");
    const hits = frame(state, 72).filter((line) => line.includes("corrupt-1"));
    expect(hits).toHaveLength(1);
  });

  it("keeps the panel exact even with several wrapped problems", () => {
    let state = busy();
    state = drive(state, [
      { type: "problem", key: "deck", message: "a".repeat(120) },
      { type: "problem", key: "save", message: "b".repeat(90) },
    ]);
    for (const line of frame(state, 48)) expect(visibleWidth(line)).toBe(48);
  });
});

describe("truncation of wide titles", () => {
  it("pads back the column a clipped wide glyph would leave short", () => {
    // Without the pad-back, cutting a two-column glyph in half leaves the border
    // one column adrift.
    const lines = box(["x"], { width: 20, title: "日".repeat(30), footer: "f", theme: PLAIN });
    for (const line of lines) expect(visibleWidth(line)).toBe(20);
  });
});

describe("the owl", () => {
  it("appears beside the text without moving it as the mood changes", () => {
    // Fixed gutter: the words must not shift about as the expression changes.
    const columnOf = (state: AppState) => {
      const line = frame(state, 60).find((l) => /Standing by|new word|correct|Want a quiz/.test(l));
      return line?.indexOf(line.trim().split(/\s{2,}/).at(-1) as string);
    };
    const waiting = idle();
    const teaching = busy();
    expect(columnOf(waiting)).toBe(columnOf(teaching));
  });

  it("sleeps while the agent is idle and watches while a card is up", () => {
    expect(frame(idle(), 60).join("\n")).toContain("(-.-)");
    expect(frame(busy(), 60).join("\n")).toContain("(o.o)");
  });

  it("reacts to the answer", () => {
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
    const right = String((state.card?.answerIndex ?? 0) + 1);
    const wrong = String((((state.card?.answerIndex ?? 0) + 1) % 4) + 1);

    expect(frame(drive(state, [{ type: "key", key: { ch: right } }]), 60).join("\n")).toContain("(^.^)");
    expect(frame(drive(state, [{ type: "key", key: { ch: wrong } }]), 60).join("\n")).toContain("(o.O)");
  });

  it("steps aside on a pane too narrow to hold it", () => {
    // The words matter more than the bird.
    const narrow = frame(busy(), 28).join("\n");
    expect(narrow).not.toContain("(o.o)");
    expect(narrow).toContain("new word");
  });

  it("never breaks the panel, at any width or mood", () => {
    const offering = drive(
      createState(pack, testProgress(), testSettings({ askFirst: true }), "idle", T0),
      [{ type: "agent", state: "busy" }],
    );
    for (const state of [idle(), busy(), offering]) {
      for (const width of [24, 30, 40, 56, 80, 120]) {
        for (const line of frame(state, width)) expect(visibleWidth(line)).toBe(width);
      }
    }
  });
});

describe("the offer screen", () => {
  it("says what is happening and what the keys do", () => {
    const state = drive(
      createState(pack, testProgress(), testSettings({ askFirst: true }), "idle", T0),
      [{ type: "agent", state: "busy" }],
    );
    const text = frame(state, 60).join("\n");
    expect(text).toContain("Claude is working");
    expect(text).toContain("Want a quiz?");
    expect(text).toContain("yes, go on");
    expect(text).toContain("not now");
    expect(text).toContain("(o.-)");
  });

  it("says how much is waiting", () => {
    const due: Progress = {
      ...testProgress(),
      items: {
        "xx:1": {
          id: "xx:1", stage: "review", box: 2, step: 0,
          due: T0 - MINUTE, lastSeen: T0, seen: 4, correct: 4, lapses: 0,
        },
        "xx:2": {
          id: "xx:2", stage: "review", box: 2, step: 0,
          due: T0 - MINUTE, lastSeen: T0, seen: 4, correct: 4, lapses: 0,
        },
      },
    };
    const state = drive(
      createState(pack, due, testSettings({ askFirst: true }), "idle", T0),
      [{ type: "agent", state: "busy" }],
    );
    expect(frame(state, 60).join("\n")).toContain("2 cards ready");
  });
});

describe("the mascot's shape", () => {
  it("gives every mood the same footprint", () => {
    // The gutter is fixed so the text beside it never shifts; that only holds if
    // every line of every mood is padded to the same width.
    for (const mood of ["asleep", "watching", "asking", "happy", "oops", "proud"] as const) {
      const art = owl(mood);
      expect(art, mood).toHaveLength(MASCOT_HEIGHT);
      for (const line of art) {
        expect([...line].length, `${mood}: ${JSON.stringify(line)}`).toBe(MASCOT_WIDTH);
      }
    }
  });

  it("is plain ASCII, so it survives a terminal without unicode", () => {
    for (const mood of ["asleep", "watching", "asking", "happy", "oops", "proud"] as const) {
      for (const line of owl(mood)) {
        // eslint-disable-next-line no-control-regex
        expect(line, mood).toMatch(/^[\x20-\x7e]*$/);
      }
    }
  });
});

describe("a sentence card in the pane", () => {
  const sentencePack = materialize({
    code: "xx",
    name: "Testish",
    englishName: "Testish",
    words: [
      ["casa", "house", "noun", "feminine", "La casa blanca es muy grande hoy | The white house is very big today"],
      ["perro", "dog", "noun"],
      ["gato", "cat", "noun"],
      ["libro", "book", "noun"],
    ],
  });

  function clozeState(): AppState {
    const word = sentencePack.words[0]!;
    const progress = testProgress();
    progress.items[word.id] = {
      id: word.id, stage: "review", box: 4, step: 0,
      due: T0 - 1000, lastSeen: T0, seen: 5, correct: 4, lapses: 0,
    };
    // Idle first, then busy: the card is dealt on the transition.
    const base = createState(sentencePack, progress, testSettings({ alwaysOn: true }), "idle", T0);
    return reduce(base, { type: "agent", state: "busy" }, sentencePack).state;
  }

  it("shows the sentence with the gap, not 'spell the word for'", () => {
    const state = clozeState();
    expect(state.card?.kind).toBe("cloze");
    const text = renderFrame(state, sentencePack, 60, PLAIN).join("\n");
    expect(text).toContain("which word fills the gap?");
    expect(text).toContain("____");
    expect(text).not.toContain("spell the word for");
    // The gap is genuinely blank: the word is not sitting in its own sentence…
    const sentence = text.split("\n").find((line) => line.includes("____"))!;
    expect(sentence.toLowerCase()).not.toContain("casa");
    // …the translation is not shown, because it says "house" and that is the answer…
    expect(text).not.toContain("white house");
    // …and the answer is among the options exactly once.
    expect(text.match(/casa/g)).toHaveLength(1);
  });

  it("shows the sentence and what it means once the answer is in", () => {
    const answered = drive(clozeState(), [{ type: "key", key: { ch: "2" } }]);
    expect(answered.mode).toBe("feedback");
    const text = renderFrame(answered, sentencePack, 60, PLAIN).join("\n");
    expect(text).toContain("blanca es muy grande");
    expect(text).toContain("white house");
  });

  it("wraps a long sentence instead of clipping it", () => {
    const state = clozeState();
    for (const width of [40, 50, 60, 80]) {
      const lines = renderFrame(state, sentencePack, width, PLAIN);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      // The whole sentence survives somewhere in the frame.
      const flat = lines.join(" ").replace(/\s+/g, " ");
      expect(flat).toContain("blanca es muy grande hoy");
    }
  });
});

describe("the screens you can put over the pane", () => {
  function met(count: number): AppState {
    const progress = testProgress();
    for (const word of pack.words.slice(0, count)) {
      progress.items[word.id] = {
        id: word.id, stage: "review", box: 2, step: 0,
        due: T0, lastSeen: T0, seen: 4, correct: 3, lapses: 0,
      };
    }
    return { ...busy(), progress };
  }

  it("says where you stand, in words rather than a bare number", () => {
    const state = drive(met(12), [{ type: "key", key: { ch: "t" } }]);
    expect(state.screen).toBe("stats");
    const text = frame(state, 72).join("\n");
    expect(text).toContain("first words");
    // The number that motivates is the one still to go.
    expect(text).toContain('more for "finding your feet"');
    expect(text).toContain("words met");
  });

  it("lists the words you have met, commonest first, with how you are doing", () => {
    const state = drive(met(3), [{ type: "key", key: { ch: "w" } }]);
    expect(state.screen).toBe("words");
    const text = frame(state, 72).join("\n");
    for (const word of pack.words.slice(0, 3)) {
      expect(text).toContain(word.term);
      expect(text).toContain(`#${word.rank}`);
    }
    // 3 of 4 right on each.
    expect(text).toContain("75%");
    expect(text).toContain("1–3 of 3");
  });

  it("shows nothing but an invitation before you have met any", () => {
    const state = drive(busy(), [{ type: "key", key: { ch: "w" } }]);
    expect(frame(state, 72).join("\n")).toContain("None yet");
  });

  it("walks a long list a page at a time, and stops at the top", () => {
    const all = pack.words.length;
    expect(all).toBeGreaterThan(8); // or there is nothing to walk
    let state = drive(met(all), [{ type: "key", key: { ch: "w" } }]);
    expect(frame(state, 72).join("\n")).toContain(`1–8 of ${all}`);
    state = drive(state, [{ type: "key", key: { name: "down" } }]);
    expect(frame(state, 72).join("\n")).toContain(`7–${Math.min(14, all)} of ${all}`);
    state = drive(state, [{ type: "key", key: { name: "up" } }, { type: "key", key: { name: "up" } }]);
    // Walking back past the beginning must not scroll off it.
    expect(state.wordsFrom).toBe(0);
    expect(frame(state, 72).join("\n")).toContain(`1–8 of ${all}`);
  });

  it("closes on any other key, and the walkthrough keeps them out entirely", () => {
    const open = drive(met(3), [{ type: "key", key: { ch: "t" } }]);
    expect(drive(open, [{ type: "key", key: { ch: "x" } }]).screen).toBeNull();

    const firstRun = createState(pack, testProgress(), testSettings({ onboarded: false }), "idle", T0);
    expect(drive(firstRun, [{ type: "key", key: { ch: "t" } }]).screen).toBeNull();
    expect(drive(firstRun, [{ type: "key", key: { ch: "w" } }]).screen).toBeNull();
  });

  it("keeps the panel exactly as wide as it should be", () => {
    for (const screen of ["t", "w"] as const) {
      const state = drive(met(pack.words.length), [{ type: "key", key: { ch: screen } }]);
      for (const width of [40, 56, 72, 100]) {
        for (const line of frame(state, width)) expect(visibleWidth(line)).toBe(width);
      }
    }
  });
});
