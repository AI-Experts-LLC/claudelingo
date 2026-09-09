const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * Short-term steps walked while an item is still `learning`. Graduating to `review`
 * takes one correct answer per step, so a word has to survive three separate waits
 * before it starts costing calendar days.
 */
export const LEARNING_STEPS = [1 * MINUTE, 10 * MINUTE, 60 * MINUTE];
/** Days until the next review, indexed by Leitner box. Box 0 is unused. */
export const REVIEW_DAYS = [0, 1, 3, 7, 16, 35];
export const MAX_BOX = 5;
/**
 * The teaching ramp: a word is shown before it is ever asked, recognised before it
 * has to be produced, and only typed out once it is genuinely familiar.
 */
export function cardKindForBox(box) {
    if (box <= 2)
        return "recognize";
    if (box <= 4)
        return "reverse";
    return "recall";
}
export function emptyProgress(lang) {
    return {
        version: 1,
        lang,
        items: {},
        streak: 0,
        bestStreak: 0,
        totalAnswered: 0,
        totalCorrect: 0,
        introducedByDay: {},
    };
}
export function dayKey(now) {
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Deterministic PRNG so a seeded run always produces the same quiz. */
export function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function shuffle(items, rng) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const a = out[i];
        const b = out[j];
        out[i] = b;
        out[j] = a;
    }
    return out;
}
function countLearning(progress) {
    return Object.values(progress.items).filter((i) => i.stage === "learning").length;
}
/**
 * Decide what to show next.
 *
 * Order of preference: anything already due (most overdue first, weakest first on a
 * tie), then a brand-new word if both the learning-queue and daily caps allow it.
 * Returns null when the user is genuinely caught up.
 */
export function selectNext(pack, progress, settings, now) {
    const due = Object.values(progress.items)
        .filter((item) => item.due <= now)
        .sort((a, b) => a.due - b.due || a.box - b.box || a.id.localeCompare(b.id));
    const byId = new Map(pack.words.map((w) => [w.id, w]));
    for (const item of due) {
        const word = byId.get(item.id);
        // An item whose word vanished (pack trimmed, language switched) is not fatal.
        if (word)
            return { word, item };
    }
    if (countLearning(progress) >= settings.maxLearning)
        return null;
    if ((progress.introducedByDay[dayKey(now)] ?? 0) >= settings.newPerDay)
        return null;
    const next = pack.words.find((w) => !progress.items[w.id]);
    return next ? { word: next, item: null } : null;
}
/** When the next item becomes eligible, or null if there is nothing scheduled. */
/**
 * A skip costs nothing but a delay — punishing it would poison the box levels.
 *
 * Shared by the pane and by `claudelingo skip`, so the two cannot drift: a word
 * with no progress row yet gets one in the `new` stage, because without it
 * `selectNext` hands back the very card that was just skipped.
 */
