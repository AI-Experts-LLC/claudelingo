import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "./types.js";

export const DEFAULT_SETTINGS: Settings = {
  lang: "es",
  maxLearning: 8,
  newPerDay: 20,
  staleBusyMs: 15 * 60 * 1000,
  alwaysOn: false,
  enrich: true,
  model: "claude-fable-5-1",
};

/**
 * Root for all state. `CLAUDELINGO_HOME` exists so tests (and anyone running two
 * languages side by side) get a clean, isolated directory.
 */
export function home(): string {
  return process.env.CLAUDELINGO_HOME || path.join(os.homedir(), ".claudelingo");
}

export const paths = {
  home,
  settings: () => path.join(home(), "settings.json"),
  status: () => path.join(home(), "status.json"),
  progress: (lang: string) => path.join(home(), `progress-${lang}.json`),
  cache: () => path.join(home(), "cache"),
  packs: () => path.join(home(), "packs"),
};

export function ensureHome(): string {
  const dir = home();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write via a temp file + rename so a crash mid-write can never truncate state. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadSettings(): Settings {
  const stored = readJson<Partial<Settings>>(paths.settings()) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(settings: Settings): void {
  writeJsonAtomic(paths.settings(), settings);
}
