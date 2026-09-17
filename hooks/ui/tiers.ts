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

export const TIERS: Tier[] = [
  { name: "just arrived", at: 0 },
  { name: "first words", at: 10 },
  { name: "finding your feet", at: 50 },
  { name: "getting by", at: 100 },
  { name: "holding a conversation", at: 250 },
  { name: "comfortable", at: 500 },
  { name: "most of a day's speech", at: 1000 },
];

export interface Standing {
  tier: Tier;
  /** The one above, or null at the top. */
  next: Tier | null;
  /** Words still needed for `next`, or 0 at the top. */
  toGo: number;
  /** How far through the current tier, 0..1. */
  progress: number;
}

export function standing(learned: number): Standing {
  const count = Number.isFinite(learned) ? Math.max(0, Math.floor(learned)) : 0;
  let index = 0;
  for (let i = 0; i < TIERS.length; i++) {
    if (count >= (TIERS[i] as Tier).at) index = i;
  }
  const tier = TIERS[index] as Tier;
  const next = index + 1 < TIERS.length ? (TIERS[index + 1] as Tier) : null;
  if (!next) return { tier, next: null, toGo: 0, progress: 1 };
  const span = next.at - tier.at;
  return {
    tier,
    next,
    toGo: Math.max(0, next.at - count),
    progress: span > 0 ? Math.min(1, (count - tier.at) / span) : 1,
  };
}
