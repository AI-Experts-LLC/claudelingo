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
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionEnd",
  "Notification",
] as const;

const MARKER = "claudelingo";

interface HookCommand {
  type: string;
  command: string;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}
interface Settings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

export function settingsPath(scope: "user" | "project" = "user", cwd = process.cwd()): string {
  return scope === "user"
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(cwd, ".claude", "settings.json");
}

function commandFor(event: string, bin: string): string {
  return `${bin} hook ${event} --source claude`;
}

function isOurs(command: string): boolean {
  return command.includes(MARKER) && command.includes(" hook ");
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
    hooks[event] = [...cleaned, { hooks: [{ type: "command", command: commandFor(event, bin) }] }];
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
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function install(file: string, bin: string): void {
  writeSettings(file, withHooks(readSettings(file), bin));
}

export function uninstall(file: string): void {
  if (!fs.existsSync(file)) return;
  writeSettings(file, removeHooks(readSettings(file)));
}
