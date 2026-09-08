import type { AgentState, Card, Pack, Progress, Settings, Word } from "../types.js";
export type Mode = "welcome" | "pickLanguage" | "howItWorks" | "waiting" | "offer" | "teach" | "question" | "feedback" | "caughtup" | "quit";
/** Every distinct thing that can go wrong and needs saying. */
export type ProblemKey = "save" | "deck" | "settings" | "lock"
/** The status file cannot be read, so the pane cannot see the agent. */
 | "status"
/** The status file cannot be written, so Codex turns are never recorded. */
 | "statusWrite" | "codex" | "credentials" | "settings";
export interface Key {
    /** The character typed, if it was a printable one. */
    ch?: string;
    /** A named key: `enter`, `space`, `backspace`, `escape`, `ctrl-c`. */
    name?: string;
}
export type Event = {
    type: "agent";
    state: AgentState;
} | {
    type: "key";
    key: Key;
} | {
    type: "tick";
    now: number;
} | {
    type: "enriched";
    wordId: string;
    text: string;
} | {
    type: "enrichFailed";
    wordId: string;
    message: string;
} | {
    type: "problem";
    key: ProblemKey;
    message: string | null;
};
export type Effect = {
    type: "save";
    progress: Progress;
} | {
    type: "enrich";
    word: Word;
}
/** Load a different pack and deck, and remember the choice. */
 | {
    type: "language";
    code: string;
} | {
    type: "settings";
    settings: Settings;
} | {
    type: "quit";
};
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
export declare function isOnboarding(state: AppState): boolean;
/** Quizzing only happens while the agent is working — unless the user opted in. */
export declare function isActive(state: AppState): boolean;
export declare function createState(pack: Pack, progress: Progress, settings: Settings, agent: AgentState, now: number, languages?: LanguageChoice[]): AppState;
export declare function reduce(state: AppState, event: Event, pack: Pack): Step;
export declare function summary(pack: Pack, state: AppState): import("../srs.js").Stats;
export type { Card };
