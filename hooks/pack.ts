/**
 * Turning a written pack into words the band can ask about.
 *
 * One rule here matters more than the rest: control characters are stripped. A
 * gloss is drawn as a `Text` child in a band that has promised to be three rows
 * tall, so a newline breaks the promise the conversation above it relies on,
 * and a raw escape is data the model wrote arriving in a render tree. Both are
 * cut here, once, rather than at each of the places that draw a word.
 */

import { canCloze } from './cloze'
import { BUNDLED } from './packs'
import type { Pack, RawPack, Word } from './types'

export class PackError extends Error {}

function clean(value: string): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function materialize(raw: RawPack): Pack {
  if (!raw || typeof raw.code !== 'string' || !Array.isArray(raw.words)) {
    throw new PackError('pack is missing `code` or `words`')
  }

  const seen = new Set<string>()

  const words: Word[] = raw.words.map((entry, index) => {
    const [rawTerm, rawGloss, rawPos, rawNote, rawExample] = entry
    const term = clean(rawTerm ?? '')
    const gloss = clean(rawGloss ?? '')
    const pos = clean(rawPos ?? '')

    if (!term || !gloss || !pos) {
      throw new PackError(`pack ${raw.code}: entry ${index + 1} needs [term, gloss, pos]`)
    }

    if (seen.has(term)) {
      throw new PackError(`pack ${raw.code}: duplicate term "${term}"`)
    }

    seen.add(term)

    const word: Word = { id: `${raw.code}:${index + 1}`, rank: index + 1, term, gloss, pos }
    const note = clean(rawNote ?? '')

    if (note) word.note = note

    // `sentence | translation`. A sentence that cannot be blanked is dropped
    // rather than kept — `canCloze` is the same question the card builder asks,
    // so the two cannot disagree about whether a sentence is usable.
    const [text, translation] = clean(rawExample ?? '').split('|')

    if (text && translation && canCloze(text, term)) {
      word.example = { text: text.trim(), translation: translation.trim() }
    }

    return word
  })

  return {
    code: clean(raw.code),
    name: clean(raw.name || raw.code),
    englishName: clean(raw.englishName || raw.name || raw.code),
    words,
  }
}

/** The codes built into the mod: what a generated pack may not be called. */
export const BUNDLED_CODES: readonly string[] = BUNDLED.map((pack) => pack.code)

/** A bundled pack by code, or undefined. */
export function bundledPack(code: string): RawPack | undefined {
  return BUNDLED.find((pack) => pack.code === code)
}

/**
 * What the picker offers: the bundled languages, then anything generated.
 *
 * Name and code only — materialising every pack to count its words would parse
 * a thousand entries to draw one row.
 */
export interface PackChoice {
  code: string
  englishName: string
  words: number
}

export const BUNDLED_CHOICES: readonly PackChoice[] = BUNDLED.map((pack) => ({
  code: pack.code,
  englishName: pack.englishName,
  words: pack.words.length,
}))
