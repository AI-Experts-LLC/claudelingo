export const TIERS = [
    { name: "just arrived", at: 0 },
    { name: "first words", at: 10 },
    { name: "finding your feet", at: 50 },
    { name: "getting by", at: 100 },
    { name: "holding a conversation", at: 250 },
    { name: "comfortable", at: 500 },
    { name: "most of a day's speech", at: 1000 },
];
export function standing(learned) {
    const count = Number.isFinite(learned) ? Math.max(0, Math.floor(learned)) : 0;
    let index = 0;
    for (let i = 0; i < TIERS.length; i++) {
        if (count >= TIERS[i].at)
            index = i;
    }
    const tier = TIERS[index];
    const next = index + 1 < TIERS.length ? TIERS[index + 1] : null;
    if (!next)
        return { tier, next: null, toGo: 0, progress: 1 };
    const span = next.at - tier.at;
    return {
        tier,
        next,
        toGo: Math.max(0, next.at - count),
        progress: span > 0 ? Math.min(1, (count - tier.at) / span) : 1,
    };
}
//# sourceMappingURL=tiers.js.map