export const SKIP_DELAY_MS = 10 * MINUTE;
export function deferItem(existing, id, now) {
    if (existing)
        return { ...existing, due: now + SKIP_DELAY_MS };
    return {
        id,
        stage: "new",
        box: 0,
        step: 0,
        due: now + SKIP_DELAY_MS,
        lastSeen: 0,
        seen: 0,
        correct: 0,
        lapses: 0,
    };
}
export function nextDueAt(progress) {
    const times = Object.values(progress.items).map((i) => i.due);
    return times.length ? Math.min(...times) : null;
}
function pickDistractors(pack, word, rng, count) {
    const isCandidate = (w) => w.id !== word.id && w.gloss !== word.gloss && w.term !== word.term;
    // Nearby-rank words of the same part of speech make the hardest, fairest choices;
    // widen the net only as far as needed to fill the row.
    const tiers = [
        pack.words.filter((w) => isCandidate(w) && w.pos === word.pos && Math.abs(w.rank - word.rank) <= 60),
        pack.words.filter((w) => isCandidate(w) && w.pos === word.pos),
        pack.words.filter(isCandidate),
    ];
    const picked = [];
    const used = new Set();
    for (const tier of tiers) {
        for (const candidate of shuffle(tier, rng)) {
            if (picked.length >= count)
                break;
            if (used.has(candidate.id))
                continue;
            used.add(candidate.id);
            picked.push(candidate);
        }
        if (picked.length >= count)
            break;
    }
    return picked;
}
/** Strip case, accents, and surrounding punctuation so "Qué" matches "que". */
export function normalize(text) {
    return text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s'-]/gu, "")
        .trim()
        .replace(/\s+/g, " ");
}
export function buildCard(pack, word, item, rng) {
    const kind = item === null || item.stage === "new" ? "teach" : cardKindForBox(item.box);
    if (kind === "teach") {
        return { kind, word, prompt: word.term, choices: [], answerIndex: -1, accepted: [word.term] };
    }
    if (kind === "recall") {
        return {
            kind,
            word,
            prompt: word.gloss,
            choices: [],
            answerIndex: -1,
            accepted: [word.term, ...word.term.split(/\s*,\s*/)],
        };
    }
    const distractors = pickDistractors(pack, word, rng, 3);
    const label = (w) => (kind === "recognize" ? w.gloss : w.term);
    const options = shuffle([word, ...distractors], rng);
    return {
        kind,
        word,
        prompt: kind === "recognize" ? word.term : word.gloss,
        choices: options.map(label),
        answerIndex: options.findIndex((w) => w.id === word.id),
        accepted: [label(word)],
    };
}
export function isCorrect(card, response) {
    if (card.kind === "teach")
        return true;
    const typed = normalize(response.text ?? "");
    if (card.choices.length) {
        // Someone who types the right answer instead of its number has got it right.
        // This used to compare `undefined === answerIndex` and mark them wrong —
        // demoting a box and breaking a streak for being correct — and the skill's
        // catch-all sends typed input here for every card kind.
        if (typed.length > 0) {
            const right = card.choices[card.answerIndex];
            return ((right !== undefined && normalize(right) === typed) ||
                card.accepted.some((a) => normalize(a) === typed));
        }
        return response.choice === card.answerIndex;
    }
    return typed.length > 0 && card.accepted.some((a) => normalize(a) === typed);
}
function freshItem(id, now) {
    return { id, stage: "new", box: 0, step: 0, due: now, lastSeen: 0, seen: 0, correct: 0, lapses: 0 };
}
/**
 * Fold one answer into progress. Returns a new object; the caller owns persistence.
 *
 * A wrong answer never destroys history — it drops the item one box and sends it back
 * through the short learning steps, which is what makes the box level meaningful.
 */
export function applyAnswer(progress, word, card, correct, now) {
    const items = { ...progress.items };
    const previous = items[word.id] ?? freshItem(word.id, now);
    const item = { ...previous, lastSeen: now };
    const introducedByDay = { ...progress.introducedByDay };
    if (card.kind === "teach") {
        const key = dayKey(now);
        introducedByDay[key] = (introducedByDay[key] ?? 0) + 1;
        // Only today's count is ever read; keeping every day since install would grow
        // the progress file by one key a day for the life of the deck.
        for (const day of Object.keys(introducedByDay)) {
            if (day !== key)
                delete introducedByDay[day];
        }
        item.stage = "learning";
        item.box = 1;
        item.step = 0;
        item.due = now + LEARNING_STEPS[0];
        items[word.id] = item;
        // A teach card is an introduction, not a question: it must not move the streak
        // or the accuracy numbers.
        return { ...progress, items, introducedByDay };
    }
    item.seen += 1;
    if (correct)
        item.correct += 1;
    if (correct) {
        if (item.stage === "learning") {
            const step = item.step + 1;
            if (step < LEARNING_STEPS.length) {
                item.step = step;
                item.due = now + LEARNING_STEPS[step];
            }
            else {
                item.stage = "review";
                item.step = 0;
                item.box = Math.min(MAX_BOX, item.box + 1);
                item.due = now + REVIEW_DAYS[item.box] * DAY;
            }
        }
        else {
            item.box = Math.min(MAX_BOX, item.box + 1);
            item.due = now + REVIEW_DAYS[item.box] * DAY;
        }
    }
    else {
        if (item.stage === "review")
            item.lapses += 1;
        item.stage = "learning";
        item.box = Math.max(1, item.box - 1);
        item.step = 0;
        item.due = now + LEARNING_STEPS[0];
    }
    items[word.id] = item;
    const streak = correct ? progress.streak + 1 : 0;
    return {
        ...progress,
        items,
        introducedByDay,
        streak,
        bestStreak: Math.max(progress.bestStreak, streak),
        totalAnswered: progress.totalAnswered + 1,
        totalCorrect: progress.totalCorrect + (correct ? 1 : 0),
    };
}
export function stats(pack, progress, now) {
    const items = Object.values(progress.items);
    return {
        learned: items.length,
        total: pack.words.length,
        learning: items.filter((i) => i.stage === "learning").length,
        review: items.filter((i) => i.stage === "review").length,
        mastered: items.filter((i) => i.box >= MAX_BOX).length,
        due: items.filter((i) => i.due <= now).length,
        streak: progress.streak,
        bestStreak: progress.bestStreak,
        accuracy: progress.totalAnswered ? progress.totalCorrect / progress.totalAnswered : 0,
    };
}
//# sourceMappingURL=srs.js.map