import type { RawPack } from "./types.js";
/**
 * Building a frequency pack for a language claudelingo does not ship.
 *
 * This module holds the prompts, the chunking and every rule about what comes
 * back; it does not know how the model is reached. That is the `Asker` handed
 * in — `claude -p` for the CLI, `$.model.complete` for the mod — because the
 * two surfaces have completely different transports and identical problems.
 *
 * The problems are the reason this is one module rather than two. Every comment
 * below records a real run that went wrong: a truncated reply losing 693 words
 * of French, boundaries overlapping until a 1000-word pack held 600 distinct
 * ones, and a model that, asked to fill a quota past the point where it knows
 * the frequency order, starts reciting the dictionary alphabetically. A second
 * copy of this would have to learn all of it again.
 */
/**
 * How the model is reached.
 *
 * One prompt, one system prompt, the reply's text. Everything either transport
 * needs beyond that — timeouts, models, process plumbing — it closes over.
 */
export type Asker = (prompt: string, options: {
    system: string;
}) => Promise<string>;
export declare class EnrichError extends Error {
}
/**
 * Build a frequency pack for a language claudelingo does not ship.
 *
 * Asked in chunks, because one request for a thousand entries with a sentence
 * each is a very long reply: it truncates, and a truncated JSON body is a whole
 * pack lost rather than one chunk. Each chunk is told what the earlier ones
 * produced, or the boundaries overlap and the duplicates eat the count.
 */
export declare function generatePack(ask: Asker, language: string, code: string, count: number, options?: {
    onProgress?: (done: number, total: number, note?: string) => void;
    /** Words already gathered, to continue from instead of regenerating. */
    existing?: RawPack["words"];
}): Promise<RawPack>;
