/**
 * The idle drill: a word, a pause, its meaning, the next word.
 *
 * With nothing due and no turn running there is nothing to quiz, but there is
 * still a band. So it tickers: it walks the language's frequency list in order,
 * shows a word alone for a moment, then reveals the gloss. Trying and then
 * seeing is most of what makes a word stick, and it is the whole of what a
 * surface can offer when it has no question to ask.
 *
 * Nothing here is graded and nothing is written. The quiz is elsewhere.
 *
 * It is a pure function of the clock: a render hook is called afresh on every
 * draw and may be called
 * twice for one moment (a resize, another plugin's invalidate), so a ticker
 * that advanced itself per call would jump about. Given the same millisecond
 * this returns the same frame.
 */

import { HIDDEN_FRACTION, TICK_MS } from './names'
import type { Pack, Progress, Word } from './types'

export interface Tick {
  word: Word | null
  /** True once the meaning is showing. */
  revealed: boolean
  learned: number
  total: number
  /** Where this word sits in the frequency list: #1 is the commonest. */
  rank: number
}

export function tickAt(pack: Pack, progress: Progress, now: number): Tick {
  const words = pack.words
  // `now` is wall-clock in practice, but a non-finite or negative value must
  // not index off the end of the list.
  const slot = Number.isFinite(now) ? Math.abs(Math.floor(now / TICK_MS)) : 0
  const index = words.length ? slot % words.length : 0
  const word = words[index] ?? null

  return {
    word,
    revealed: Number.isFinite(now) && (Math.abs(now) % TICK_MS) / TICK_MS >= HIDDEN_FRACTION,
    learned: Object.keys(progress.items).length,
    total: words.length,
    rank: word ? index + 1 : 0,
  }
}

/** A ten-cell progress bar. */
export function bar(fraction: number, cells: number): string {
  const safe = Number.isFinite(fraction) ? fraction : 0
  const filled = Math.max(0, Math.min(cells, Math.round(safe * cells)))

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}
