#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SETTINGS,
  ensureHome,
  loadSettings,
  paths,
  quarantine,
  readJsonFile,
  saveSettings,
  writeJsonAtomic,
} from "./config.js";
import * as lock from "./lock.js";
import { emptyProgress, stats } from "./srs.js";
import { listPacks, loadPack, savePack } from "./packs/index.js";
import { readStatus, stateForEvent, writeStatus } from "./agentState.js";
import * as claudeCode from "./integrations/claudeCode.js";
import * as codex from "./integrations/codex.js";
import { DEFAULT_MODEL, generatePack, hasCredentials, memoryHook } from "./enrich.js";
import { run } from "./ui/tui.js";
import type { ProblemKey } from "./ui/app.js";
import type { Pack, Progress, Settings, Word } from "./types.js";

const BIN = "claudelingo";

const USAGE = `claudelingo — learn a language while your coding agent works

  claudelingo [options]            open the companion pane
  claudelingo init [--project]     install Claude Code + Codex integrations
  claudelingo uninit [--project]   remove them again
  claudelingo hook <event>         report agent state (called by hooks)
  claudelingo notify [json]        Codex notify target
  claudelingo status               show the current agent state
  claudelingo stats                show your progress
  claudelingo langs                list available word packs
  claudelingo pack generate        build a pack for another language
  claudelingo reset [--yes]        erase progress for the current language

Options
  --lang <code>      language to study (default: ${DEFAULT_SETTINGS.lang})
  --always-on        practise even when no agent is working
  --no-enrich        never call Claude for memory hooks
  --no-color         plain output
  --width <n>        panel width in columns
  --model <id>       model for hooks and pack generation (default: ${DEFAULT_MODEL})
  --source <name>    claude | codex | manual (for: hook)
  -h, --help         this message
`;

interface Args {
  command: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const takesValue = new Set(["lang", "width", "source", "model", "count", "code", "home"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
    } else if (arg.startsWith("--")) {
      const [rawName, inline] = arg.slice(2).split("=", 2);
      const name = rawName as string;
      if (inline !== undefined) flags[name] = inline;
      else if (takesValue.has(name)) flags[name] = argv[++i] ?? "";
      else if (name.startsWith("no-")) flags[name.slice(3)] = false;
      else flags[name] = true;
    } else {
      positional.push(arg);
    }
  }

  const known = new Set([
    "init", "uninit", "hook", "notify", "status", "stats", "langs", "pack", "reset", "help",
  ]);
  const first = positional[0];
  const command = first && known.has(first) ? first : "run";
  return { command, rest: command === "run" ? positional : positional.slice(1), flags };
}

interface Resolved {
  settings: Settings;
  /** Set when an existing settings file could not be parsed. */
  problem?: string;
}

function settingsFrom(flags: Args["flags"]): Resolved {
  const loaded = loadSettings();
  const settings: Settings = { ...loaded.settings };
  if (typeof flags.lang === "string" && flags.lang) settings.lang = flags.lang;
  if (flags["always-on"] === true) settings.alwaysOn = true;
  if (flags["always-on"] === false) settings.alwaysOn = false;
  if (flags.enrich === false) settings.enrich = false;
  if (typeof flags.model === "string" && flags.model) settings.model = flags.model;
  return loaded.problem ? { settings, problem: loaded.problem } : { settings };
}

interface LoadedProgress {
  progress: Progress;
  /** Set when an existing deck was unusable. */
  problem?: string;
  /** True when a deck we could not use is still on disk and must not be written over. */
  readOnly?: boolean;
}

/**
 * Load a deck, never destroying one we failed to understand.
 *
 * The deck is moved aside only when its CONTENT is genuinely bad — unparseable, or
 * not a version 1 deck. A failure to *read* the file says nothing about what is in
 * it, so the file is left exactly where it is and the pane runs read-only rather
 * than replacing a deck that is almost certainly fine. That covers every transient
 * cause without having to enumerate them: EACCES, a full fd table, and the stale
 * NFS handles a networked home throws all land in the same safe branch.
 *
 * `mutate` is false for read-only commands: `stats` must never move a user's deck.
 */
