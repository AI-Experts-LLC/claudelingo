import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../config.js";
import type { Pack, RawPack, Word } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Bundled packs ship next to the compiled loader; user packs live under the home dir. */
function searchDirs(): string[] {
  return [here, paths.packs()];
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

export function savePack(raw: RawPack): string {
  materialize(raw); // validate before it reaches disk
  const dir = paths.packs();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${raw.code}.json`);
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return file;
}
