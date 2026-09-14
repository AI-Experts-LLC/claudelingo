import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { EnrichError, generatePack as generate } from "./packgen.js";
import type { Asker } from "./packgen.js";
import type { Pack, RawPack, Word } from "./types.js";

export { EnrichError } from "./packgen.js";

/**
 * Everything that needs a model goes through the `claude` CLI in print mode.
 *
 * That matters for one reason above all: it runs on the Claude Code login the user
 * already has, and counts against the usage they are already paying for. Calling
 * the Anthropic API directly would mean a second credential and a separate bill for
 * something that only ever runs while Claude Code is open.
 *
 * It also means claudelingo ships with no API SDK and no key handling at all.
 */

/** Preferred model. Claude Code falls back to the session's own if it cannot use it. */
export const DEFAULT_MODEL = "claude-fable-5-1";

/** A memory hook is two short lines; a pack is a few hundred entries. */
const HOOK_TIMEOUT_MS = 90_000;
const PACK_TIMEOUT_MS = 10 * 60_000;

/** The shape `claude -p --output-format json` returns. */
interface PrintResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

export interface AskOptions {
  model?: string;
  timeoutMs?: number;
  system?: string;
  /** Injected by tests so they never spawn the real CLI. */
  run?: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Most a reply may occupy in memory.
 *
 * A hook is two lines and a pack a few hundred kilobytes; anything past this is a
 * runaway, and accumulating it unbounded lets a misbehaving child abort the
 * process with a V8 heap failure that no `catch` can see.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function runClaude(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // `detached` puts the child in its own process group so the whole tree can be
    // signalled. Killing only the direct child leaves grandchildren holding the
    // stdio pipes open, so `close` never fires and this process cannot exit —
    // and Claude Code does spawn subprocesses.
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const stop = () => {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        // Already gone, or never started.
      }
      // Streams a grandchild may still hold; without this the loop stays alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      stop();
      finish(() => reject(new EnrichError(`no reply within ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);

    const collect = (into: "out" | "err") => (chunk: Buffer) => {
      if (into === "out") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        stop();
        finish(() => reject(new EnrichError("the reply was too large to read")));
      }
    };

    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    child.on("error", (error) => {
      finish(() =>
        reject(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new EnrichError("the `claude` command is not on your PATH")
            : new EnrichError(error.message),
        ),
      );
    });
    child.on("close", (code) => finish(() => resolve({ code: code ?? 0, stdout, stderr })));
  });
}

/**
 * Ask Claude Code one question and return its text.
 *
 * `--max-turns 1` keeps it to a single completion: this is a text request, and a
 * tool loop would be slow, surprising, and able to touch the user's files.
 */
export async function ask(prompt: string, options: AskOptions = {}): Promise<string> {
  const run = options.run ?? runClaude;
  const timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS;
  const base = ["-p", "--output-format", "json", "--max-turns", "1"];
  if (options.system) base.push("--append-system-prompt", options.system);

  const deadline = Date.now() + timeoutMs;
  const attempt = async (model?: string) => {
    const args = model ? [...base, "--model", model, prompt] : [...base, prompt];
    // One budget across both attempts, so a retry cannot double the wait.
    const remaining = Math.max(1000, deadline - Date.now());
    const { code, stdout, stderr } = await run(args, remaining);

    let parsed: PrintResult;
    try {
      parsed = JSON.parse(stdout) as PrintResult;
    } catch {
      // A model Claude Code does not recognise produces prose on stdout and still
      // exits 0, so the exit code alone cannot be trusted.
      throw new EnrichError(
        (stderr || stdout || `claude exited ${code} with no output`).trim().split("\n")[0] as string,
      );
    }
    if (parsed.is_error || parsed.subtype !== "success") {
      throw new EnrichError((parsed.result || parsed.subtype || "claude reported an error").trim());
    }
    const text = (parsed.result ?? "").trim();
    if (!text) throw new EnrichError("empty response");
    return text;
  };

  const model = options.model ?? DEFAULT_MODEL;
  try {
    return await attempt(model);
  } catch (error) {
    // The preferred model may not exist in this Claude Code build. The session's
    // own model is a better answer than no answer — but only retry for that, not
    // for any failure whose text happens to mention a model.
    const unavailable =
      error instanceof EnrichError &&
      /(issue with the selected model|model catalog|unrecognized_model|unknown model|does not exist)/i.test(
        error.message,
      );
    if (unavailable) return attempt();
    throw error;
  }
}

/**
 * Read a cached hook, treating an empty or unreadable file as a cache miss.
 *
 * Returning "" would hand the UI a hook that renders as nothing at all: no text,
 * no spinner, no error, and a key that silently does nothing every time it is
 * pressed. A miss simply costs one request.
 */
function readCache(file: string): string | null {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Best effort: an unwritable cache costs a repeat request, nothing more. */
function writeCache(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(paths.cache(), { recursive: true });
    // Written and renamed, so an interrupted write cannot leave a truncated file
    // that would then be served as a cache hit forever.
    fs.writeFileSync(tmp, `${text}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing further to do.
    }
  }
}

/**
 * A hook we already have, or null. Never fetches.
 *
 * The panel is read-only and runs every couple of seconds; reaching the model
 * from there would spend the user's quota on a decoration, once per tick.
 */
export function cachedHook(lang: string, term: string): string | null {
  return readCache(cacheFile(lang, term));
}

function cacheFile(lang: string, term: string): string {
  const safe = Buffer.from(term).toString("base64url");
  return path.join(paths.cache(), `hook-${lang}-${safe}.txt`);
}

const HOOK_SYSTEM =
  "You help an English speaker memorise high-frequency vocabulary. " +
  "Reply with at most two short lines of plain text: a memory hook " +
  "(cognate, etymology, or vivid image) and one very short example sentence " +
  "with its English translation. No preamble, no markdown, no bullet points.";

/**
 * A one- or two-line memory hook for a word. Cached on disk, because the hook for
 * "tiempo" never changes.
 */
export async function memoryHook(
  word: Word,
  pack: Pack,
  options: AskOptions = {},
): Promise<string> {
  const file = cacheFile(pack.code, word.term);
  const cached = readCache(file);
  if (cached) return cached;

  const text = await ask(
    `${pack.englishName} word: "${word.term}" (${word.pos}) = "${word.gloss}".`,
    { ...options, system: HOOK_SYSTEM },
  );
  writeCache(file, text);
  return text;
}

/**
 * Build a frequency pack through the `claude` command.
 *
 * The generator itself is in `packgen.ts`, shared with the mod, which reaches
 * the model a completely different way. This is the CLI's half of that split:
 * the subprocess, the pack timeout, and nothing else.
 */
export function generatePack(
  language: string,
  code: string,
  count: number,
  options: AskOptions & {
    onProgress?: (done: number, total: number, note?: string) => void;
    /** Words already gathered, to continue from instead of regenerating. */
    existing?: RawPack["words"];
  } = {},
): Promise<RawPack> {
  const { onProgress, existing, ...askOptions } = options;

  const asker: Asker = (prompt, { system }) =>
    ask(prompt, { ...askOptions, system, timeoutMs: askOptions.timeoutMs ?? PACK_TIMEOUT_MS });

  return generate(asker, language, code, count, { onProgress, existing });
}

/**
 * Whether the `claude` command is available.
 *
 * There is no credential to check any more: if Claude Code runs, so does this.
 */
export function hasClaude(runner: () => boolean = probeClaude): boolean {
  return runner();
}

function probeClaude(): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    for (const name of ["claude", "claude.cmd", "claude.exe"]) {
      try {
        const candidate = path.join(dir, name);
        fs.accessSync(candidate, fs.constants.X_OK);
        // A *directory* named `claude` is executable-by-permission but is not the
        // command; offering `e` on that basis fails on every press.
        if (fs.statSync(candidate).isFile()) return true;
      } catch {
        // Keep looking.
      }
    }
    return false;
  });
}
