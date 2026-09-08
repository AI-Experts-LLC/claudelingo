import type { AgentState, Pack, Progress, Settings, Word } from "../types.js";
import { type Key, type ProblemKey } from "./app.js";
export interface RunOptions {
    pack: Pack;
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
