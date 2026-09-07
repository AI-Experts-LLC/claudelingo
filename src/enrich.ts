import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { paths } from "./config.js";
import type { Pack, RawPack, Word } from "./types.js";

/**
 * Claude Fable 5.1. Thinking is always on for this model, so the `thinking`
 * parameter is omitted entirely — sending one is rejected.
 */
export const DEFAULT_MODEL = "claude-fable-5-1";

/**
 * Fable 5.1 can decline a request outright (HTTP 200, `stop_reason: "refusal"`).
 * Opting into a server-side fallback means a decline is retried on another model
 * inside the same call instead of surfacing as an empty response.
 */
const FALLBACK_BETA = "server-side-fallback-2026-06-01";
const FALLBACK_MODEL = "claude-opus-4-8";

/**
 * `fallbacks` and `output_config.format` are live API parameters that the installed
 * SDK (0.71.x) does not type yet. Describing them here keeps the request shape
 * checked at the call site instead of casting whole params objects to `any`; drop
 * these once the SDK types catch up.
 */
type ExtendedOutputConfig = Anthropic.Beta.BetaOutputConfig & {
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  format?: { type: "json_schema"; name: string; schema: unknown };
};

type Extended<T> = Omit<T, "output_config"> & {
  output_config?: ExtendedOutputConfig;
  fallbacks?: Array<{ model: string }>;
};

type CreateParams = Extended<Anthropic.Beta.MessageCreateParamsNonStreaming>;
type StreamParams = Extended<Anthropic.Beta.MessageCreateParamsStreaming>;

export class EnrichError extends Error {}

function client(): Anthropic {
  // The SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
  // profile on its own; a bare constructor is the documented path.
  return new Anthropic();
}

function textOf(response: Anthropic.Beta.BetaMessage): string {
  return response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function cacheFile(lang: string, term: string): string {
  const safe = Buffer.from(term).toString("base64url");
  return path.join(paths.cache(), `hook-${lang}-${safe}.txt`);
}

/**
 * A one- or two-line memory hook for a word: an etymology, a cognate, or a vivid
 * image. Cached on disk, because the hook for "tiempo" never changes.
 */
export async function memoryHook(
  word: Word,
  pack: Pack,
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const file = cacheFile(pack.code, word.term);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();

  const params: CreateParams = {
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: 400,
    betas: [FALLBACK_BETA],
    fallbacks: [{ model: FALLBACK_MODEL }],
    output_config: { effort: "low" },
    system:
      "You help an English speaker memorise high-frequency vocabulary. " +
      "Reply with at most two short lines of plain text: a memory hook " +
      "(cognate, etymology, or vivid image) and one very short example sentence " +
      "with its English translation. No preamble, no markdown, no bullet points.",
    messages: [
      {
        role: "user",
        content: `${pack.englishName} word: "${word.term}" (${word.pos}) = "${word.gloss}".`,
      },
    ],
  };

  const response = await client().beta.messages.create(
    params as Anthropic.Beta.MessageCreateParamsNonStreaming,
    options.signal ? { signal: options.signal } : {},
  );

  if (response.stop_reason === "refusal") {
    throw new EnrichError("the model declined this request");
  }
  const text = textOf(response);
  if (!text) throw new EnrichError("empty response");

  fs.mkdirSync(paths.cache(), { recursive: true });
  fs.writeFileSync(file, `${text}\n`, "utf8");
  return text;
}

/** JSON the pack generator is asked to produce. Kept flat so it is easy to validate. */
interface GeneratedPack {
  code: string;
  name: string;
  englishName: string;
  words: Array<{ term: string; gloss: string; pos: string; note?: string }>;
}

/**
 * Build a frequency pack for a language we do not ship, using the same model.
 *
 * Structured outputs pin the shape, so the result either parses into a pack or
 * fails loudly rather than half-populating one.
 */
export async function generatePack(
  language: string,
  code: string,
  count: number,
  options: { model?: string } = {},
): Promise<RawPack> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["code", "name", "englishName", "words"],
    properties: {
      code: { type: "string" },
      name: { type: "string" },
      englishName: { type: "string" },
      words: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["term", "gloss", "pos"],
          properties: {
            term: { type: "string" },
            gloss: { type: "string" },
            pos: { type: "string" },
            note: { type: "string" },
          },
        },
      },
    },
  } as const;

  const params: StreamParams = {
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: 32000,
    betas: [FALLBACK_BETA],
    fallbacks: [{ model: FALLBACK_MODEL }],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema, name: "vocabulary_pack" },
    },
    system:
      "You are a corpus linguist building a beginner vocabulary pack. " +
      "Order words by descending corpus frequency, one dictionary form per entry, " +
      "no duplicate terms. `pos` is one of: noun, verb, adj, adv, prep, conj, pron, " +
      "art, num, interj. `gloss` is a short English translation; `note` carries gender " +
      "or an irregularity when it matters.",
    messages: [
      {
        role: "user",
        content:
          `Produce the ${count} most common words in ${language}. ` +
          `Use "${code}" as the code, the language's own name as \`name\`, and ` +
          `"${language}" as \`englishName\`.`,
      },
    ],
    stream: true,
  };

  const stream = client().beta.messages.stream(
    params as Anthropic.Beta.MessageCreateParamsStreaming,
  );
  const response = await stream.finalMessage();
  if (response.stop_reason === "refusal") {
    throw new EnrichError("the model declined to generate this pack");
  }

  const raw = textOf(response);
  let parsed: GeneratedPack;
  try {
    parsed = JSON.parse(raw) as GeneratedPack;
  } catch {
    throw new EnrichError("model did not return valid JSON");
  }
  if (!Array.isArray(parsed.words) || parsed.words.length === 0) {
    throw new EnrichError("model returned no words");
  }

  // Collapse to the compact on-disk tuple form, dropping duplicates the model may
  // have slipped in — `materialize` rejects the pack outright if any survive.
  const seen = new Set<string>();
  const words: RawPack["words"] = [];
  for (const entry of parsed.words) {
    if (!entry?.term || !entry.gloss || !entry.pos) continue;
    if (seen.has(entry.term)) continue;
    seen.add(entry.term);
    words.push(
      entry.note
        ? [entry.term, entry.gloss, entry.pos, entry.note]
        : [entry.term, entry.gloss, entry.pos],
    );
  }

  return {
    code: parsed.code || code,
    name: parsed.name || language,
    englishName: parsed.englishName || language,
    words,
  };
}

/** True when a credential is reachable without prompting the user. */
export function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
