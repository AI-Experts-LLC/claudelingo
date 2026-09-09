import type { Pack, RawPack } from "../types.js";
/** Codes that ship with claudelingo and therefore cannot be generated into. */
export declare function bundledCodes(): string[];
export declare class PackError extends Error {
}
export declare function materialize(raw: RawPack): Pack;
export declare function loadPack(code: string): Pack;
export declare function listPacks(): string[];
export declare function savePack(raw: RawPack, options?: {
    overwrite?: boolean;
}): string;
