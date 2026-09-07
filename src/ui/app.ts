import { applyAnswer, buildCard, isCorrect, makeRng, selectNext, stats } from "../srs.js";
import type {
  AgentState,
  Card,
  ItemProgress,
  Pack,
  Progress,
  Settings,
  Word,
} from "../types.js";

export type Mode = "waiting" | "teach" | "question" | "feedback" | "caughtup" | "quit";

export interface Key {
  /** The character typed, if it was a printable one. */
  ch?: string;
  /** A named key: `enter`, `space`, `backspace`, `escape`, `ctrl-c`. */
  name?: string;
}

export type Event =
  | { type: "agent"; state: AgentState }
  | { type: "key"; key: Key }
  | { type: "tick"; now: number }
  | { type: "enriched"; wordId: string; text: string }
  | { type: "enrichFailed"; wordId: string; message: string }
  | { type: "problem"; message: string | null };

export type Effect =
  | { type: "save"; progress: Progress }
  | { type: "enrich"; word: Word }
  | { type: "quit" };

export interface AppState {
  mode: Mode;
  agent: AgentState;
  card: Card | null;
  progress: Progress;
  settings: Settings;
  /** In-progress text for a `recall` card. */
  input: string;
  lastCorrect: boolean | null;
  /** What the user actually answered, echoed back on the feedback screen. */
  lastAnswer: string;
  /** Memory hook from Claude, keyed to the current card's word. */
  enrichment: string | null;
  enrichPending: boolean;
  /** Transient one-line message under the card. */
  message: string | null;
  /**
   * The mode to restore when the agent starts working again. Never `feedback`:
   * a card that has already been graded must not come back as a live question.
   */
  resumeMode: Mode | null;
  /** A problem the user needs to know about, shown until it is resolved. */
  problem: string | null;
  /** Set when a memory hook could not be fetched, so `e` can be pressed again. */
  enrichError: string | null;
  showHelp: boolean;
  now: number;
  /** Bumped on every card so the renderer can tell two identical frames apart. */
  seq: number;
}

export interface Step {
  state: AppState;
  effects: Effect[];
}

/** Quizzing only happens while the agent is working — unless the user opted in. */
export function isActive(state: AppState): boolean {
  return state.agent === "busy" || state.settings.alwaysOn;
}

export function createState(
  pack: Pack,
  progress: Progress,
  settings: Settings,
  agent: AgentState,
  now: number,
): AppState {
  return {
    mode: "waiting",
    agent,
    card: null,
    progress,
    settings,
    input: "",
    lastCorrect: null,
    lastAnswer: "",
    enrichment: null,
    enrichPending: false,
    message: null,
    resumeMode: null,
    problem: null,
    enrichError: null,
    showHelp: false,
    now,
    seq: 0,
  };
}

function rngFor(state: AppState): () => number {
  // A fixed seed makes runs reproducible for tests; otherwise vary per card so the
  // same word does not always come with the same three distractors.
  const seed = process.env.CLAUDELINGO_SEED
    ? Number(process.env.CLAUDELINGO_SEED) + state.seq
    : Date.now() + state.seq;
  return makeRng(seed);
}

/** Load the next due (or new) card, or fall through to the caught-up screen. */
function advance(state: AppState, pack: Pack, now: number): AppState {
  const next = selectNext(pack, state.progress, state.settings, now);
  const base: AppState = {
    ...state,
    now,
    input: "",
    lastCorrect: null,
    lastAnswer: "",
    enrichment: null,
    enrichPending: false,
    enrichError: null,
    resumeMode: null,
    seq: state.seq + 1,
  };
  if (!next) return { ...base, mode: "caughtup", card: null };
  const card = buildCard(pack, next.word, next.item, rngFor(base));
  return { ...base, mode: card.kind === "teach" ? "teach" : "question", card };
}