function loadProgress(lang: string, mutate = true): LoadedProgress {
  const file = paths.progress(lang);
  const result = readJsonFile<Progress>(file);

  if (result.ok) {
    const stored = result.value;
    if (stored?.items && stored.version === 1) {
      return { progress: { ...emptyProgress(lang), ...stored } };
    }
    return setAside(lang, file, "is not a version 1 deck", mutate);
  }

  if (result.reason === "missing") return { progress: emptyProgress(lang) };

  const detail = result.error?.message ?? "unknown error";
  if (result.reason === "invalid") {
    return setAside(lang, file, `is not valid JSON (${detail})`, mutate);
  }

  // The read itself failed. Touching the file would turn a transient problem into
  // permanent data loss.
  return {
    progress: emptyProgress(lang),
    problem:
      `${file} could not be read (${detail}). Not saving, so your deck is left ` +
      "untouched — fix the problem and restart to start saving again.",
    readOnly: true,
  };
}

/** Move a genuinely unusable deck aside, or refuse to save if that is not possible. */
function setAside(lang: string, file: string, why: string, mutate: boolean): LoadedProgress {
  if (!mutate) {
    return { progress: emptyProgress(lang), problem: `${file} ${why}.`, readOnly: true };
  }
  const moved = quarantine(file);
  return moved
    ? {
        progress: emptyProgress(lang),
        problem: `${file} ${why}; kept a copy at ${moved} and started fresh.`,
      }
    : {
        progress: emptyProgress(lang),
        problem: `${file} ${why} and could not be set aside — not saving over it.`,
        readOnly: true,
      };
}

function fail(message: string): never {
  process.stderr.write(`claudelingo: ${message}\n`);
  process.exit(1);
}

function resolvePack(lang: string): Pack {
  try {
    return loadPack(lang);
  } catch (error) {
    return fail((error as Error).message);
  }
}

/** `claudelingo hook <event>` — the write side of the agent-state bridge. */
function cmdHook(args: Args): void {
  const event = args.rest[0];
  if (!event) fail("hook needs an event name, e.g. `claudelingo hook Stop`");
  const state = stateForEvent(event);
  // Unknown events are ignored rather than fatal: a hook firing a name we do not
  // model must never break the user's Claude Code session.
  if (!state) process.exit(0);
  const source = (args.flags.source as string) ?? "claude";
  ensureHome();
  writeStatus({
    state,
    source: source === "codex" || source === "manual" ? source : "claude",
    event,
    ts: Date.now(),
  });
  process.exit(0);
}

/** `claudelingo notify [json]` — Codex's turn-complete callback. */
function cmdNotify(args: Args): void {
  const payload = args.rest[0] ?? "";
  const state = codex.classifyNotification(payload);
  if (!state) process.exit(0);
  ensureHome();
  writeStatus({ state, source: "codex", event: "agent-turn-complete", ts: Date.now() });
  process.exit(0);
}

function cmdInit(args: Args): void {
  const scope = args.flags.project ? "project" : "user";
  ensureHome();
  const failed: string[] = [];

  const settingsFile = claudeCode.settingsPath(scope as "user" | "project");
  try {
    claudeCode.install(settingsFile, BIN);
    process.stdout.write(`Claude Code hooks installed in ${settingsFile}\n`);
    process.stdout.write(`  ${claudeCode.HOOK_EVENTS.join(", ")}\n`);
  } catch (error) {
    failed.push("Claude Code");
    process.stderr.write(`Claude Code hooks NOT installed: ${(error as Error).message}\n`);
  }

  try {
    const backup = codex.installNotify(BIN);
    process.stdout.write(`Codex notify installed in ${codex.codexConfigPath()}\n`);
    if (backup) process.stdout.write(`  previous config backed up to ${backup}\n`);
  } catch (error) {
    failed.push("Codex");
    process.stderr.write(`Codex notify NOT installed: ${(error as Error).message}\n`);
  }

  const { settings, problem } = settingsFrom(args.flags);
  if (problem) {
    // Overwriting a settings file we could not parse would discard the user's
    // language and model choice without them ever knowing.
    process.stderr.write(`${problem}\n  leaving it alone; fix or delete it, then re-run.\n`);
  } else {
    saveSettings(settings);
  }

  process.stdout.write(`\nStudying ${resolvePack(settings.lang).englishName}.\n`);
  if (failed.length) {
    // Exiting 0 here is how a user ends up staring at a pane that never wakes up.
    process.stderr.write(
      `\n${failed.join(" and ")} integration${failed.length > 1 ? "s are" : " is"} not active — ` +
        "the pane will not wake up for it.\n",
    );
    process.exit(1);
  }
  process.stdout.write(`Open the pane in a second terminal with: ${BIN}\n`);
}

