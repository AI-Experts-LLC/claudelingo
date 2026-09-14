/**
 * Memory hooks, through the session's own model.
 *
 * Press the explain key on a card and you get a cognate, an etymology or a
 * vivid image — the thing that turns a word you have looked up four times into
 * one you know.
 *
 * The CLI does this by spawning `claude -p` and reading its stdout, which means
 * finding the binary on PATH, saying so once at startup when it is not there,
 * and hiding the key when it is missing. A hooks module has no processes and
 * needs none: `$.model.complete` runs on the session's own client and
 * credentials. No API key, no second bill, and nothing to detect.
 *
 * The reply is cached in `$.store` by word id, so a word is only ever paid for
 * once, on any machine that store follows.
 */

import { hookKey } from './names'
import type { Store } from './deck'
import type { Word } from './types'

/** The slice of `$` this module touches. */
export interface Completer {
  complete: (request: { model: string; prompt: string; system?: string; maxTokens?: number }) => Promise<string>
}

const SYSTEM =
  'You help someone remember a foreign word. Answer with one sentence of at most ' +
  '20 words: a cognate, an etymology, or a vivid image linking the word to its ' +
  'meaning. No preamble, no quotes, no bullet points, plain text only.'

/**
 * One line, whatever the model sent.
 *
 * The band is three rows and has promised to stay three rows, so a reply with a
 * newline in it would break the layout of the conversation above. Control
 * characters go for the reason they go in `pack.ts`: this is model output
 * arriving in a render tree.
 */
export function oneLine(text: string, limit = 160): string {
  const flat = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat
}

/**
 * A memory hook for a word: from the cache, or from the model and then cached.
 *
 * Returns null rather than throwing. The hook is a bonus on a card that is
 * already on screen and already answerable; a model that is slow, refusing or
 * unreachable should cost the hook and nothing else.
 */
export async function memoryHook(
  store: Store,
  model: Completer,
  word: Word,
  modelId: string,
  englishName: string,
): Promise<string | null> {
  const key = hookKey(word.id)

  try {
    const cached = await store.get(key)

    if (typeof cached === 'string' && cached.length > 0) return cached
  } catch {
    // An unreadable cache is a cache miss, not a failure.
  }

  let reply: string

  try {
    reply = await model.complete({
      model: modelId,
      system: SYSTEM,
      prompt:
        `${englishName} word: "${word.term}" (${word.pos}) meaning "${word.gloss}". ` +
        'How do I remember it?',
      maxTokens: 120,
    })
  } catch {
    return null
  }

  const hook = oneLine(reply)

  if (!hook) return null

  // A cache that cannot be written still leaves a usable hook on screen.
  try {
    await store.set(key, hook)
  } catch {
    /* empty */
  }

  return hook
}
