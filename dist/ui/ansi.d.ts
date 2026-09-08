export declare const ansi: {
    reset: string;
    dim: string;
    bold: string;
    green: string;
    red: string;
    cyan: string;
    yellow: string;
    clearScreen: string;
    hideCursor: string;
    showCursor: string;
};
/** Matches any SGR sequence, for width calculations. */
export declare const ANSI_PATTERN: RegExp;
/** Raw control bytes that arrive on stdin in raw mode. */
export declare const keys: {
    ctrlC: string;
    backspace: string;
    del: string;
    esc: string;
};
