import type { Pack } from "../types.js";
import { type AppState } from "./app.js";
export interface Theme {
    reset: string;
    dim: string;
    bold: string;
    green: string;
    red: string;
    cyan: string;
    yellow: string;
}
export declare const COLOR: Theme;
/** Used by tests and by `--no-color`, so frames can be asserted as plain text. */
export declare const PLAIN: Theme;
/** Terminal columns a rendered string occupies, ignoring colour sequences. */
export declare function visibleWidth(text: string): number;
/** Hard-wrap on word boundaries; a token longer than the line is split. */
export declare function wrap(text: string, width: number): string[];
/** Draw the panel border around already-composed content lines. */
export declare function box(content: string[], options: {
    width: number;
    title: string;
    footer: string;
    theme: Theme;
}): string[];
export declare function renderFrame(state: AppState, pack: Pack, width: number, theme: Theme): string[];
