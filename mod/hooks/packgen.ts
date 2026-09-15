// Restated from src/packgen.ts by mod/scripts/restate.mjs.
// Do not edit: change src/packgen.ts and run `npm run mod:restate`.

import { canCloze } from "./cloze";
import type { RawPack } from "./types";

/**
 * Building a frequency pack for a language claudelingo does not ship.
 *
 * This module holds the prompts, the chunking and every rule about what comes
 * back; it does not know how the model is reached. That is the `Asker` handed
 * in — `claude -p` for the CLI, `$.model.complete` for the mod — because the
 * two surfaces have completely different transports and identical problems.
 *
 * The problems are the reason this is one module rather than two. Every comment
 * below records a real run that went wrong: a truncated reply losing 693 words
 * of French, boundaries overlapping until a 1000-word pack held 600 distinct
 * ones, and a model that, asked to fill a quota past the point where it knows
 * the frequency order, starts reciting the dictionary alphabetically. A second
 * copy of this would have to learn all of it again.
 */

/**
 * How the model is reached.
 *
 * One prompt, one system prompt, the reply's text. Everything either transport
 * needs beyond that — timeouts, models, process plumbing — it closes over.
 */
export type Asker = (prompt: string, options: { system: string }) => Promise<string>;

export class EnrichError extends Error {}

const PACK_SYSTEM =
  "You are a corpus linguist building a beginner vocabulary pack. " +
  "Order words by descending corpus frequency, one dictionary form per entry, " +
  "no duplicate terms and no two entries sharing an English gloss. " +
  "`pos` is one of: noun, verb, adj, adv, prep, conj, pron, art, num, interj. " +
  "`gloss` is a short English translation; `note` carries gender or an " +
  "irregularity when it matters. `example` is a short natural sentence that " +
  "*contains the entry's term verbatim*, then ` | `, then its English " +
  "translation — six to twelve words, using only vocabulary at least as common " +
  "as the entry itself. Reply with JSON only — no prose, no code fence.";

/** How many words to ask for in one request. */
const PACK_CHUNK = 100;

interface GeneratedEntry {
  term?: string;
  gloss?: string;
  pos?: string;
  note?: string;
  example?: string;
}

/** One request: the words ranked `from`..`from + size - 1`. */
async function packChunk(
  ask: Asker,
  language: string,
  from: number,
  size: number,
  known: string[],
): Promise<GeneratedEntry[]> {
  // The already-taken terms go in the prompt because the model cannot see the
  // earlier chunks: without them the boundaries overlap heavily and a 1000-word
  // pack comes back with 600 distinct words.
  const avoid = known.length
    ? ` Do not repeat any of these, which are already in the pack: ${known.join(", ")}.`
    : "";
  const raw = await ask(
    `Produce words ranked ${from} to ${from + size - 1} by frequency in ${language}, ` +
      `as JSON of the form {"words":[{"term":"","gloss":"","pos":"","note":"","example":""}]}. ` +
      `Exactly ${size} entries, continuing the frequency order — not the commonest words ` +
      `again.${avoid} Omit "note" when it does not apply.`,
    { system: PACK_SYSTEM },
  );
  const body = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let parsed: { words?: GeneratedEntry[] };
  try {
    parsed = JSON.parse(body) as { words?: GeneratedEntry[] };
  } catch {
    throw new EnrichError(`Claude did not return valid JSON for words ${from}-${from + size - 1}`);
  }
  if (!Array.isArray(parsed.words)) {
    throw new EnrichError(`Claude returned no words for ${from}-${from + size - 1}`);
  }
  return parsed.words;
}

/**
 * Build a frequency pack for a language claudelingo does not ship.
 *
 * Asked in chunks, because one request for a thousand entries with a sentence
 * each is a very long reply: it truncates, and a truncated JSON body is a whole
 * pack lost rather than one chunk. Each chunk is told what the earlier ones
 * produced, or the boundaries overlap and the duplicates eat the count.
 */
