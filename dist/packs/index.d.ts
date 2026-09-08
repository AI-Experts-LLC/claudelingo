import type { Pack, RawPack } from "../types.js";
/** Codes that ship with claudelingo and therefore cannot be generated into. */
export declare function bundledCodes(): string[];
export declare class PackError extends Error {
}
/**
 * Strip control characters from pack text.
 *
 * Packs are model-generated or hand-placed, so their text is untrusted input. A
 * newline in a gloss turns the status line into two lines inside Claude Code's UI,
 * and a raw ESC injects arbitrary escape sequences into it — the truncation logic
 * treats escapes as free, so they pass straight through. Cleaned here so every
 * surface benefits rather than each one remembering.
 */
/** Strip control characters and collapse whitespace — see `materialize`. */
export declare function clean(value: string): string;
export declare function materialize(raw: RawPack): Pack;
export declare function loadPack(code: string): Pack;
export declare function listPacks(): string[];
export declare function savePack(raw: RawPack, options?: {
    overwrite?: boolean;
}): string;