function grade(state: AppState, pack: Pack, response: { choice?: number; text?: string }): Step {
  const card = state.card;
  if (!card) return { state, effects: [] };
  const correct = isCorrect(card, response);
  const progress = applyAnswer(state.progress, card.word, card, correct, state.now);
  const answer =
    response.text !== undefined
      ? response.text
      : (card.choices[response.choice ?? -1] ?? "");
  return {
    state: {
      ...state,
      mode: "feedback",
      progress,
      lastCorrect: correct,
      lastAnswer: answer,
      input: "",
      message: null,
    },
    effects: [{ type: "save", progress }],
  };
}

const SKIP_DELAY_MS = 10 * 60_000;

/**
 * A skip costs nothing but a delay — punishing it would poison the box levels.
 *
 * A word being seen for the first time has no progress row yet, so one is created
 * in the `new` stage. Without it `selectNext` would just hand back the same word
 * and the "skipped" message would be a lie.
 */
function skip(state: AppState, pack: Pack): Step {
  const card = state.card;
  if (!card) return { state, effects: [] };
  const existing = state.progress.items[card.word.id];
  const deferred: ItemProgress = existing
    ? { ...existing, due: state.now + SKIP_DELAY_MS }
    : {
        id: card.word.id,
        stage: "new",
        box: 0,
        step: 0,
        due: state.now + SKIP_DELAY_MS,
        lastSeen: 0,
        seen: 0,
        correct: 0,
        lapses: 0,
      };
  const progress: Progress = {
    ...state.progress,
    items: { ...state.progress.items, [card.word.id]: deferred },
  };
  const next = advance({ ...state, progress }, pack, state.now);
  return {
    state: { ...next, message: `skipped ${card.word.term}` },
    effects: [{ type: "save", progress }],
  };
}

const CONFIRM_KEYS = new Set(["enter", "space"]);

export function reduce(state: AppState, event: Event, pack: Pack): Step {
  switch (event.type) {
    case "tick": {
      const next = { ...state, now: event.now };
      // A caught-up or waiting screen should notice the moment a card falls due.
      if (isActive(next) && (next.mode === "caughtup" || next.mode === "waiting")) {
        const ready = selectNext(pack, next.progress, next.settings, event.now);
        if (ready) return { state: advance(next, pack, event.now), effects: [] };
        if (next.mode === "waiting") return { state: { ...next, mode: "caughtup" }, effects: [] };
      }
      return { state: next, effects: [] };
    }

    case "agent": {
      if (event.state === state.agent) return { state, effects: [] };
      const next = { ...state, agent: event.state };
      if (event.state === "busy") {
        // Put back exactly the screen the user was on, and only if it was an
        // unanswered card. A graded card resumed as a question would be answered
        // twice, double-counting `seen` and double-promoting the box.
        if (state.card && state.resumeMode && next.mode === "waiting") {
          return { state: { ...next, mode: state.resumeMode, resumeMode: null }, effects: [] };
        }
        if (next.mode === "waiting" || next.mode === "caughtup") {
          return { state: advance(next, pack, next.now), effects: [] };
        }
        return { state: next, effects: [] };
      }
      // Agent went idle: stand down unless the user asked to keep practising.
      if (next.settings.alwaysOn) return { state: next, effects: [] };
      const resumable = next.mode === "teach" || next.mode === "question";
      return {
        state: {
          ...next,
          mode: "waiting",
          message: null,
          resumeMode: resumable ? next.mode : null,
        },
        effects: [],
      };
    }

    case "enriched": {
      if (state.card?.word.id !== event.wordId) return { state, effects: [] };
      return {
        state: { ...state, enrichment: event.text, enrichPending: false, enrichError: null },
        effects: [],
      };
    }

    case "enrichFailed": {
      if (state.card?.word.id !== event.wordId) return { state, effects: [] };
      // enrichment stays null so `e` works again — a blip must not lock the card.
      return { state: { ...state, enrichPending: false, enrichError: event.message }, effects: [] };
    }

    case "problem":
      return { state: { ...state, problem: event.message }, effects: [] };

    case "key":
      return reduceKey(state, event.key, pack);

    default:
      return { state, effects: [] };
  }
}