function cmdUninit(args: Args): void {
  const scope = args.flags.project ? "project" : "user";
  const removed: string[] = [];
  const failed: string[] = [];

  // Attempted independently: a throw from one must not skip the other, or the user
  // is left half-uninstalled with no idea which half.
  try {
    claudeCode.uninstall(claudeCode.settingsPath(scope as "user" | "project"));
    removed.push("Claude Code hooks");
  } catch (error) {
    failed.push(`Claude Code hooks: ${(error as Error).message}`);
  }
  try {
    codex.uninstallNotify(BIN);
    removed.push("Codex notify");
  } catch (error) {
    failed.push(`Codex notify: ${(error as Error).message}`);
  }

  if (removed.length) process.stdout.write(`Removed: ${removed.join(", ")}.\n`);
  process.stdout.write("Your progress is untouched.\n");
  if (failed.length) {
    for (const message of failed) process.stderr.write(`NOT removed — ${message}\n`);
    process.exit(1);
  }
}

function cmdStatus(): void {
  const file = paths.status();
  const raw = readJsonFile<unknown>(file);
  if (!raw.ok && raw.reason === "missing") {
    process.stdout.write("no agent state recorded yet — run `claudelingo init`\n");
    return;
  }
  const status = readStatus();
  if (!status) {
    // The file exists but is unusable; re-running init would not help.
    process.stdout.write(`${file} is unreadable — delete it and it will be rebuilt\n`);
    return;
  }
  const age = Math.round((Date.now() - status.ts) / 1000);
  process.stdout.write(`${status.state} (${status.source}: ${status.event}, ${age}s ago)\n`);
}

