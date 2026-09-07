import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..", "..");
export const CLI = path.join(REPO, "dist", "cli.js");

export function requireBuild(): void {
  if (!fs.existsSync(CLI)) {
    throw new Error(`dist/cli.js is missing — run \`npm run build\` first (looked in ${CLI})`);
  }
}

export interface Env {
  home: string;
  cleanup(): void;
}

export function makeEnv(): Env {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudelingo-e2e-"));
  return {
    home,
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run a claudelingo subcommand to completion. */
export function cli(
  args: string[],
  env: Env,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        CLAUDELINGO_HOME: env.home,
        NO_COLOR: "1",
        // Never let a real credential leak into a test run.
        ANTHROPIC_API_KEY: "",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/**
 * The interactive pane, driven over real pipes.
 *
 * `CLAUDELINGO_FORCE_RENDER` makes it paint frames even though stdout is not a TTY,
 * so a test sees exactly the frames a user would, one per repaint.
 */
export class Pane {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  readonly exited: Promise<number | null>;

  constructor(args: string[], env: Env, extraEnv: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        CLAUDELINGO_HOME: env.home,
        CLAUDELINGO_FORCE_RENDER: "1",
        CLAUDELINGO_SEED: "1234",
        NO_COLOR: "1",
        ANTHROPIC_API_KEY: "",
        ...extraEnv,
      },
    });
    this.child.stdout.on("data", (d) => (this.buffer += d.toString()));
    this.child.stderr.on("data", (d) => (this.buffer += d.toString()));
    this.exited = new Promise((resolve) => this.child.on("close", resolve));
  }

  get output(): string {
    return this.buffer;
  }

  /** Every frame painted so far, split on the panel's top border. */
  get frames(): string[] {
    return this.buffer
      .split(/(?=┌)/)
      .map((f) => f.trim())
      .filter((f) => f.startsWith("┌"));
  }

  get lastFrame(): string {
    return this.frames.at(-1) ?? "";
  }

  send(keys: string): void {
    this.child.stdin.write(keys);
  }

  /** Wait until `predicate` holds over the accumulated output. */
  async until(predicate: (output: string) => boolean, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(this.buffer)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `timed out waiting for condition.\n--- output ---\n${this.buffer.slice(-2500)}`,
    );
  }

  /** Wait for `text` to appear anywhere in the output so far. */
  waitForText(text: string, timeoutMs = 8000): Promise<void> {
    return this.until((out) => out.includes(text), timeoutMs);
  }

  /**
   * Wait for the frame *currently* on screen to contain `text`.
   *
   * Use this whenever the pane returns to a state it has been in before —
   * `waitForText` would match the earlier frame and return immediately.
   */
  waitForLastFrame(text: string, timeoutMs = 8000): Promise<void> {
    return this.until(() => this.lastFrame.includes(text), timeoutMs);
  }

  /** Wait for a new frame to be painted after the current count. */
  async waitForFrames(count: number, timeoutMs = 8000): Promise<void> {
    await this.until(() => this.frames.length >= count, timeoutMs);
  }

  kill(): void {
    if (!this.child.killed) this.child.kill("SIGKILL");
  }
}

export function statusFile(env: Env): string {
  return path.join(env.home, "status.json");
}

export function progressFile(env: Env, lang = "es"): string {
  return path.join(env.home, `progress-${lang}.json`);
}

export function readProgress(env: Env, lang = "es"): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(progressFile(env, lang), "utf8"));
}

interface RawPackFile {
  words: Array<[string, string, string] | [string, string, string, string]>;
}

function packFile(lang: string): RawPackFile {
  return JSON.parse(fs.readFileSync(path.join(REPO, "dist", "packs", `${lang}.json`), "utf8"));
}

/** The progress id of a word, looked up by term so pack edits cannot break a test. */
export function idForTerm(lang: string, term: string): string {
  const index = packFile(lang).words.findIndex((w) => w[0] === term);
  if (index === -1) throw new Error(`"${term}" is not in the ${lang} pack`);
  return `${lang}:${index + 1}`;
}

export function glossForTerm(lang: string, term: string): string {
  const entry = packFile(lang).words.find((w) => w[0] === term);
  if (!entry) throw new Error(`"${term}" is not in the ${lang} pack`);
  return entry[1];
}

/** Read the numbered options off a rendered question frame. */
export function parseChoices(frame: string): Map<string, string> {
  const choices = new Map<string, string>();
  for (const line of frame.split("\n")) {
    if (!line.startsWith("│")) continue;
    const inner = line.slice(1, -1);
    if (!/\d\)/.test(inner)) continue;
    for (const cell of inner.trim().split(/\s{2,}/)) {
      const match = /^(\d)\)\s*(.+)$/.exec(cell.trim());
      if (match) choices.set(match[1] as string, (match[2] as string).trim());
    }
  }
  return choices;
}
