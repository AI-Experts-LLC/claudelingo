import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The hooks claudelingo installs, and what each one means for the pane.
 *
 * `Notification` maps to idle on purpose: Claude Code fires it when it wants a
 * permission decision, and that is precisely when the human should be looking at
 * Claude rather than at a vocabulary card.
 */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionEnd",
  "Notification",
] as const;

/**
 * `SessionStart` does not report agent state — it opens the pane.
 *
 * It must run with `async: true`: hooks block the session by default, and opening
 * a tmux pane is not something the user should wait on before they can type.
 */
const PANE_EVENT = "SessionStart";

const MARKER = "claudelingo";

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

/**
 * Seconds between status-line redraws.
 *
 * Claude Code's own updates are event-driven and go quiet exactly when the agent
 * is thinking — which is when the line is supposed to be teaching. A timer keeps
 * the word rotating and the answer revealing through a long turn.
 */
const STATUS_REFRESH_SECONDS = 3;

export class StatusLineTaken extends Error {}

export function settingsPath(scope: "user" | "project" = "user", cwd = process.cwd()): string {
  return scope === "user"
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(cwd, ".claude", "settings.json");
}

function commandFor(event: string, bin: string): string {
  return event === PANE_EVENT ? `${bin} session-start` : `${bin} hook ${event} --source claude`;
}

function isOurs(command: string): boolean {
  return command.includes(MARKER) && / hook | session-start/.test(command);
}

/**
 * Merge our hooks into an existing settings file without disturbing anything else.
 *
 * Re-running is safe: our own entries are replaced, everyone else's are preserved.
 */
export function withHooks(settings: Settings, bin: string): Settings {
  const hooks: Record<string, HookMatcher[]> = { ...(settings.hooks ?? {}) };

  for (const event of HOOK_EVENTS) {
    const existing = hooks[event] ?? [];
    const cleaned = existing
      .map((matcher) => ({
        ...matcher,
        hooks: (matcher.hooks ?? []).filter((hook) => !isOurs(hook.command ?? "")),
      }))
      .filter((matcher) => matcher.hooks.length > 0);
    const entry: HookCommand =
      event === PANE_EVENT
        ? { type: "command", command: commandFor(event, bin), async: true }
        : { type: "command", command: commandFor(event, bin) };
    hooks[event] = [...cleaned, { hooks: [entry] }];
  }

  return { ...settings, hooks };
}

export function removeHooks(settings: Settings): Settings {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    const cleaned = matchers
      .map((matcher) => ({
        ...matcher,
        hooks: (matcher.hooks ?? []).filter((hook) => !isOurs(hook.command ?? "")),
      }))
      .filter((matcher) => matcher.hooks.length > 0);
    if (cleaned.length) hooks[event] = cleaned;
  }
  const next = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/**
 * Point Claude Code's status line at us.
 *
 * There is exactly one status-line slot, so someone else's is never overwritten —
 * that would silently replace whatever they had configured, and unlike the hooks
 * there is nowhere for both to live.
 */
export function withStatusLine(settings: Settings, bin: string): Settings {
  const existing = settings.statusLine;
  const ours = `${bin} statusline`;
  if (existing && !existing.command?.includes(`${bin} statusline`)) {
    throw new StatusLineTaken(
      `a status line is already configured (${existing.command}). Claude Code allows ` +
        "only one, so claudelingo has left it alone. Remove it and re-run " +
        "`claudelingo init` to use claudelingo's instead, or run " +
        "`claudelingo init --no-statusline` to skip this part.",
    );
  }
  return {
    ...settings,
    statusLine: { type: "command", command: ours, refreshInterval: STATUS_REFRESH_SECONDS },
  };
}

export function removeStatusLine(settings: Settings, bin: string): Settings {
  if (!settings.statusLine?.command?.includes(`${bin} statusline`)) return settings;
  const next = { ...settings };
  delete next.statusLine;
  return next;
}

export function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  } catch (error) {
    throw new Error(`${file} is not valid JSON — fix it before installing hooks (${(error as Error).message})`);
  }
}

export function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.claudelingo.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (error) {
    // Never leave an orphan temp file in the user's config directory, and never
    // let a cleanup failure mask the write failure.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing further to do.
    }
    throw error;
  }
}

export interface InstallResult {
  /** Set when the hooks went in but the status line could not. */
  statusLineProblem?: string;
}

export function install(
  file: string,
  bin: string,
  options: { statusLine?: boolean } = {},
): InstallResult {
  const current = readSettings(file);
  let next = withHooks(current, bin);
  const result: InstallResult = {};

  if (options.statusLine !== false) {
    try {
      next = withStatusLine(next, bin);
    } catch (error) {
      // The hooks are the load-bearing half; a taken status line must not stop
      // them being installed.
      if (!(error instanceof StatusLineTaken)) throw error;
      result.statusLineProblem = error.message;
    }
  }

  writeSettings(file, next);
  return result;
}

/** True when the configured status line is the one we installed. */
export function hasOurStatusLine(file: string, bin: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    return Boolean(readSettings(file).statusLine?.command?.includes(`${bin} statusline`));
  } catch {
    return false;
  }
}

export function uninstall(file: string, bin: string): void {
  if (!fs.existsSync(file)) return;
  writeSettings(file, removeStatusLine(removeHooks(readSettings(file)), bin));
}
