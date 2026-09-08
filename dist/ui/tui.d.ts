import type { AgentState, Pack, Progress, Settings, Word } from "../types.js";
import { type Key, type LanguageChoice, type ProblemKey } from "./app.js";
export interface RunOptions {
    pack: Pack;
    /** Every installed pack, so the picker can offer them. */
    languages?: LanguageChoice[];
    /**
     * Swap to another language: load its pack and deck, and move the lock.
     *
     * The runner cannot do this itself — packs, decks and the single-pane lock all
     * live outside the UI — so the caller supplies it.
     */
    switchLanguage?: (code: string) => {
        pack: Pack;
        progress: Progress;
        progressFile: string;
        /** True when that language's deck could not be read and must not be written. */
        readOnly?: boolean;
        /** Anything the user needs to know about that deck. */
        problem?: string;
    } | null;
    /** Persist a settings change made from inside the pane. */
    saveSettings?: (settings: Settings) => void;
    progress: Progress;
    settings: Settings;
    progressFile: string;
    statusFile: string;
    /** Ask Claude for a memory hook. Injected so tests run without network. */
    enrich?: (word: Word) => Promise<string>;
    /** Shown in the pane straight away, e.g. an unreadable progress file. */
    initialProblems?: Partial<Record<ProblemKey, string>>;
    /** Suppress saving entirely — set when a deck we could not read is still on disk. */
    readOnly?: boolean;
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    color?: boolean;
    width?: number;
    tickMs?: number;
    /** Render plain frames even without a TTY. Used by the end-to-end tests. */
    forceRender?: boolean;
    /** Tail Codex transcripts for the turn-start edge Codex has no hook for. */
    watchCodex?: (onState: (state: AgentState) => void, 
    /** null when the watcher recovers, so the banner can be cleared. */
    onError: (message: string | null) => void) => {
        stop(): void;
    };
}
/** Translate one chunk of raw stdin into the key events the reducer understands. */
export declare function parseKeys(chunk: string): Key[];
export interface Runner {
    /** Resolves when the user quits or stdin ends. */
    done: Promise<void>;
    stop(): void;
}
export declare function run(options: RunOptions): Runner;
