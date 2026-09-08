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

export type Mode =
  | "welcome"
  | "pickLanguage"
  | "howItWorks"
  | "waiting"
  | "offer"
  | "teach"
  | "question"
  | "feedback"
  | "caughtup"
  | "quit";

/** Every distinct thing that can go wrong and needs saying. */
export type ProblemKey =
  | "save"
  | "deck"
  | "settings"
  | "lock"
  /** The status file cannot be read, so the pane cannot see the agent. */
  | "status"
  /** The status file cannot be written, so Codex turns are never recorded. */
  | "statusWrite"
  | "codex"
  | "credentials"
  | "settings";

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
  | { type: "problem"; key: ProblemKey; message: string | null };

export type Effect =
  | { type: "save"; progress: Progress }
  | { type: "enrich"; word: Word }
  /** Load a different pack and deck, and remember the choice. */
  | { type: "language"; code: string }
  | { type: "settings"; settings: Settings }
  | { type: "quit" };

export interface LanguageChoice {
  code: string;
  englishName: string;
  words: number;
}

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
  /**
   * Live problems, keyed by source. A set rather than one slot: a failing save
   * must not erase a still-true "the Codex watcher is dead" notice, and fixing
   * one must not clear the other.
   */
  problems: Record<ProblemKey, string>;
  /** Set when a memory hook could not be fetched, so `e` can be pressed again. */
  enrichError: string | null;
  showHelp: boolean;
  now: number;
  /** Bumped on every card so the renderer can tell two identical frames apart. */
  seq: number;
  /** Every installed pack, for the picker. */
  languages: LanguageChoice[];
  /** Where to return after the language picker. */
  pickerReturn: Mode | null;
  /**
   * The user has said yes to quizzing during this run of the pane.
   *
   * Asked once rather than assumed: the pane appears on its own now, and jumping
   * straight into flashcards the moment someone starts a task is presumptuous.
   */
  consented: boolean;
  /** Said "not now" for the current burst of work. Cleared when the agent next starts. */
  declined: boolean;
}

export interface Step {
  state: AppState;
  effects: Effect[];
}