function reduceKey(state: AppState, key: Key, pack: Pack): Step {
  if (key.name === "ctrl-c") {
    return { state: { ...state, mode: "quit" }, effects: [{ type: "quit" }] };
  }

  const typing = state.mode === "question" && state.card?.choices.length === 0;

  if (state.showHelp) {
    return { state: { ...state, showHelp: false }, effects: [] };
  }

  // Global shortcuts, suppressed while the user is typing a recall answer so that
  // "q", "s" and "p" reach the input box instead of the command handler.
  if (!typing) {
    if (key.ch === "q") return { state: { ...state, mode: "quit" }, effects: [{ type: "quit" }] };
    if (key.ch === "?") return { state: { ...state, showHelp: true }, effects: [] };
    if (key.ch === "p") {
      const settings = { ...state.settings, alwaysOn: !state.settings.alwaysOn };
      const next: AppState = {
        ...state,
        settings,
        message: settings.alwaysOn ? "practice mode on" : "practice mode off",
      };
      if (settings.alwaysOn && next.mode === "waiting") {
        return { state: { ...advance(next, pack, next.now), message: next.message }, effects: [] };
      }
      if (!settings.alwaysOn && next.agent === "idle") {
        return { state: { ...next, mode: "waiting" }, effects: [] };
      }
      return { state: next, effects: [] };
    }
    if (key.ch === "s" && (state.mode === "teach" || state.mode === "question")) {
      return skip(state, pack);
    }
    if (key.ch === "e" && state.card && state.settings.enrich) {
      if (state.enrichment || state.enrichPending) return { state, effects: [] };
      return {
        state: { ...state, enrichPending: true, enrichError: null },
        effects: [{ type: "enrich", word: state.card.word }],
      };
    }
  }

  switch (state.mode) {
    case "waiting":
      return { state, effects: [] };

    case "caughtup":
      return { state, effects: [] };

    case "teach": {
      if (!CONFIRM_KEYS.has(key.name ?? "")) return { state, effects: [] };
      const card = state.card;
      if (!card) return { state, effects: [] };
      const progress = applyAnswer(state.progress, card.word, card, true, state.now);
      const next = advance({ ...state, progress }, pack, state.now);
      return { state: next, effects: [{ type: "save", progress }] };
    }

    case "question": {
      const card = state.card;
      if (!card) return { state, effects: [] };
      if (card.choices.length) {
        if (!key.ch) return { state, effects: [] };
        const choice = Number(key.ch) - 1;
        if (!Number.isInteger(choice) || choice < 0 || choice >= card.choices.length) {
          return { state, effects: [] };
        }
        return grade(state, pack, { choice });
      }
      if (key.name === "enter") {
        if (!state.input.trim()) return { state, effects: [] };
        return grade(state, pack, { text: state.input });
      }
      if (key.name === "backspace") {
        return { state: { ...state, input: state.input.slice(0, -1) }, effects: [] };
      }
      if (key.name === "escape") {
        // Clear a half-typed answer; a second press skips the card entirely, which
        // is otherwise unreachable while shortcuts are suppressed for typing.
        if (state.input) return { state: { ...state, input: "" }, effects: [] };
        return skip(state, pack);
      }
      if (key.name === "space") return { state: { ...state, input: `${state.input} ` }, effects: [] };
      if (key.ch) return { state: { ...state, input: state.input + key.ch }, effects: [] };
      return { state, effects: [] };
    }

    case "feedback": {
      if (!CONFIRM_KEYS.has(key.name ?? "")) return { state, effects: [] };
      return { state: advance(state, pack, state.now), effects: [] };
    }

    default:
      return { state, effects: [] };
  }
}

export function summary(pack: Pack, state: AppState) {
  return stats(pack, state.progress, state.now);
}

export type { Card };
