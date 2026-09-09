import type { Card, CardKind, ItemProgress, Pack, Progress, Settings, Word } from "./types.js";
/**
 * Short-term steps walked while an item is still `learning`. Graduating to `review`
 * takes one correct answer per step, so a word has to survive three separate waits
 * before it starts costing calendar days.
 */
export declare const LEARNING_STEPS: number[];
/** Days until the next review, indexed by Leitner box. Box 0 is unused. */
export declare const REVIEW_DAYS: number[];
export declare const MAX_BOX = 5;
/**
 * The teaching ramp: a word is shown before it is ever asked, recognised before it
 * has to be produced, and only typed out once it is genuinely familiar.
 */
export declare function cardKindForBox(box: number): CardKind;
export declare function emptyProgress(lang: string): Progress;
export declare function dayKey(now: number): string;
/** Deterministic PRNG so a seeded run always produces the same quiz. */
export declare function makeRng(seed: number): () => number;
export declare function shuffle<T>(items: T[], rng: () => number): T[];
/**
 * Decide what to show next.
 *
 * Order of preference: anything already due (most overdue first, weakest first on a
 * tie), then a brand-new word if both the learning-queue and daily caps allow it.
 * Returns null when the user is genuinely caught up.
 */
export declare function selectNext(pack: Pack, progress: Progress, settings: Settings, now: number): {
    word: Word;
    item: ItemProgress | null;
} | null;
/** When the next item becomes eligible, or null if there is nothing scheduled. */
/**
 * A skip costs nothing but a delay — punishing it would poison the box levels.
 *
 * Shared by the pane and by `claudelingo skip`, so the two cannot drift: a word
 * with no progress row yet gets one in the `new` stage, because without it
 * `selectNext` hands back the very card that was just skipped.
 */
export declare const SKIP_DELAY_MS: number;
export declare function deferItem(existing: ItemProgress | undefined, id: string, now: number): ItemProgress;
export declare function nextDueAt(progress: Progress): number | null;
/** Strip case, accents, and surrounding punctuation so "Qué" matches "que". */
export declare function normalize(text: string): string;
export declare function buildCard(pack: Pack, word: Word, item: ItemProgress | null, rng: () => number): Card;
export declare function isCorrect(card: Card, response: {
    choice?: number;
    text?: string;
}): boolean;
/**
 * Fold one answer into progress. Returns a new object; the caller owns persistence.
 *
 * A wrong answer never destroys history — it drops the item one box and sends it back
 * through the short learning steps, which is what makes the box level meaningful.
 */
export declare function applyAnswer(progress: Progress, word: Word, card: Card, correct: boolean, now: number): Progress;
export interface Stats {
    learned: number;
    total: number;
    learning: number;
    review: number;
    mastered: number;
    due: number;
    streak: number;
    bestStreak: number;
    accuracy: number;
}
export declare function stats(pack: Pack, progress: Progress, now: number): Stats;
