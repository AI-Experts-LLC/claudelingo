/**
 * The hooks claudelingo installs, and what each one means for the pane.
 *
 * `Notification` maps to idle on purpose: Claude Code fires it when it wants a
 * permission decision, and that is precisely when the human should be looking at
 * Claude rather than at a vocabulary card.
 */
export declare const HOOK_EVENTS: readonly ["SessionStart", "UserPromptSubmit", "Stop", "SubagentStop", "SessionEnd", "Notification"];
interface HookCommand {
    type: string;
    command: string;
    /** Run in the background. Hooks block the session otherwise. */
    async?: boolean;
}
interface HookMatcher {
    matcher?: string;
    hooks: HookCommand[];
}
interface StatusLine {
    type: string;
    command: string;
    padding?: number;
    refreshInterval?: number;
}
interface Settings {
    hooks?: Record<string, HookMatcher[]>;
    statusLine?: StatusLine;
    [key: string]: unknown;
}
export declare class StatusLineTaken extends Error {
}
export declare function settingsPath(scope?: "user" | "project", cwd?: string): string;
/**
 * Merge our hooks into an existing settings file without disturbing anything else.
 *
 * Re-running is safe: our own entries are replaced, everyone else's are preserved.
 */
export declare function withHooks(settings: Settings, bin: string): Settings;
export declare function removeHooks(settings: Settings): Settings;
/**
 * Point Claude Code's status line at us.
 *
 * There is exactly one status-line slot, so someone else's is never overwritten —
 * that would silently replace whatever they had configured, and unlike the hooks
 * there is nowhere for both to live.
 */
export declare function withStatusLine(settings: Settings, bin: string): Settings;
export declare function removeStatusLine(settings: Settings, bin: string): Settings;
export declare function readSettings(file: string): Settings;
export declare function writeSettings(file: string, settings: Settings): void;
export interface InstallResult {
    /** Set when the hooks went in but the status line could not. */
    statusLineProblem?: string;
}
export declare function install(file: string, bin: string, options?: {
    statusLine?: boolean;
}): InstallResult;
/** True when the configured status line is the one we installed. */
export declare function hasOurStatusLine(file: string, bin: string): boolean;
export declare function uninstall(file: string, bin: string): void;
export {};
