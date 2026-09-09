/** A single vocabulary entry, materialised from the compact on-disk pack format. */
export interface Word {
  /** Stable id, e.g. `es:42`. Survives pack edits as long as rank order is stable. */
  id: string;
  /** 1-based frequency rank within its pack. */
  rank: number;
  /** The word in the target language. */
  term: string;
  /** English gloss. May list several senses, comma separated. */
  gloss: string;
  /** Coarse part of speech, used to pick plausible distractors. */
  pos: string;
  /** Optional extra: noun gender, an irregular form, a usage caveat. */
  note?: string;
}

export interface Pack {
  /** ISO 639-1 code. */
  code: string;
  /** Name in the target language, e.g. "Espanol". */
  name: string;
  /** Name in English, e.g. "Spanish". */
  englishName: string;
  words: Word[];
}

/** The compact JSON actually stored on disk — arrays keep the packs small and diffable. */
export interface RawPack {
  code: string;
  name: string;
  englishName: string;
  /** `[term, gloss, pos, note?]`, ordered most-frequent first. */
  words: Array<[string, string, string] | [string, string, string, string]>;
}

/** Where an item sits in the teach -> recognise -> produce progression. */
export type Stage = "new" | "learning" | "review";

/** What we are about to ask. `teach` is a no-fail introduction, not a question. */
export type CardKind = "teach" | "recognize" | "reverse" | "recall";

export interface ItemProgress {
  /** Word id. */
  id: string;
  stage: Stage;
  /** Leitner box, 0-5. Drives which card kind is used and the review interval. */
  box: number;
  /** Index into LEARNING_STEPS while `stage === "learning"`. */
  step: number;
  /** Epoch ms when this item next becomes eligible. */
  due: number;
  /** Epoch ms of the last answer, or 0 if never answered. */
  lastSeen: number;
  seen: number;
  correct: number;
  lapses: number;
}

export interface Progress {
  version: 1;
  lang: string;
  items: Record<string, ItemProgress>;
  /** Consecutive correct answers, across sessions. */
  streak: number;
  bestStreak: number;
  totalAnswered: number;
  totalCorrect: number;
  /** `YYYY-MM-DD` (local) -> count of words introduced that day, for the new-word cap. */
  introducedByDay: Record<string, number>;
}

export interface Card {
  kind: CardKind;
  word: Word;
  /** Text shown as the question. */
  prompt: string;
  /** Choice labels for `recognize` / `reverse`. Empty for `teach` / `recall`. */
  choices: string[];
  /** Index into `choices` of the correct answer, or -1 when there are no choices. */
  answerIndex: number;
  /** Accepted literal answers for `recall`. */
  accepted: string[];
}

/** Whether the coding agent is working (quiz) or waiting on the human (stand down). */
export type AgentState = "busy" | "idle";

export interface AgentStatus {
  state: AgentState;
  /** Which integration wrote this. */
  source: "claude" | "codex" | "manual";
  /** The hook/event name that produced it, for debugging. */
  event: string;
  /** Epoch ms. */
  ts: number;
}

export interface Settings {
  lang: string;
  /** Max items allowed in `learning` at once. Keeps the queue from flooding. */
  maxLearning: number;
  /** Max brand-new words introduced per calendar day. */
  newPerDay: number;
  /** A `busy` status older than this is treated as idle (the agent probably died). */
  staleBusyMs: number;
  /** Practise even when no agent is working. */
  alwaysOn: boolean;
  /** Call Claude for memory hooks and example sentences. */
  enrich: boolean;
  /** Model used for enrichment and pack generation. */
  model: string;
  /** Open the quiz pane automatically when a Claude Code session starts. */
  autoPane: boolean;
  /** The first-run walkthrough has been completed. */
  onboarded: boolean;
  /**
   * Draw the full panel under the prompt rather than a single line.
   *
   * Claude Code renders one row per line printed, so the whole widget fits there.
   * Off gives back the vertical space and returns to the one-line drill.
   */
  panel: boolean;
  /**
   * Ask before starting a quiz.
   *
   * Off by default: someone who runs `claudelingo` has already answered the
   * question. The panes that open on their own — the SessionStart hook and
   * `claudelingo start` — pass `--ask`, because those appear unbidden.
   */
  askFirst: boolean;
}
