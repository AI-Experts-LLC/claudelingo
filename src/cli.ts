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
import {
  applyAnswer,
  buildCard,
  deferItem,
  emptyProgress,
  isCorrect,
  makeRng,
  selectNext,
  stats,
} from "./srs.js";
import { clean, listPacks, loadPack, savePack } from "./packs/index.js";
import { readStatus, stateForEvent, writeStatus } from "./agentState.js";
import * as claudeCode from "./integrations/claudeCode.js";
import * as codex from "./integrations/codex.js";
import { DEFAULT_MODEL, generatePack, hasClaude, memoryHook } from "./enrich.js";
import { run } from "./ui/tui.js";
import { defaultWidth, renderPanel, renderStatusLine } from "./statusline.js";
import { launch, openPaneBeside } from "./launcher.js";
import type { ProblemKey } from "./ui/app.js";
import type { Card, Pack, Progress, Settings, Word } from "./types.js";

const BIN = "claudelingo";

const USAGE = `claudelingo — learn a language while your coding agent works

  claudelingo start [args]         start Claude Code with the pane beside it
  claudelingo [options]            open the companion pane on its own
  claudelingo init [--project]     install Claude Code + Codex integrations
  claudelingo uninit [--project]   remove them again
  claudelingo hook <event>         report agent state (called by hooks)
  claudelingo notify [json]        Codex notify target
  claudelingo status               show the current agent state
  claudelingo statusline           the panel Claude Code draws (called by Claude Code)
  claudelingo next --json          hand out one card, for the /lingo skill
  claudelingo answer --choice N    grade the card next handed out
  claudelingo skip                 drop the outstanding card, delay it 10 minutes
  claudelingo lang [code]          show or change the language you are studying
  claudelingo panel [on|off]       full panel under the prompt, or one line
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
  --compact          one line instead of the panel (for: statusline)
  --model <id>       model for hooks and pack generation (default: ${DEFAULT_MODEL})
  --code <xx>        code for a generated pack (default: first two letters)
  --overwrite        replace an existing generated pack
  --no-statusline    do not touch Claude Code's status line (for: init)
  --statusline-only  install just the status line, nothing else (for: init)
  --no-auto-pane     do not open the pane automatically (for: init)
  --auto-pane        open it automatically again (for: init)
  --ask              ask before starting a quiz (set for panes that self-open)
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
  const takesValue = new Set(["lang", "width", "source", "model", "count", "code", "home", "choice", "text"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
    } else if (arg.startsWith("--")) {
      const [rawName, inline] = arg.slice(2).split("=", 2);
      const name = rawName as string;
      if (inline !== undefined) flags[name] = inline;
      else if (takesValue.has(name)) flags[name] = argv[++i] ?? "";
      // A trailing `--lang` with nothing after it is a typo, not a request for
      // the configured default.
      else if (name.startsWith("no-")) flags[name.slice(3)] = false;
      else flags[name] = true;
    } else {
      positional.push(arg);
    }
  }

  const known = new Set([
    "init", "uninit", "hook", "notify", "status", "statusline", "session-start", "stats",
    "langs", "pack", "reset", "claude", "start", "next", "answer", "skip", "lang", "panel", "help",
  ]);
  const first = positional[0];
  // A word we do not know is a typo, not a request for the pane. Treating it as
  // one opened a full-screen TUI that then sat waiting on stdin: no output, no
  // error, no way to tell what went wrong. Bare `claudelingo` (no positional at
  // all) is still how you open the pane.
  const command = first === undefined ? "run" : known.has(first) ? first : "unknown";
  // `unknown` keeps the offending word at rest[0]; an error that cannot name what
  // it rejected is barely an error at all.
  const rest = command === "run" || command === "unknown" ? positional : positional.slice(1);
  return { command, rest, flags };
}

interface Resolved {
  settings: Settings;
  /** Set when an existing settings file could not be parsed. */
  problem?: string;
}

// `choice` and `text` were missing here while being in `takesValue`, so
// `answer --choice` with nothing after it became choice "" → -1 → graded wrong,
// demoting a box, while reporting success.
const VALUE_FLAGS = ["lang", "width", "source", "model", "count", "code", "choice", "text"] as const;

function requireFlagValues(flags: Args["flags"]): void {
  for (const name of VALUE_FLAGS) {
    if (flags[name] === "") fail(`--${name} needs a value`);
  }
}

function settingsFrom(flags: Args["flags"]): Resolved {
  requireFlagValues(flags);
  const loaded = loadSettings();
  const settings: Settings = { ...loaded.settings };
  if (typeof flags.lang === "string" && flags.lang) settings.lang = flags.lang;
  if (flags["always-on"] === true) settings.alwaysOn = true;
  if (flags["always-on"] === false) settings.alwaysOn = false;
  if (flags.enrich === false) settings.enrich = false;
  if (typeof flags.model === "string" && flags.model) settings.model = flags.model;
  if (flags["auto-pane"] === false) settings.autoPane = false;
  if (flags["auto-pane"] === true) settings.autoPane = true;
  if (flags.ask === true) settings.askFirst = true;
  if (flags.ask === false) settings.askFirst = false;
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
    // A shape check, not a truthiness check: `items: "oops"` is truthy, and
    // spreading it produces a deck of individual characters that then gets saved
    // back over the real file.
    const items = stored?.items;
    const wellFormed =
      stored?.version === 1 && typeof items === "object" && items !== null && !Array.isArray(items);
    if (wellFormed) return { progress: { ...emptyProgress(lang), ...stored } };
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
  // The plugin carries the hooks and the skill; what it cannot carry is the
  // status line, which Claude Code only accepts from the main config. This is
  // the one thing a plugin user has to run by hand.
  const onlyStatusLine = args.flags["statusline-only"] === true;
  const wantStatusLine = onlyStatusLine || args.flags.statusline !== false;
  try {
    const result = claudeCode.install(settingsFile, BIN, {
      statusLineBin: claudeCode.statusLineCommand(fileURLToPath(import.meta.url), BIN),
      statusLine: wantStatusLine,
      ...(onlyStatusLine ? { hooks: false } : {}),
    });
    if (!onlyStatusLine) {
      process.stdout.write(`Claude Code hooks installed in ${settingsFile}\n`);
      process.stdout.write(`  ${claudeCode.HOOK_EVENTS.join(", ")}\n`);
    }
    if (wantStatusLine && !result.statusLineProblem) {
      process.stdout.write("Status line installed — words appear under your prompt.\n");
    } else if (result.statusLineProblem) {
      // Not fatal: the hooks are what make the pane work at all.
      process.stderr.write(`Status line NOT installed: ${result.statusLineProblem}\n`);
    }
  } catch (error) {
    failed.push("Claude Code");
    process.stderr.write(`Claude Code hooks NOT installed: ${(error as Error).message}\n`);
  }

  if (onlyStatusLine) {
    // Nothing else belongs to this mode: the plugin owns the rest.
    if (failed.length) process.exit(1);
    return;
  }

  // `/lingo` is half the product for anyone not in tmux, and the standalone
  // install used to leave it out entirely.
  try {
    const skill = claudeCode.installSkill(fileURLToPath(import.meta.url));
    if (skill.state === "linked") process.stdout.write(`/lingo skill linked into ${skill.path}\n`);
    else if (skill.state === "already") process.stdout.write("/lingo skill already installed.\n");
    else if (skill.state === "plugin") process.stdout.write("/lingo comes from the plugin.\n");
    else if (skill.state === "missing") {
      // Saying nothing here is what left /lingo unavailable and unexplained.
      process.stderr.write("/lingo NOT installed: this build has no skills/ beside it.\n");
    } else if (skill.state === "taken") {
      process.stderr.write(
        `/lingo NOT installed: ${skill.path} exists and is not ours; leaving it alone.\n`,
      );
    }
  } catch (error) {
    // Not fatal: the pane and the status line work without it.
    process.stderr.write(`/lingo skill NOT installed: ${(error as Error).message}\n`);
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
  if (!failed.length) {
    process.stdout.write("Just open Claude Code as usual:\n");
    process.stdout.write("  · words appear on the status line under your prompt\n");
    process.stdout.write(
      settings.autoPane
        ? "  · the quiz pane opens itself beside you when you are in tmux\n"
        : "  · open the quiz pane yourself with: claudelingo\n",
    );
  }
  if (failed.length) {
    // Exiting 0 here is how a user ends up staring at a pane that never wakes up.
    process.stderr.write(
      `\n${failed.join(" and ")} integration${failed.length > 1 ? "s are" : " is"} not active — ` +
        "the pane will not wake up for it.\n",
    );
    process.exit(1);
  }
}

function cmdUninit(args: Args): void {
  const scope = args.flags.project ? "project" : "user";
  const removed: string[] = [];
  const failed: string[] = [];

  // Attempted independently: a throw from one must not skip the other, or the user
  // is left half-uninstalled with no idea which half.
  try {
    const file = claudeCode.settingsPath(scope as "user" | "project");
    const hadOurs = claudeCode.hasOurStatusLine(file, BIN);
    claudeCode.uninstall(file, BIN);
    // Saying we removed a status line that was never ours is how someone
    // concludes their own configuration has been eaten.
    removed.push(hadOurs ? "Claude Code hooks and status line" : "Claude Code hooks");
  } catch (error) {
    failed.push(`Claude Code hooks: ${(error as Error).message}`);
  }
  try {
    if (claudeCode.uninstallSkill(fileURLToPath(import.meta.url))) removed.push("the /lingo skill");
  } catch (error) {
    failed.push(`/lingo skill: ${(error as Error).message}`);
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

/**
 * `claudelingo next --json` — hand Claude one card to ask.
 *
 * Deliberately does NOT say which answer is right. Claude presents the question
 * and passes the choice back to `answer`, which grades it: the schedule stays the
 * authority, and a model cannot mark its own homework or leak the answer into the
 * transcript before the user has replied.
 *
 * The card is remembered on disk so `answer` refers to the same one, with the
 * same shuffle.
 */
function cmdNext(args: Args): void {
  const { settings } = settingsFrom(args.flags);
  const pack = resolvePack(settings.lang);
  const { progress, readOnly } = loadProgress(settings.lang, false);
  const now = Date.now();

  // A live pane owns the deck; two graders would fight over the same file.
  if (lock.isHeld(paths.lock(settings.lang))) {
    emit({ error: "a claudelingo pane is already open — answer there instead" });
    return;
  }
  if (readOnly) {
    emit({ error: `${paths.progress(settings.lang)} could not be read` });
    return;
  }

  const next = selectNext(pack, progress, settings, now);
  if (!next) {
    emit({ done: true, message: "nothing due right now", stats: stats(pack, progress, now) });
    return;
  }

  const card = buildCard(pack, next.word, next.item, makeRng(now));
  const question =
    card.kind === "recognize"
      ? `What does "${card.prompt}" mean?`
      : card.kind === "reverse"
        ? `How do you say "${card.prompt}" in ${pack.englishName}?`
        : card.kind === "teach"
          ? `New word: "${card.word.term}" (${card.word.pos}) means "${card.word.gloss}".`
          : `Spell the ${pack.englishName} word for "${card.prompt}".`;

  try {
    writeJsonAtomic(paths.pending(settings.lang), {
      id: card.word.id,
      kind: card.kind,
      // Stored so the panel can show the outstanding question without dealing a
      // card of its own — it is a display, and dealing would mutate the schedule.
      question,
      choices: card.choices,
      answerIndex: card.answerIndex,
      accepted: card.accepted,
      issued: now,
    });
  } catch (error) {
    emit({ error: `could not record the question: ${(error as Error).message}` });
    return;
  }

  emit({
    card: {
      id: card.word.id,
      kind: card.kind,
      question,
      choices: card.choices,
      note: card.word.note ?? null,
    },
    stats: stats(pack, progress, now),
  });
}

/**
 * `claudelingo skip` — drop the outstanding question without grading it.
 *
 * The card is pushed ten minutes out, exactly as the pane's `s` does, because a
 * skip that left the schedule alone would hand the same card straight back and
 * the panel would look stuck.
 */
function cmdSkip(args: Args): void {
  const { settings } = settingsFrom(args.flags);
  const pack = resolvePack(settings.lang);
  const pendingFile = paths.pending(settings.lang);
  const pending = readJsonFile<Record<string, unknown>>(pendingFile);

  if (!pending.ok && pending.reason === "missing") {
    emit({ error: "no question is outstanding — run `claudelingo next --json` first" });
    return;
  }
  if (lock.isHeld(paths.lock(settings.lang))) {
    emit({ error: "a claudelingo pane is already open — skip there instead" });
    return;
  }
  const outstanding = pending.ok ? (pending.value as Record<string, unknown> | null) : null;
  const id = outstanding && typeof outstanding.id === "string" ? outstanding.id : null;
  if (!id) {
    // The file is there but says nothing usable. Skip is the one command whose
    // whole job is "get rid of this question", and the panel offers it as the way
    // out — refusing here leaves the user staring at a card no command can clear.
    // Nothing is graded, so nothing is at risk in dropping it.
    try {
      fs.rmSync(pendingFile, { force: true });
    } catch (error) {
      emit({ error: `could not drop the question: ${(error as Error).message}` });
      return;
    }
    emit({ skipped: true, term: null, unreadable: true });
    return;
  }

  const held = lock.acquire(paths.lock(settings.lang));
  if (!held.ok) {
    emit({ error: "could not take the deck lock" });
    return;
  }
  try {
    const { progress, readOnly } = loadProgress(settings.lang, false);
    if (readOnly) {
      emit({ error: "the deck is not writable, so the skip was not recorded" });
      return;
    }
    const word = pack.words.find((w) => w.id === id);
    if (!word) {
      // The card left the pack under us. Dropping the question is still right.
      fs.rmSync(pendingFile, { force: true });
      emit({ skipped: true, term: null });
      return;
    }
    const now = Date.now();
    const updated = { ...progress, items: { ...progress.items, [id]: deferItem(progress.items[id], id, now) } };
    writeJsonAtomic(paths.progress(settings.lang), updated);
    fs.rmSync(pendingFile, { force: true });
    emit({ skipped: true, term: word.term, stats: stats(pack, updated, now) });
  } finally {
    held.lock?.release();
  }
}

/**
 * Settings to write back, or a reason not to.
 *
 * Two traps, both of which this file has fallen into. Writing over a settings
 * file that could not be read discards the user's language and model choice
 * without them ever knowing — `cmdInit` guards that, and the writers added later
 * did not. And writing back the *flag-merged* settings turns a one-off
 * `--no-enrich` into a permanent preference, so the file's own values are what
 * gets persisted here.
 */
function settingsToWrite(): { settings: Settings } | { problem: string } {
  const loaded = loadSettings();
  if (loaded.problem) {
    return { problem: `${loaded.problem} leaving it alone; fix or delete it, then re-run.` };
  }
  return { settings: loaded.settings };
}

/**
 * `claudelingo panel [on|off]` — how much room the status line takes.
 *
 * On, it draws the whole widget under the prompt; off, it is the one-line drill.
 * Nothing else changes: both forms are read-only views of the same deck.
 */
function cmdPanel(args: Args): void {
  const { settings } = settingsFrom(args.flags);
  const wanted = typeof args.rest[0] === "string" ? args.rest[0].toLowerCase() : null;

  if (wanted === null) {
    emit({ panel: settings.panel !== false });
    return;
  }
  if (wanted !== "on" && wanted !== "off") {
    emit({ error: `say "on" or "off", not "${wanted}"` });
    return;
  }
  const panel = wanted === "on";
  // The pane writes settings when it exits, so a change made behind its back can
  // simply be written over. Refusing is what the skill already promises.
  if (lock.isHeld(paths.lock(settings.lang))) {
    emit({ error: "a claudelingo pane is open — close it first, or change this from there" });
    return;
  }
  const target = settingsToWrite();
  if ("problem" in target) {
    emit({ error: target.problem });
    return;
  }
  saveSettings({ ...target.settings, panel });
  emit({ panel, changed: (settings.panel !== false) !== panel });
}

/**
 * `claudelingo lang [code]` — report or change the language being studied.
 *
 * Refused while a pane is open: that pane holds the deck and writes the setting
 * itself when it switches, so a second writer here would fight it.
 */
function cmdLang(args: Args): void {
  // Deliberately not `settingsFrom`: with `lang fr --lang it` the flag would make
  // "the language being left" italian, and the pending-file cleanup would delete
  // the wrong one. The positional is the request; the file is the current state.
  const settings = loadSettings().settings;
  const wanted = typeof args.rest[0] === "string" ? args.rest[0].toLowerCase() : null;
  const codes = listPacks();

  const describe = (code: string): { code: string; englishName: string } => {
    try {
      return { code, englishName: loadPack(code).englishName };
    } catch {
      return { code, englishName: code };
    }
  };

  if (!wanted) {
    emit({
      lang: settings.lang,
      englishName: describe(settings.lang).englishName,
      available: codes.map(describe),
    });
    return;
  }

  if (!codes.includes(wanted)) {
    emit({ error: `no pack for "${wanted}" — installed: ${codes.join(", ")}` });
    return;
  }
  const chosen = describe(wanted);
  if (wanted === settings.lang) {
    emit({ lang: wanted, englishName: chosen.englishName, changed: false });
    return;
  }
  if (lock.isHeld(paths.lock(settings.lang)) || lock.isHeld(paths.lock(wanted))) {
    emit({ error: "a claudelingo pane is open — press l there to change language instead" });
    return;
  }

  const target = settingsToWrite();
  if ("problem" in target) {
    emit({ error: target.problem });
    return;
  }
  saveSettings({ ...target.settings, lang: wanted });
  // The outstanding question belongs to the language being left behind; grading
  // it against the new deck would file the answer under the wrong word.
  fs.rmSync(paths.pending(settings.lang), { force: true });
  emit({ lang: wanted, englishName: chosen.englishName, changed: true });
}

/** `claudelingo answer --choice N | --text S` — grade the card `next` handed out. */
function cmdAnswer(args: Args): void {
  const { settings } = settingsFrom(args.flags);
  const pack = resolvePack(settings.lang);
  const pendingFile = paths.pending(settings.lang);
  const pending = readJsonFile<{
    id: string;
    kind: Card["kind"];
    choices: string[];
    answerIndex: number;
    accepted: string[];
  }>(pendingFile);

  if (!pending.ok) {
    emit({ error: "no question is outstanding — run `claudelingo next --json` first" });
    return;
  }
  if (lock.isHeld(paths.lock(settings.lang))) {
    emit({ error: "a claudelingo pane is already open — answer there instead" });
    return;
  }

  // Parsing is not enough: a file that is valid JSON but the wrong shape throws
  // out of the grader, and the skill's contract is one line of JSON.
  const outstanding = pending.value as Partial<typeof pending.value> | null;
  if (
    !outstanding ||
    typeof outstanding.id !== "string" ||
    !Array.isArray(outstanding.choices) ||
    !Array.isArray(outstanding.accepted) ||
    typeof outstanding.answerIndex !== "number"
  ) {
    emit({ error: "the outstanding question is unreadable — run `claudelingo next --json` again" });
    return;
  }

  const held = lock.acquire(paths.lock(settings.lang));
  if (!held.ok) {
    emit({ error: "could not take the deck lock" });
    return;
  }

  try {
    const { progress, readOnly } = loadProgress(settings.lang);
    if (readOnly) {
      emit({ error: "the deck is not writable, so this answer was not recorded" });
      return;
    }
    const word = pack.words.find((w) => w.id === pending.value.id);
    if (!word) {
      emit({ error: "that card is no longer in the pack" });
      return;
    }

    const card: Card = {
      kind: pending.value.kind,
      word,
      prompt: "",
      choices: pending.value.choices,
      answerIndex: pending.value.answerIndex,
      accepted: pending.value.accepted,
    };
    const choice = args.flags.choice === undefined ? undefined : Number(args.flags.choice) - 1;
    const text = typeof args.flags.text === "string" ? args.flags.text : undefined;
    // No answer at all is not a wrong answer. Grading it as one demotes a box and
    // breaks a streak while reporting `{"correct":false}` — indistinguishable
    // from the user actually getting it wrong, and this command is driven by a
    // model's output, so one malformed call would cost them progress silently.
    if (choice === undefined && text === undefined) {
      emit({ error: "say which answer: --choice N, or --text \"...\"" });
      return;
    }
    const correct = isCorrect(card, {
      ...(choice !== undefined ? { choice } : {}),
      ...(text !== undefined ? { text } : {}),
    });

    const now = Date.now();
    const updated = applyAnswer(progress, word, card, correct, now);
    writeJsonAtomic(paths.progress(settings.lang), updated);
    fs.rmSync(pendingFile, { force: true });

    emit({
      correct,
      term: word.term,
      gloss: word.gloss,
      note: word.note ?? null,
      stats: stats(pack, updated, now),
    });
  } finally {
    if (held.ok) held.lock.release();
  }
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * `claudelingo statusline` — Claude Code renders whatever this prints.
 *
 * Claude Code pipes session JSON in and cancels the script if it is still running
 * when the next update fires, so this stays read-only and fast: no locks, no
 * writes, no network. It must also never fail loudly — a broken status line
 * should be a blank line, not noise in the middle of someone's session.
 */
async function cmdStatusline(args: Args): Promise<void> {
  try {
    // The payload is not needed today, but it has to be drained or Claude Code
    // can see a broken pipe.
    await readStdin();
    const { settings } = settingsFrom(args.flags);
    const pack = loadPack(settings.lang);
    const { progress } = loadProgress(settings.lang, false);
    const width = resolveWidth(args.flags.width) ?? defaultWidth();
    const options = {
      color: args.flags.color !== false,
      ...(width !== undefined ? { width } : {}),
    };
    // `--compact` wins over the setting: it is how someone tries the one-liner
    // without editing anything.
    const wantPanel = args.flags.compact ? false : settings.panel !== false;

    // Strictly a read of the pending file: the panel shows the outstanding
    // question, and grading stays with `answer`, which holds the lock.
    const pendingFile = paths.pending(settings.lang);
    // Presence, not parseability — see `outstanding` in StatusLineOptions.
    const outstanding = fs.existsSync(pendingFile);
    const stored = readJsonFile<Record<string, unknown>>(pendingFile);
    const value = stored.ok ? (stored.value as Record<string, unknown> | null) : null;
    const pending =
      value && typeof value.question === "string" && Array.isArray(value.choices)
        ? {
            // The pack boundary strips control characters; this file is trusted
            // the same way and must be, or a newline in a question becomes an
            // extra terminal row and the fixed height is no longer fixed.
            question: clean(value.question),
            choices: value.choices
              .filter((c): c is string => typeof c === "string")
              .map((c) => clean(c)),
            ...(typeof value.kind === "string" ? { kind: clean(value.kind) } : {}),
          }
        : null;
    // `outstanding` is presence on disk; `pending` is the readable form of it.
    // Both renderers need both: the panel shows the question, the one-line form
    // has no room for it and must say so rather than drilling the same word.
    const full = { ...options, pending, outstanding };
    if (!wantPanel) {
      process.stdout.write(`${renderStatusLine(pack, progress, Date.now(), full)}\n`);
      return;
    }
    for (const line of renderPanel(pack, progress, Date.now(), full)) {
      process.stdout.write(`${line}\n`);
    }
  } catch {
    // Silence is the correct failure mode here.
    process.stdout.write("\n");
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    let settled = false;
    const timer = setTimeout(() => done(), 250);

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Resolving is not enough: a stdin still being read keeps the event loop
      // alive, so a writer that sends the payload and holds the pipe open would
      // leave a process behind on every refresh tick.
      process.stdin.destroy();
      resolve(data);
    };

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * `claudelingo session-start` — Claude Code runs this when a session begins.
 *
 * Its job is to put the pane on screen without the user asking. It has to be
 * silent and quick: it is wired with `async: true` so it cannot block the session,
 * and anything it prints would land in the middle of Claude Code's startup.
 */
async function cmdSessionStart(args: Args): Promise<void> {
  try {
    await readStdin(); // drain Claude Code's payload
    const { settings } = settingsFrom(args.flags);
    if (!settings.autoPane) return;

    // Only inside tmux: there is nowhere to put a pane otherwise, and spawning a
    // window the user did not ask for would be worse than doing nothing.
    if (!process.env.TMUX) return;

    // A pane already studying this language holds the lock. Opening a second one
    // would just produce a pane that exits immediately with a refusal. Checked for
    // liveness: a lock left by a killed pane would otherwise disable this for good.
    if (lock.isHeld(paths.lock(settings.lang))) return;

    const entry = process.argv[1];
    if (!entry) return;
    // `--ask`: this pane appeared without being asked for, so it checks before
    // it starts quizzing.
    const pane = [process.execPath, fs.realpathSync(entry), "--lang", settings.lang, "--ask"];
    const passEnv: Record<string, string> = {};
    if (process.env.CLAUDELINGO_HOME) passEnv.CLAUDELINGO_HOME = process.env.CLAUDELINGO_HOME;

    openPaneBeside({ pane, ...(Object.keys(passEnv).length ? { passEnv } : {}) });
  } catch {
    // A hook that fails must never disturb the session it is attached to.
  }
}

/** `claudelingo claude [...]` — start the agent with the pane beside it. */
async function cmdLaunch(args: Args, agentArgs: string[]): Promise<void> {
  const { settings } = settingsFrom(args.flags);
  resolvePack(settings.lang); // fail early on a bad --lang rather than in the pane

  // Address the pane by absolute path rather than by name: a new tmux pane gets
  // the tmux server's PATH, which may well not include wherever claudelingo lives.
  const entry = process.argv[1];
  const pane = entry
    ? [process.execPath, fs.realpathSync(entry), "--lang", settings.lang, "--ask"]
    : [BIN, "--lang", settings.lang, "--ask"];

  const passEnv: Record<string, string> = {};
  if (process.env.CLAUDELINGO_HOME) passEnv.CLAUDELINGO_HOME = process.env.CLAUDELINGO_HOME;

  const result = await launch({
    agent: ["claude", ...agentArgs],
    pane,
    ...(Object.keys(passEnv).length ? { passEnv } : {}),
  });

  if (result.plan.kind === "none" || result.plan.reason) {
    process.stderr.write(
      `claudelingo: ${result.plan.reason ?? "could not open the pane"}. ` +
        `Open it yourself in another terminal with: ${BIN} --lang ${settings.lang}\n`,
    );
  }
  process.exit(result.code);
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
  // The two-letter default collides readily — Estonian and Spanish both give "es" —
  // and savePack refuses a bundled code outright, so say which codes are taken.
  if (!args.flags.code && listPacks().includes(code)) {
    fail(
      `"${code}" is already in use (the default code is the first two letters of ` +
        `"${language}"). Re-run with an explicit --code.`,
    );
  }
  const count = Number(args.flags.count ?? 300);
  const model = (args.flags.model as string) || loadSettings().settings.model;

  if (!hasClaude()) fail("the `claude` command is not on your PATH");
  process.stdout.write(
    `Generating the top ${count} words in ${language} with ${model}, ` +
      "through your Claude Code session…\n",
  );
  try {
    const raw = await generatePack(language, code, count, { model });
    const file = savePack(raw, { overwrite: args.flags.overwrite === true });
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

  // Take the same lock the pane takes. Without it, reset writes an empty deck and
  // reports success while an open pane simply saves its whole in-memory deck back
  // over the top — the one command whose job is destroying data would be the one
  // command that ignores the single-writer guarantee.
  const lockFile = paths.lock(settings.lang);
  const held = lock.acquire(lockFile);
  if (!held.ok) {
    if (held.reason === "held") {
      const who = held.pid === null ? "another claudelingo pane" : `pid ${held.pid}`;
      fail(
        `${who} is studying ${settings.lang} and would write its deck back over the ` +
          `reset. Close it and try again. If no pane is running, delete ${lockFile}.`,
      );
    }
    fail(`could not take the lock for ${settings.lang} (${held.error.message}); not resetting.`);
  }

  try {
    writeJsonAtomic(paths.progress(settings.lang), emptyProgress(settings.lang));
    // An outstanding question belongs to the deck that was just erased; grading
    // it afterwards would file an answer against a word with no history.
    fs.rmSync(paths.pending(settings.lang), { force: true });
  } finally {
    held.lock.release();
  }
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
      `no single-pane lock (${acquired.error.message}) — another pane could ` +
      "overwrite this one's progress. Close any other pane for this language.";
  }

  if (!fs.existsSync(statusFile)) {
    try {
      writeStatus({ state: "idle", source: "manual", event: "startup", ts: Date.now() });
    } catch (error) {
      // Nothing else can see this: without a status file the pane is blind to
      // the agent, and no later write of a *different* file would reveal it.
      problems.statusWrite = `cannot record agent state: ${(error as Error).message}`;
    }
  }

  const enrich =
    settings.enrich && hasClaude()
      ? (word: Word) => memoryHook(word, pack, { model: settings.model })
      : undefined;
  if (settings.enrich && !enrich) {
    // Told once, up front, rather than as a fresh failure on every card.
    problems.credentials =
      "the `claude` command is not on this PATH, so memory hooks (e) are unavailable.";
  }

  const width = resolveWidth(args.flags.width);
  if (args.flags.width !== undefined && width === undefined) {
    process.stderr.write(
      `claudelingo: ignoring --width ${args.flags.width} (needs a number >= ${MIN_WIDTH})\n`,
    );
  }

  // Every installed pack, so the picker inside the pane can offer them.
  const languages = listPacks().flatMap((code) => {
    try {
      const installed = loadPack(code);
      return [{ code, englishName: installed.englishName, words: installed.words.length }];
    } catch {
      return [];
    }
  });

  /**
   * Move to another language: new pack, new deck, and the lock moves with it.
   *
   * Held one language at a time, so switching has to release the old lock before
   * taking the new one, or the pane blocks itself out of its own deck.
   */
  let held = acquired;
  let currentLang = settings.lang;
  const switchLanguage = (code: string) => {
    // Belt and braces: the reducer already refuses to emit this for the language
    // in use, because the acquire/release round trip on one file deletes the very
    // lock this process holds.
    if (code === currentLang) return null;
    let next: Pack;
    try {
      next = loadPack(code);
    } catch {
      return null;
    }
    const taken = lock.acquire(paths.lock(code));
    if (!taken.ok) return null;
    if (held.ok) held.lock.release();
    held = taken;
    currentLang = code;
    // Passed through whole: `readOnly` and `problem` are properties of THIS
    // language's deck. Dropping them let the pane write an empty deck over one
    // it merely failed to read.
    const loaded = loadProgress(code);
    return {
      pack: next,
      progress: loaded.progress,
      progressFile: paths.progress(code),
      ...(loaded.readOnly ? { readOnly: true } : {}),
      ...(loaded.problem ? { problem: loaded.problem } : {}),
    };
  };

  const runner = run({
    pack,
    progress,
    languages,
    switchLanguage,
    saveSettings: (updated) => saveSettings(updated),
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
    if (held.ok) held.lock.release();
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

/**
 * Index of `name` only if it is the first positional argument.
 *
 * Mirrors `parseArgs`'s idea of which flags consume the token after them, so a
 * flag *value* that happens to read like a subcommand is not mistaken for one.
 */
function subcommandIndex(argv: string[], name: string): number {
  const takesValue = new Set(["lang", "width", "source", "model", "count", "code", "home", "choice", "text"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // `parseArgs` treats anything not starting with `--` as a positional, so this
    // loop must agree with it or the two disagree about what the command is.
    if (!arg.startsWith("--")) return arg === name ? i : -1;
    const flag = arg.slice(2);
    if (!flag.includes("=") && takesValue.has(flag)) i++;
  }
  return -1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  // Split before parsing: everything after the `claude` SUBCOMMAND belongs to
  // Claude Code. Parsing first would let `claudelingo claude --help` print OUR
  // usage and never start the agent; splitting on any `claude` token would
  // truncate `claudelingo hook Stop --source claude`.
  const split = ["claude", "start"]
    .map((name) => subcommandIndex(argv, name))
    .find((i) => i !== -1) ?? -1;
  const own = split === -1 ? argv : argv.slice(0, split + 1);
  const forwarded = split === -1 ? [] : argv.slice(split + 1);
  // Everything after `start` goes to the agent, so `start --lang fr` silently
  // studied the configured language and handed `--lang fr` to Claude Code, which
  // has no such flag. Ours has to come first; say so rather than doing the wrong
  // thing quietly.
  const ours = forwarded.find((a) => a === "--lang" || a.startsWith("--lang="));
  if (ours) {
    fail(
      `${ours} after \`start\` is passed on to the agent, not to claudelingo.\n` +
        `  Put it first:  claudelingo ${ours}${ours === "--lang" ? " <code>" : ""} start`,
    );
  }
  const args = parseArgs(own);
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
    case "statusline": return cmdStatusline(args);
    case "session-start": return cmdSessionStart(args);
    case "next": return cmdNext(args);
    case "answer": return cmdAnswer(args);
    case "skip": return cmdSkip(args);
    case "lang": return cmdLang(args);
    case "panel": return cmdPanel(args);
    // `start` is the name to remember; `claude` is kept because the flag
    // pass-through reads naturally after it.
    case "start":
    case "claude": return cmdLaunch(args, forwarded);
    case "stats": return cmdStats(args);
    case "langs": return cmdLangs();
    case "pack": return cmdPack(args);
    case "reset": return cmdReset(args);
    case "unknown":
      return fail(
        `unknown command "${args.rest[0] ?? ""}"\n` +
          "Run `claudelingo --help` to see them, or `claudelingo` on its own for the pane.",
      );
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