function cmdStats(args: Args): void {
  const { settings } = settingsFrom(args.flags);
  const pack = resolvePack(settings.lang);
  const { progress, problem } = loadProgress(settings.lang, false);
  if (problem) process.stderr.write(`${problem}\n`);
  const s = stats(pack, progress, Date.now());
  const rows: Array<[string, string]> = [
    ["language", `${pack.englishName} (${pack.code})`],
    ["words started", `${s.learned} of ${s.total}`],
    ["learning", String(s.learning)],
    ["in review", String(s.review)],
    ["mastered", String(s.mastered)],
    ["due now", String(s.due)],
    ["streak", `${s.streak} (best ${s.bestStreak})`],
    ["answered", String(progress.totalAnswered)],
    ["accuracy", progress.totalAnswered ? `${Math.round(s.accuracy * 100)}%` : "—"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(width)}  ${value}\n`);
  }
}

function cmdLangs(): void {
  const codes = listPacks();
  for (const code of codes) {
    try {
      const pack = loadPack(code);
      process.stdout.write(`${code.padEnd(6)}${pack.englishName.padEnd(14)}${pack.words.length} words\n`);
    } catch (error) {
      process.stdout.write(`${code.padEnd(6)}unreadable: ${(error as Error).message}\n`);
    }
  }
}

async function cmdPack(args: Args): Promise<void> {
  if (args.rest[0] !== "generate") fail("usage: claudelingo pack generate --lang <name>");
  const language = (args.flags.lang as string) || args.rest[1];
  if (!language) fail("pack generate needs --lang, e.g. --lang Portuguese");
  const code = (args.flags.code as string) || language.slice(0, 2).toLowerCase();
  const count = Number(args.flags.count ?? 300);
  const model = (args.flags.model as string) || loadSettings().settings.model;

  if (!hasCredentials()) {
    process.stdout.write("No ANTHROPIC_API_KEY found; trying the `ant auth login` profile…\n");
  }
  process.stdout.write(`Generating the top ${count} words in ${language} with ${model}…\n`);
  try {
    const raw = await generatePack(language, code, count, { model });
    const file = savePack(raw);
    process.stdout.write(`Wrote ${raw.words.length} words to ${file}\n`);
    process.stdout.write(`Study it with: ${BIN} --lang ${raw.code}\n`);
  } catch (error) {
    fail((error as Error).message);
  }
}

function cmdReset(args: Args): void {
  const { settings } = settingsFrom(args.flags);
  if (!args.flags.yes) {
    fail(`this erases your ${settings.lang} progress. Re-run with --yes to confirm.`);
  }
  const file = paths.progress(settings.lang);
  writeJsonAtomic(file, emptyProgress(settings.lang));
  process.stdout.write(`Reset progress for ${settings.lang}.\n`);
}

/** Panel width the terminal could plausibly have; guards against `"─".repeat(1e9)`. */
const MIN_WIDTH = 20;
const MAX_WIDTH = 1000;

function resolveWidth(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_WIDTH) return undefined;
  return Math.min(Math.floor(value), MAX_WIDTH);
}

async function cmdRun(args: Args): Promise<void> {
  ensureHome();
  const { settings, problem: settingsProblem } = settingsFrom(args.flags);
  const pack = resolvePack(settings.lang);
  const { progress, problem: progressProblem, readOnly } = loadProgress(settings.lang);
  const progressFile = paths.progress(settings.lang);
  const statusFile = paths.status();

  // One pane per language: two would each hold the whole deck in memory and the
  // second to save would erase the first's work.
  const lockFile = paths.lock(settings.lang);
  const acquired = lock.acquire(lockFile);
  if (!acquired.ok && acquired.reason === "held") {
    const who = acquired.pid === null ? "another claudelingo pane" : `pid ${acquired.pid}`;
    // Name the lock file: if the holder is gone but its pid has been recycled by an
    // unrelated process, deleting this file is the only way out.
    fail(
      `${who} is already studying ${pack.englishName}. ` +
        `Close it, or run this one with a different --lang. ` +
        `If no other pane is running, delete ${lockFile}.`,
    );
  }

  const problems: Partial<Record<ProblemKey, string>> = {};
  if (settingsProblem) problems.settings = settingsProblem;
  if (progressProblem) problems.deck = progressProblem;
  if (!acquired.ok) {
    // Its own key: filed under `save`, the next successful deck write would clear
    // it and the pane would look healthy while the guarantee was still off.
    problems.lock =
      `could not take the single-pane lock (${acquired.error.message}); ` +
      "close any other claudelingo pane for this language.";
  }

  if (!fs.existsSync(statusFile)) {
    try {
      writeStatus({ state: "idle", source: "manual", event: "startup", ts: Date.now() });
    } catch (error) {
      // Nothing else can see this: without a status file the pane is blind to
      // the agent, and no later write of a *different* file would reveal it.
      problems.status = `cannot record agent state: ${(error as Error).message}`;
    }
  }

  const enrich =
    settings.enrich && hasCredentials()
      ? (word: Word) => memoryHook(word, pack, { model: settings.model })
      : undefined;
  if (settings.enrich && !enrich) {
    // Told once, up front, rather than as a fresh auth error on every card.
    problems.credentials = "no Anthropic credential found, so memory hooks (e) are unavailable.";
  }

  const width = resolveWidth(args.flags.width);
  if (args.flags.width !== undefined && width === undefined) {
    process.stderr.write(
      `claudelingo: ignoring --width ${args.flags.width} (needs a number >= ${MIN_WIDTH})\n`,
    );
  }

  const runner = run({
    pack,
    progress,
    // With no fetcher wired, the pane must not offer `e` at all — otherwise it
    // shows "asking Claude…" against a request that will never be made.
    settings: enrich ? settings : { ...settings, enrich: false },
    progressFile,
    statusFile,
    // Codex has no turn-start hook, so its transcript is tailed for that edge.
    watchCodex: (onState, onError) => codex.watchCodexSession(onState, { onError }),
    ...(enrich ? { enrich } : {}),
    ...(Object.keys(problems).length ? { initialProblems: problems } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(args.flags.color === false ? { color: false } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(process.env.CLAUDELINGO_FORCE_RENDER ? { forceRender: true } : {}),
  });

  const release = () => {
    if (acquired.ok) acquired.lock.release();
  };
  const onSignal = () => runner.stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await runner.done;
  } finally {
    release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.help || args.command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  switch (args.command) {
    case "hook": return cmdHook(args);
    case "notify": return cmdNotify(args);
    case "init": return cmdInit(args);
    case "uninit": return cmdUninit(args);
    case "status": return cmdStatus();
    case "stats": return cmdStats(args);
    case "langs": return cmdLangs();
    case "pack": return cmdPack(args);
    case "reset": return cmdReset(args);
    default: return cmdRun(args);
  }
}

/**
 * Only run when this file *is* the entry point.
 *
 * Matching on the path containing "claudelingo" was far too loose: under a test
 * runner `argv[1]` is the worker script, whose path contains the project name, so
 * importing anything from this module started a pane against the user's real home.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error: Error) => fail(error.message));
}
