#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { DEFAULT_SETTINGS, ensureHome, loadSettings, paths, readJson, saveSettings, writeJsonAtomic } from "./config.js";
import { emptyProgress, stats } from "./srs.js";
import { listPacks, loadPack, savePack } from "./packs/index.js";
import { readStatus, stateForEvent, writeStatus } from "./agentState.js";
import * as claudeCode from "./integrations/claudeCode.js";
import * as codex from "./integrations/codex.js";
import { DEFAULT_MODEL, generatePack, hasCredentials, memoryHook } from "./enrich.js";
import { run } from "./ui/tui.js";
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

function settingsFrom(flags: Args["flags"]): Settings {
  const stored = loadSettings();
  const settings: Settings = { ...stored };
  if (typeof flags.lang === "string" && flags.lang) settings.lang = flags.lang;
  if (flags["always-on"] === true) settings.alwaysOn = true;
  if (flags["always-on"] === false) settings.alwaysOn = false;
  if (flags.enrich === false) settings.enrich = false;
  if (typeof flags.model === "string" && flags.model) settings.model = flags.model;
  return settings;
}

function loadProgress(lang: string): Progress {
  const stored = readJson<Progress>(paths.progress(lang));
  if (stored?.items && stored.version === 1) return { ...emptyProgress(lang), ...stored };
  return emptyProgress(lang);
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

  const settingsFile = claudeCode.settingsPath(scope as "user" | "project");
  try {
    claudeCode.install(settingsFile, BIN);
    process.stdout.write(`Claude Code hooks installed in ${settingsFile}\n`);
    process.stdout.write(`  ${claudeCode.HOOK_EVENTS.join(", ")}\n`);
  } catch (error) {
    process.stderr.write(`Claude Code hooks skipped: ${(error as Error).message}\n`);
  }

  try {
    codex.installNotify(BIN);
    process.stdout.write(`Codex notify installed in ${codex.codexConfigPath()}\n`);
  } catch (error) {
    process.stderr.write(`Codex notify skipped: ${(error as Error).message}\n`);
  }

  const settings = settingsFrom(args.flags);
  saveSettings(settings);
  process.stdout.write(`\nStudying ${resolvePack(settings.lang).englishName}.\n`);
  process.stdout.write(`Open the pane in a second terminal with: ${BIN}\n`);
}

function cmdUninit(args: Args): void {
  const scope = args.flags.project ? "project" : "user";
  claudeCode.uninstall(claudeCode.settingsPath(scope as "user" | "project"));
  codex.uninstallNotify(BIN);
  process.stdout.write("Integrations removed. Your progress is untouched.\n");
}

function cmdStatus(): void {
  const status = readStatus();
  if (!status) {
    process.stdout.write("no agent state recorded yet — run `claudelingo init`\n");
    return;
  }
  const age = Math.round((Date.now() - status.ts) / 1000);
  process.stdout.write(`${status.state} (${status.source}: ${status.event}, ${age}s ago)\n`);
}

function cmdStats(args: Args): void {
  const settings = settingsFrom(args.flags);
  const pack = resolvePack(settings.lang);
  const progress = loadProgress(settings.lang);
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
    } catch {
      process.stdout.write(`${code.padEnd(6)}(unreadable pack)\n`);
    }
  }
}

async function cmdPack(args: Args): Promise<void> {
  if (args.rest[0] !== "generate") fail("usage: claudelingo pack generate --lang <name>");
  const language = (args.flags.lang as string) || args.rest[1];
  if (!language) fail("pack generate needs --lang, e.g. --lang Portuguese");
  const code = (args.flags.code as string) || language.slice(0, 2).toLowerCase();
  const count = Number(args.flags.count ?? 300);
  const model = (args.flags.model as string) || loadSettings().model;

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
  const settings = settingsFrom(args.flags);
  if (!args.flags.yes) {
    fail(`this erases your ${settings.lang} progress. Re-run with --yes to confirm.`);
  }
  const file = paths.progress(settings.lang);
  writeJsonAtomic(file, emptyProgress(settings.lang));
  process.stdout.write(`Reset progress for ${settings.lang}.\n`);
}

async function cmdRun(args: Args): Promise<void> {
  ensureHome();
  const settings = settingsFrom(args.flags);
  const pack = resolvePack(settings.lang);
  const progress = loadProgress(settings.lang);
  const progressFile = paths.progress(settings.lang);
  const statusFile = paths.status();

  if (!fs.existsSync(statusFile)) {
    writeStatus({ state: "idle", source: "manual", event: "startup", ts: Date.now() });
  }

  // Codex only tells us when a turn ends, so tail its transcript for the start.
  const codexWatcher = fs.existsSync(codex.codexSessionsDir())
    ? codex.watchCodexSession((state) => {
        const current = readStatus(statusFile);
        if (current?.state === state) return;
        writeStatus({ state, source: "codex", event: "rollout", ts: Date.now() }, statusFile);
      })
    : null;

  const enrich = settings.enrich
    ? (word: Word) => memoryHook(word, pack, { model: settings.model })
    : undefined;

  const runner = run({
    pack,
    progress,
    settings,
    progressFile,
    statusFile,
    ...(enrich ? { enrich } : {}),
    ...(args.flags.color === false ? { color: false } : {}),
    ...(args.flags.width ? { width: Number(args.flags.width) } : {}),
    ...(process.env.CLAUDELINGO_FORCE_RENDER ? { forceRender: true } : {}),
  });

  const onSignal = () => runner.stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await runner.done;
  codexWatcher?.stop();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
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

const invokedDirectly = process.argv[1] && /claudelingo|cli\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: Error) => fail(error.message));
}
