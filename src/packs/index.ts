import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths, writeJsonAtomic } from "../config.js";
import type { Pack, RawPack, Word } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * User packs are searched first, so a hand-placed pack can deliberately replace a
 * bundled one. `savePack` refuses to generate into a bundled code, so the common
 * accident — `--lang Estonian` defaulting to code `es` — cannot happen silently.
 */
function searchDirs(): string[] {
  return [paths.packs(), here];
}

/** Codes that ship with claudelingo and therefore cannot be generated into. */
export function bundledCodes(): string[] {
  return fs
    .readdirSync(here)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"))
    .sort();
}

export class PackError extends Error {}

export function materialize(raw: RawPack): Pack {
  if (!raw || typeof raw.code !== "string" || !Array.isArray(raw.words)) {
    throw new PackError("pack is missing `code` or `words`");
  }
  const seen = new Set<string>();
  const words: Word[] = raw.words.map((entry, index) => {
    const [term, gloss, pos, note] = entry;
    if (!term || !gloss || !pos) {
      throw new PackError(`pack ${raw.code}: entry ${index + 1} needs [term, gloss, pos]`);
    }
    if (seen.has(term)) throw new PackError(`pack ${raw.code}: duplicate term "${term}"`);
    seen.add(term);
    const word: Word = { id: `${raw.code}:${index + 1}`, rank: index + 1, term, gloss, pos };
    if (note) word.note = note;
    return word;
  });
  return {
    code: raw.code,
    name: raw.name || raw.code,
    englishName: raw.englishName || raw.name || raw.code,
    words,
  };
}

export function loadPack(code: string): Pack {
  for (const dir of searchDirs()) {
    const file = path.join(dir, `${code}.json`);
    if (!fs.existsSync(file)) continue;
    let raw: RawPack;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as RawPack;
    } catch (error) {
      throw new PackError(`pack ${code} at ${file} is not valid JSON: ${(error as Error).message}`);
    }
    return materialize(raw);
  }
  throw new PackError(
    `no pack for "${code}". Bundled: ${listPacks().join(", ")}. ` +
      `Generate one with: claudelingo pack generate --lang ${code}`,
  );
}

export function listPacks(): string[] {
  const codes = new Set<string>();
  for (const dir of searchDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".json")) codes.add(path.basename(file, ".json"));
    }
  }
  return [...codes].sort();
}

export function savePack(raw: RawPack, options: { overwrite?: boolean } = {}): string {
  // Validate first: a half-valid generated pack must never land on disk, where
  // it would fail on every later load instead of once, here, with a reason.
  materialize(raw);

  if (bundledCodes().includes(raw.code)) {
    throw new PackError(
      `"${raw.code}" is a language that already ships with claudelingo. ` +
        "Choose a different --code, or the generated pack would collide with it — " +
        "including the progress file, which is keyed by code.",
    );
  }

  const file = path.join(paths.packs(), `${raw.code}.json`);
  if (!options.overwrite && fs.existsSync(file)) {
    throw new PackError(
      `${file} already exists. Re-run with --overwrite to replace it — note that ` +
        `progress-${raw.code}.json is keyed by position, so box levels earned on the ` +
        "old pack would re-attach to whatever word now sits at each rank.",
    );
  }

  writeJsonAtomic(file, raw);
  return file;
}
