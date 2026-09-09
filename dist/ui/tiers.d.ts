/**
 * Where you are, in words rather than numbers.
 *
 * A count alone — "83 words" — says nothing about whether that is a lot. These
 * thresholds are the honest shape of learning a language's frequency list: the
 * first hundred words are most of what you hear in a day, the first thousand is
 * most of a conversation, and the gaps get wider because the words get rarer.
 */
export interface Tier {
    name: string;
    /** Words needed to have reached it. */
    at: number;
}
export declare const TIERS: Tier[];
export interface Standing {
    tier: Tier;
    /** The one above, or null at the top. */
    next: Tier | null;
    /** Words still needed for `next`, or 0 at the top. */
    toGo: number;
    /** How far through the current tier, 0..1. */
    progress: number;
}
export declare function standing(learned: number): Standing;
