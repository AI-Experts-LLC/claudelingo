/**
 * The shapes the band draws and the store holds.
 *
 * These are the CLI's own types (`src/types.ts`) less everything the mod does
 * not have to invent for itself. `AgentStatus` is the whole of what went: the
 * CLI reconstructs "is the agent working?" from hook events it writes to a file
 * and reads back, guesses a stale `busy` after fifteen minutes, and tails Codex
 * transcripts for the edge Codex gives it no hook for. The band is handed
 * `isWorking` on every draw, so none of that exists here.
 */

/** A single vocabulary entry, materialised from the compact pack format. */
export interface Word {
  /** Stable id, e.g. `es:42`. Survives pack edits as long as rank order is stable. */
  id: string
  /** 1-based frequency rank within its pack. */
  rank: number
  /** The word in the target language. */
  term: string
  /** English gloss. May list several senses, comma separated. */
  gloss: string
  /** Coarse part of speech, used to pick plausible distractors. */
  pos: string
  /** A sentence using the word, and its translation. Absent in older packs. */
  example?: { text: string; translation: string }
  /** Optional extra: noun gender, an irregular form, a usage caveat. */
  note?: string
}

export interface Pack {
  /** ISO 639-1 code. */
  code: string
  /** Name in the target language, e.g. "Español". */
  name: string
  /** Name in English, e.g. "Spanish". */
  englishName: string
  words: Word[]
}

/** The compact form a pack is written in: arrays keep it small and diffable. */
export interface RawPack {
  code: string
  name: string
  englishName: string
  /**
   * `[term, gloss, pos, note?, example?]`, ordered most-frequent first.
   *
   * `example` is a short sentence using the word, with its English translation
   * after a `|`. It is what a cloze card blanks out, and it is optional: packs
   * written before sentences existed stay valid.
   */
  words: Array<
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
  >
}

/** Where an item sits in the teach -> recognise -> produce progression. */
export type Stage = 'new' | 'learning' | 'review'

/** What we are about to ask. `teach` is a no-fail introduction, not a question. */
export type CardKind = 'teach' | 'recognize' | 'reverse' | 'recall' | 'cloze'

export interface ItemProgress {
  /** Word id. */
  id: string
  stage: Stage
  /** Leitner box, 0-5. Drives which card kind is used and the review interval. */
  box: number
  /** Index into LEARNING_STEPS while `stage === "learning"`. */
  step: number
  /** Epoch ms when this item next becomes eligible. */
  due: number
  /** Epoch ms of the last answer, or 0 if never answered. */
  lastSeen: number
  seen: number
  correct: number
  lapses: number
}

export interface Progress {
  version: 1
  lang: string
  items: Record<string, ItemProgress>
  /** Consecutive correct answers, across sessions. */
  streak: number
  bestStreak: number
  totalAnswered: number
  totalCorrect: number
  /** `YYYY-MM-DD` (local) -> words introduced that day, for the new-word cap. */
  introducedByDay: Record<string, number>
}

export interface Card {
  kind: CardKind
  word: Word
  /** Text shown as the question. */
  prompt: string
  /** Choice labels for `recognize` / `reverse` / `cloze`. Empty otherwise. */
  choices: string[]
  /** Index into `choices` of the correct answer, or -1 when there are none. */
  answerIndex: number
  /** Accepted literal answers for `recall`. */
  accepted: string[]
}

export interface Settings {
  /** ISO 639-1 code of the language being studied, or "" before the first pick. */
  lang: string
  /** Max items allowed in `learning` at once. Keeps the queue from flooding. */
  maxLearning: number
  /** Max brand-new words introduced per calendar day. */
  newPerDay: number
  /** Quiz even when no turn is running. */
  alwaysOn: boolean
  /** Ask $.model for memory hooks. */
  enrich: boolean
  /** Model used for memory hooks and pack generation. */
  model: string
  /** Draw the band at all. `/lingo off` clears it without uninstalling. */
  on: boolean
}

/**
 * What the band is showing, between draws.
 *
 * A render hook is called afresh each time and must be able to draw the whole
 * picture from state it kept itself, so this is the band's memory: the card on
 * screen, the answer just given, and whether the person asked to practise while
 * Claude is idle.
 */
export interface BandState {
  /** The card on screen, or null when the band is drilling or caught up. */
  card: Card | null
  /**
   * The answer just given, held for one card so the band can say how it went.
   *
   * Cleared by the press that moves on, so "correct" never outlives the card it
   * describes.
   */
  verdict: Verdict | null
  /** Practise pressed: quiz on regardless of whether a turn is running. */
  practising: boolean
  /** A memory hook fetched for the card on screen. */
  hook: string | null
  /** A fetch in flight, so the band draws a wait rather than firing twice. */
  fetchingHook: boolean
  /** What the person has typed into a `recall` card's field. */
  typed: string
}

export interface Verdict {
  correct: boolean
  /** The answer, spelled out, for a card that was got wrong. */
  answer: string
  /** The word it was about, so the band can offer a hook for it. */
  word: Word
}