export async function generatePack(
  ask: Asker,
  language: string,
  code: string,
  count: number,
  options: {
    onProgress?: (done: number, total: number, note?: string) => void;
    /** Words already gathered, to continue from instead of regenerating. */
    existing?: RawPack["words"];
  } = {},
): Promise<RawPack> {
  const { onProgress, existing } = options;
  const seen = new Set<string>();
  const words: RawPack["words"] = [];

  // Carry on from a pack already on disk rather than paying for it twice. A run
  // that dies at word 800 should cost its next attempt 200 words, not 1000.
  for (const row of existing ?? []) {
    const term = (row[0] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    words.push(row);
  }

  // Deliberately no top-up past the requested ranks.
  //
  // Chunks overlap, so asking for `count` ranks yields fewer than `count` words
  // — and the obvious fix, "keep asking until the target is met", is how a real
  // run ended up with `padernete` and `achufladamente` in it. Past the point
  // where the model actually knows the frequency order it starts reciting the
  // dictionary alphabetically to fill the quota. A short pack of real words
  // beats a full one padded with sludge, so it stops at the end of the range and
  // says what it got.
  const maxChunks = Math.ceil(count / PACK_CHUNK);
  let from = Math.floor(words.length / PACK_CHUNK) * PACK_CHUNK + 1;
  let barren = 0;

  for (let chunk = 0; chunk < maxChunks && words.length < count && barren < 3; chunk++) {
    const size = Math.min(PACK_CHUNK, Math.max(20, count - words.length));
    const before = words.length;
    let entries: GeneratedEntry[];
    try {
      // Only the most recent terms: the whole list would grow the prompt without
      // bound, and it is the boundary that overlaps, not the beginning.
      entries = await packChunk(ask, language, from, size, [...seen].slice(-120));
    } catch (error) {
      // One bad chunk must not cost the run. A reply that does not parse is
      // usually a truncation, so retry once at half the size; if that fails too,
      // stop and keep what we have — throwing here discarded 693 words of
      // French and 673 of Italian, about half an hour of somebody's quota.
      onProgress?.(words.length, count, `chunk ${from}: ${(error as Error).message}; retrying smaller`);
      try {
        entries = await packChunk(
          ask,
          language,
          from,
          Math.max(20, Math.floor(size / 2)),
          [...seen].slice(-120),
        );
      } catch (retryError) {
        onProgress?.(words.length, count, `chunk ${from} failed twice: ${(retryError as Error).message}`);
        break;
      }
    }
    for (const entry of entries) {
      if (!entry?.term || !entry.gloss || !entry.pos) continue;
      // Deduped on the *cleaned* term, which is what the loader compares. On the
      // raw string "casa" and "  casa  " both survive generation, and `savePack`
      // then throws `duplicate term`, losing a run that can take ten minutes.
      const key = entry.term.replace(/\s+/g, " ").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // A sentence that does not contain its own word cannot be clozed, and one
      // without a translation cannot be shown. The loader drops both anyway;
      // writing them to disk would just be junk in a file people read.
      const example = (entry.example ?? "").trim();
      const [text, translation] = example.split("|");
      const usable = !!text && !!translation?.trim() && canCloze(text, entry.term);

      const row: string[] = [entry.term, entry.gloss, entry.pos];
      if (usable) row.push(entry.note ?? "", example);
      else if (entry.note) row.push(entry.note);
      words.push(row as RawPack["words"][number]);
      if (words.length >= count) break;
    }
    onProgress?.(words.length, count);
    // A chunk that adds nothing new means the model has run out of words it has
    // not already given us; three in a row and there is no point asking again.
    barren = words.length > before ? 0 : barren + 1;
    from += PACK_CHUNK;
  }

  if (!words.length) throw new EnrichError("Claude returned no words");
  if (words.length < count) {
    onProgress?.(words.length, count, `stopped at ${words.length}: the ranks asked for are used up`);
  }
  return { code, name: language, englishName: language, words };
}
