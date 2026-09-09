import type { Pack, RawPack, Word } from "./types.js";
/**
 * Everything that needs a model goes through the `claude` CLI in print mode.
 *
 * That matters for one reason above all: it runs on the Claude Code login the user
 * already has, and counts against the usage they are already paying for. Calling
 * the Anthropic API directly would mean a second credential and a separate bill for
 * something that only ever runs while Claude Code is open.
 *
 * It also means claudelingo ships with no API SDK and no key handling at all.
 */
/** Preferred model. Claude Code falls back to the session's own if it cannot use it. */
export declare const DEFAULT_MODEL = "claude-fable-5-1";
export declare class EnrichError extends Error {
}
export interface AskOptions {
    model?: string;
    timeoutMs?: number;
    system?: string;
    /** Injected by tests so they never spawn the real CLI. */
    run?: (args: string[], timeoutMs: number) => Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }>;
}
/**
 * Ask Claude Code one question and return its text.
 *
 * `--max-turns 1` keeps it to a single completion: this is a text request, and a
 * tool loop would be slow, surprising, and able to touch the user's files.
 */
export declare function ask(prompt: string, options?: AskOptions): Promise<string>;
/**
 * A hook we already have, or null. Never fetches.
 *
 * The panel is read-only and runs every couple of seconds; reaching the model
 * from there would spend the user's quota on a decoration, once per tick.
 */
export declare function cachedHook(lang: string, term: string): string | null;
/**
 * A one- or two-line memory hook for a word. Cached on disk, because the hook for
 * "tiempo" never changes.
 */
export declare function memoryHook(word: Word, pack: Pack, options?: AskOptions): Promise<string>;
/** Build a frequency pack for a language claudelingo does not ship. */
export declare function generatePack(language: string, code: string, count: number, options?: AskOptions): Promise<RawPack>;
/**
 * Whether the `claude` command is available.
 *
 * There is no credential to check any more: if Claude Code runs, so does this.
 */
export declare function hasClaude(runner?: () => boolean): boolean;