/** Screens that own the pane until the user has finished with them. */
export function isOnboarding(state: AppState): boolean {
  return state.mode === "welcome" || state.mode === "pickLanguage" || state.mode === "howItWorks";
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
  languages: LanguageChoice[] = [],
): AppState {
  return {
    // Someone opening this for the first time is shown what it is and asked what
    // they want to learn, rather than being handed a flashcard for a language
    // they never chose.
    mode: settings.onboarded ? "waiting" : "welcome",
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
    problems: {} as Record<ProblemKey, string>,
    enrichError: null,
    showHelp: false,
    now,
    seq: 0,
    languages,
    pickerReturn: null,
    // A pane the user launched themselves has already answered the question.
    consented: !settings.askFirst,
    declined: false,
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
      // The walkthrough is safe from this by construction: every branch below
      // acts only on `waiting` or `caughtup`, and its modes are neither. A guard
      // here would be unreachable, and mutation testing confirms no test could
      // tell whether it was present.
      // A caught-up or waiting screen should notice the moment a card falls due.
      // The agent may already have been working when the pane opened, so the
      // offer has to be reachable from a tick and not only from a transition.
      if (isActive(next) && !next.consented && !next.declined && next.mode === "waiting") {
        return { state: { ...next, mode: "offer" }, effects: [] };
      }
      if (
        isActive(next) &&
        next.consented &&
        (next.mode === "caughtup" || next.mode === "waiting")
      ) {
        const ready = selectNext(pack, next.progress, next.settings, event.now);
        if (ready) return { state: advance(next, pack, event.now), effects: [] };
        if (next.mode === "waiting") return { state: { ...next, mode: "caughtup" }, effects: [] };
      }
      return { state: next, effects: [] };
    }

    case "agent": {
      if (event.state === state.agent) return { state, effects: [] };
      if (isOnboarding(state)) return { state: { ...state, agent: event.state }, effects: [] };

      const next = { ...state, agent: event.state };
      if (event.state === "busy") {
        // A fresh burst of work is a fresh chance to offer.
        const fresh = { ...next, declined: false };
        // A card can only be on screen once consent was given, so there is
        // nothing here to protect it from — `p` records consent for exactly that
        // reason (see the `p` handler).
        if (!fresh.consented) {
          return { state: { ...fresh, mode: "offer" }, effects: [] };
        }
        // Put back exactly the screen the user was on, and only if it was an
        // unanswered card. A graded card resumed as a question would be answered
        // twice, double-counting `seen` and double-promoting the box.
        if (state.card && state.resumeMode && fresh.mode === "waiting") {
          return { state: { ...fresh, mode: state.resumeMode, resumeMode: null }, effects: [] };
        }
        if (fresh.mode === "waiting" || fresh.mode === "caughtup") {
          return { state: advance(fresh, pack, fresh.now), effects: [] };
        }
        return { state: fresh, effects: [] };
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

    case "problem": {
      const problems = { ...state.problems };
      if (event.message === null) delete problems[event.key];
      else problems[event.key] = event.message;
      return { state: { ...state, problems }, effects: [] };
    }

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
    if (key.ch === "l" && state.languages.length > 1) {
      // Reachable from every screen: changing language is the thing people most
      // often want and least often find.
      return {
        state: { ...state, mode: "pickLanguage", pickerReturn: state.mode },
        effects: [],
      };
    }
    if (key.ch === "p") {
      const settings = { ...state.settings, alwaysOn: !state.settings.alwaysOn };
      const next: AppState = {
        ...state,
        settings,
        // Asking to practise IS the answer to "want a quiz?". Without this the
        // next prompt the user submits replaces their card with the offer.
        consented: settings.alwaysOn ? true : state.consented,
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
    case "welcome": {
      if (!CONFIRM_KEYS.has(key.name ?? "") && key.ch !== "y") return { state, effects: [] };
      return { state: { ...state, mode: "pickLanguage", pickerReturn: null }, effects: [] };
    }

    case "pickLanguage": {
      const index = Number(key.ch) - 1;
      const chosen = state.languages[index];
      if (chosen) {
        // Choosing what is already showing is not a switch. Sending it through
        // the reload path releases and re-takes one lock file, and the release
        // deletes the file the new claim thinks it holds.
        if (chosen.code === state.settings.lang) {
          return {
            state: {
              ...state,
              // Mid-session this returns whence it came; during the first run
              // there is nothing behind it, and the walkthrough must reach its
              // last screen or the user lands nowhere and stays un-onboarded.
              mode: state.pickerReturn ?? (state.settings.onboarded ? "waiting" : "howItWorks"),
              pickerReturn: null,
              ...(state.settings.onboarded ? { message: `still ${chosen.englishName}` } : {}),
            },
            effects: [],
          };
        }
        // The runner owns the pack, the deck and the lock, and only it knows
        // whether the switch worked — so only it records the choice. Writing
        // `lang` here would persist a language the user never actually got.
        return { state, effects: [{ type: "language", code: chosen.code }] };
      }
      // Escape only backs out of a picker opened later; during onboarding there
      // is nothing behind it yet.
      if (key.name === "escape" && state.pickerReturn) {
        return { state: { ...state, mode: state.pickerReturn, pickerReturn: null }, effects: [] };
      }
      return { state, effects: [] };
    }

    case "howItWorks": {
      if (!CONFIRM_KEYS.has(key.name ?? "")) return { state, effects: [] };
      const settings = { ...state.settings, onboarded: true };
      const ready: AppState = { ...state, settings, consented: true };
      return {
        state: isActive(ready) ? advance(ready, pack, ready.now) : { ...ready, mode: "waiting" },
        effects: [{ type: "settings", settings }],
      };
    }

    case "waiting":
      return { state, effects: [] };

    case "offer": {
      const yes = key.ch === "y" || key.name === "enter" || key.name === "space";
      const no = key.ch === "n" || key.name === "escape";
      if (yes) {
        // Said once, remembered for the rest of this pane's life.
        return { state: advance({ ...state, consented: true }, pack, state.now), effects: [] };
      }
      if (no) {
        return { state: { ...state, mode: "waiting", declined: true }, effects: [] };
      }
      return { state, effects: [] };
    }

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
