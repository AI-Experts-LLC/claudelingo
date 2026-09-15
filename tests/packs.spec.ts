import { describe, expect, it } from 'vitest'

import { BUNDLED_CHOICES, materialize } from '../hooks/pack'
import { BUNDLED } from '../hooks/packs'
import { MASCOT_HEIGHT, MASCOT_WIDTH, owl } from '../hooks/ui/mascot'
import type { Mood } from '../hooks/ui/mascot'
import { buildCard, isCorrect, makeRng } from '../hooks/srs'
import { stringWidth } from '../hooks/ui/width'
import type { ItemProgress } from '../hooks/types'

/**
 * The 933 words that ship, and the owl that sits beside them.
 *
 * Both of these lost their only tests when the CLI was deleted, and both are
 * data rather than logic — which is exactly the kind of thing that rots without
 * anyone noticing, because no code path changes when a gloss is wrong.
 *
 * The one that matters most is the distinct-gloss check: a reverse card shows
 * only the gloss, so two words sharing one produces a question with two right
 * answers and marks you wrong for giving the other.
 */

const VALID_POS = new Set([
  'noun', 'verb', 'adj', 'adv', 'prep', 'conj', 'pron', 'art', 'num', 'interj',
])

const PACKS = BUNDLED.map((raw) => materialize(raw))

const reviewing = (id: string, box: number): ItemProgress => ({
  id, stage: 'review', box, step: 0, due: 0, lastSeen: 0, seen: 1, correct: 1, lapses: 0,
})

describe('the packs that ship', () => {
  it('ships Spanish, French and Italian', () => {
    expect(PACKS.map((p) => p.code).sort()).toEqual(['es', 'fr', 'it'])
    expect(BUNDLED_CHOICES.map((c) => c.englishName).sort()).toEqual([
      'French', 'Italian', 'Spanish',
    ])
  })

  it.each(PACKS)('$englishName is substantial and internally consistent', (pack) => {
    expect(pack.words.length).toBeGreaterThanOrEqual(300)
    expect(pack.englishName).toBeTruthy()
    expect(pack.name).toBeTruthy()

    const terms = new Set<string>()

    for (const word of pack.words) {
      expect(word.term.trim()).toBe(word.term)
      expect(word.gloss.trim()).toBe(word.gloss)
      expect(word.term.length).toBeGreaterThan(0)
      expect(word.gloss.length).toBeGreaterThan(0)
      expect(VALID_POS.has(word.pos), `${pack.code}: "${word.term}" has pos "${word.pos}"`).toBe(true)
      expect(terms.has(word.term), `${pack.code}: duplicate term "${word.term}"`).toBe(false)
      terms.add(word.term)
    }
  })

  /**
   * A reverse or recall card shows only the gloss, so two words sharing one
   * would produce a question with two right answers.
   */
  it.each(PACKS)('$englishName glosses every word distinctly', (pack) => {
    const seen = new Map<string, string>()

    for (const word of pack.words) {
      const clash = seen.get(word.gloss)

      expect(
        clash,
        `${pack.code}: "${word.gloss}" glosses both ${clash} and ${word.term}`,
      ).toBeUndefined()

      seen.set(word.gloss, word.term)
    }
  })

  it.each(PACKS)('$englishName can build a fair card for every single word', (pack) => {
    for (const word of pack.words) {
      for (const box of [1, 3]) {
        const card = buildCard(pack, word, reviewing(word.id, box), makeRng(word.rank * 31 + box))

        expect(card.choices, `${pack.code}:${word.term} box ${box}`).toHaveLength(4)
        expect(new Set(card.choices).size, `${pack.code}:${word.term} box ${box}`).toBe(4)
        expect(card.choices[card.answerIndex]).toBe(box === 1 ? word.gloss : word.term)
      }
    }
  })

  it.each(PACKS)('$englishName can be spelled out from its gloss at the top box', (pack) => {
    for (const word of pack.words) {
      const card = buildCard(pack, word, reviewing(word.id, 5), makeRng(1))

      expect(card.kind).toBe('recall')
      expect(isCorrect(card, { text: word.term }), `${pack.code}:${word.term}`).toBe(true)
    }
  })

  it.each(PACKS)('$englishName starts with genuinely high-frequency function words', (pack) => {
    const openers = pack.words.slice(0, 20).map((w) => w.pos)

    const functionWords = openers.filter((pos) =>
      ['art', 'prep', 'conj', 'pron', 'verb', 'adv'].includes(pos),
    )

    expect(functionWords.length).toBeGreaterThanOrEqual(15)
  })

  /**
   * An example sentence must contain the word it teaches, or the cloze card
   * blanks nothing and asks an unanswerable question. `materialize` drops the
   * ones that cannot be blanked; this checks the survivors really can be.
   */
  it.each(PACKS)('$englishName only keeps example sentences it can blank', (pack) => {
    for (const word of pack.words) {
      if (!word.example) continue

      const card = buildCard(pack, word, reviewing(word.id, 4), makeRng(7))

      if (card.kind !== 'cloze') continue

      expect(card.prompt, `${pack.code}:${word.term}`).toContain('____')
      expect(card.prompt.toLowerCase()).not.toContain(word.term.toLowerCase())
    }
  })
})

/**
 * The owl is a fixed-size block, and the band's height depends on it.
 *
 * Its gutter is three rows beside three rows of body; a four-line owl makes the
 * band four rows tall, which scrolls, which disarms every digit hotkey. Nothing
 * else measures it, so a stray line here would be invisible until the quiz
 * stopped taking answers.
 */
describe('the owl', () => {
  const MOODS: Mood[] = ['asleep', 'watching', 'asking', 'happy', 'oops', 'proud']

  it.each(MOODS)('%s is exactly the block the band reserves for it', (mood) => {
    for (const tick of [0, 1, 2, 3, 4, 7, 100]) {
      const face = owl(mood, tick)

      expect(face, `${mood} at tick ${tick}`).toHaveLength(MASCOT_HEIGHT)

      for (const line of face) {
        expect(stringWidth(line), `${mood} at tick ${tick}: "${line}"`).toBe(MASCOT_WIDTH)
      }
    }
  })

  it('blinks without changing size', () => {
    const open = owl('watching', 0)
    const shut = owl('watching', 3)

    expect(shut).not.toEqual(open)
    expect(shut.map(stringWidth)).toEqual(open.map(stringWidth))
  })
})
