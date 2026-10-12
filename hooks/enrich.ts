/**
 * Memory hooks, through the session's own model.
 *
 * Press the explain key on a card and you get a cognate, an etymology or a
 * vivid image — the thing that turns a word you have looked up four times into
 * one you know.
 *
 * claudelingo used to do this by spawning `claude -p` and reading its stdout,
 * which meant finding the binary on PATH, saying so once at startup when it was
 * not there, and hiding the key when it was missing. A hooks module has no
 * processes and needs none: `$.model.complete` runs on the session's own client
 * and credentials. No API key, no second bill, and nothing to detect.
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

/**
 * The reply's text, whichever shape `$.model.complete` resolved to.
 *
 * Claude Code 2.1.271, which wrote `types/claude-code.d.ts`, resolves to the
 * text. 2.1.296 resolves to `{ isAnswered: true, text }`, or to
 * `{ isAnswered: false, reason }` when no reply came, and treating that object
 * as a string failed every pack build with "undefined is not a function" and
 * reported every memory hook as the model having nothing to say. Both shapes are
 * accepted, and a reply that never came is an error that says why.
 */
export function replyText(reply: unknown): string {
  if (typeof reply === 'string') return reply

  const answer = (reply ?? {}) as { isAnswered?: unknown; text?: unknown; reason?: unknown; error?: unknown }

  if (answer.isAnswered === true && typeof answer.text === 'string') return answer.text

  const reason = typeof answer.reason === 'string' ? answer.reason : 'unrecognised reply'
  const detail = typeof answer.error === 'string' ? `: ${answer.error}` : ''

  throw new Error(`the model did not answer (${reason}${detail})`)
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

/** A hook, or why there isn't one. */
export type Hook = { text: string; reason?: undefined } | { text: null; reason: string }

/**
 * A memory hook for a word: from the cache, or from the model and then cached.
 *
 * Never throws. The hook is a bonus on a card that is already on screen and
 * already answerable; a model that is slow, refusing or unreachable should cost
 * the hook and nothing else.
 *
 * It carries the reason rather than a bare null, because the reasons are not
 * interchangeable and the caller cannot guess between them. `settings.model`
 * takes any non-empty string, so a typo'd or retired model id reads as "could
 * not reach the model" on every word for ever, while the message that would fix
 * it in one go — `no such model: haiku-3` — is the thing being discarded.
 */
export async function memoryHook(
  store: Store,
  model: Completer,
  word: Word,
  modelId: string,
  englishName: string,
): Promise<Hook> {
  const key = hookKey(word.id)

  try {
    const cached = await store.get(key)

    if (typeof cached === 'string' && cached.length > 0) return { text: cached }
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
  } catch (error) {
    return {
      text: null,
      reason: `could not reach ${modelId} for a hook: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  const hook = oneLine(typeof reply === 'string' ? reply : '')

  if (!hook) return { text: null, reason: `${modelId} had nothing to say about "${word.term}"` }

  try {
    await store.set(key, hook)
  } catch {
    // A cache that cannot be written still leaves a usable hook on screen; the
    // same broken store is already being reported by the deck's own save.
  }

  return { text: hook }
}
