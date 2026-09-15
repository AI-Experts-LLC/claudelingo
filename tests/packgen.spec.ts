import { describe, expect, it, vi } from 'vitest'

import { EnrichError, generatePack } from '../hooks/packgen'
import type { Asker } from '../hooks/packgen'
import { materialize } from '../hooks/pack'

/**
 * Building a pack for a language claudelingo does not ship.
 *
 * This is the hairiest code that survived the move off the CLI, and every rule
 * it enforces was learned from a run that went wrong: a truncated reply losing
 * 693 words of French, chunk boundaries overlapping until a 1000-word pack held
 * 600 distinct ones, and a model that — asked to fill a quota past the point
 * where it knows the frequency order — starts reciting the dictionary
 * alphabetically.
 *
 * The CLI's version of this suite drove it through a fake `claude -p`
 * subprocess. The generator now takes its transport as an argument, so these
 * drive it through a fake `Asker` instead. Same rules, one less process.
 */

/** A model that replies with whatever is next in the list. */
function fakeModel(replies: string[]) {
  const prompts: string[] = []
  let index = 0

  const ask: Asker = vi.fn(async (prompt: string) => {
    prompts.push(prompt)

    return replies[Math.min(index++, replies.length - 1)] ?? ''
  })

  return { ask, prompts, calls: () => prompts.length }
}

/** A reply holding `count` invented words, numbered from `from`. */
const words = (from: number, count: number, prefix = 'w') =>
  JSON.stringify({
    words: Array.from({ length: count }, (_, i) => ({
      term: `${prefix}${from + i}`,
      gloss: `gloss ${from + i}`,
      pos: 'noun',
    })),
  })

describe('pack generation', () => {
  it('asks the model and returns what it said', async () => {
    const model = fakeModel([words(1, 3)])
    const pack = await generatePack(model.ask, 'Portuguese', 'pt', 3)

    expect(pack.code).toBe('pt')
    expect(pack.englishName).toBe('Portuguese')
    expect(pack.words).toHaveLength(3)
    expect(pack.words[0]?.[0]).toBe('w1')
  })

  it('produces a pack the loader accepts', async () => {
    const model = fakeModel([words(1, 5)])
    const built = materialize(await generatePack(model.ask, 'Portuguese', 'pt', 5))

    expect(built.words).toHaveLength(5)
    expect(built.words[0]?.rank).toBe(1)
  })

  it('strips a code fence the model wrapped its JSON in', async () => {
    const model = fakeModel([`\`\`\`json\n${words(1, 2)}\n\`\`\``])

    expect((await generatePack(model.ask, 'X', 'xx', 2)).words).toHaveLength(2)
  })

  /**
   * Chunks overlap, so the same word comes back twice. Deduping on the *cleaned*
   * term is what stops `materialize` throwing `duplicate term` at the end and
   * losing a run that can take ten minutes.
   */
  it('drops a repeat, however it was spaced or cased', async () => {
    const model = fakeModel([
      JSON.stringify({
        words: [
          { term: 'casa', gloss: 'house', pos: 'noun' },
          { term: '  CASA  ', gloss: 'home', pos: 'noun' },
          { term: 'perro', gloss: 'dog', pos: 'noun' },
        ],
      }),
    ])

    const pack = await generatePack(model.ask, 'X', 'xx', 3)

    expect(pack.words.map((w) => w[0])).toEqual(['casa', 'perro'])
  })

  it('tells each chunk what the ones before it produced', async () => {
    const model = fakeModel([words(1, 100), words(101, 100)])

    await generatePack(model.ask, 'X', 'xx', 200)

    expect(model.calls()).toBeGreaterThan(1)
    expect(model.prompts[1]).toContain('Do not repeat')
    expect(model.prompts[1]).toContain('w1')
  })

  /**
   * A reply that does not parse is usually a truncation. Retrying once at half
   * the size recovers the chunk; throwing instead discarded 693 words of
   * French, about half an hour of somebody's quota.
   */
  it('retries a bad chunk once, at half the size, over the same ranks', async () => {
    const model = fakeModel([words(1, 100), 'not json at all', words(101, 50)])
    const pack = await generatePack(model.ask, 'X', 'xx', 200)

    expect(pack.words.length).toBeGreaterThan(100)
    expect(model.calls()).toBe(3)

    // The retry is the point: half the size, and the same band of ranks, so a
    // retry at full width or one that skipped the failed chunk still fails here.
    expect(model.prompts[1]).toContain('Exactly 100 entries')
    expect(model.prompts[2]).toContain('Exactly 50 entries')
    expect(model.prompts[2]).toContain('ranked 101')
  })

  it('keeps the words it has when a chunk fails twice', async () => {
    const model = fakeModel([words(1, 100), 'nope', 'still nope'])
    const notes: string[] = []

    const pack = await generatePack(model.ask, 'X', 'xx', 300, {
      onProgress: (_done, _total, note) => {
        if (note) notes.push(note)
      },
    })

    expect(pack.words).toHaveLength(100)
    expect(notes.join(' ')).toContain('failed twice')
  })

  it('throws only when it got nothing at all', async () => {
    // Both shapes of nothing: a reply that will not parse, twice over, and one
    // that parses to an empty list.
    await expect(generatePack(fakeModel(['not json']).ask, 'X', 'xx', 10)).rejects.toThrow(
      /no words/,
    )

    await expect(generatePack(fakeModel(['not json']).ask, 'X', 'xx', 10)).rejects.toBeInstanceOf(
      EnrichError,
    )

    await expect(
      generatePack(fakeModel(['{"words":[]}']).ask, 'X', 'xx', 10),
    ).rejects.toThrow(/no words/)
  })

  /**
   * `note` is the gender or irregularity that makes a card answerable, and it
   * has to survive the round trip into the pack's compact row form.
   */
  it('carries a note through to the built pack', async () => {
    const model = fakeModel([
      JSON.stringify({
        words: [{ term: 'casa', gloss: 'house', pos: 'noun', note: 'feminine' }],
      }),
    ])

    const built = materialize(await generatePack(model.ask, 'X', 'xx', 1))

    expect(built.words[0]?.note).toBe('feminine')
  })

  /**
   * Past the point where the model knows the frequency order it starts filling
   * the quota with sludge. Three chunks that add nothing new and it stops.
   */
  it('stops asking once the model has run out of new words', async () => {
    const model = fakeModel([words(1, 50)])
    const pack = await generatePack(model.ask, 'X', 'xx', 1000)

    expect(pack.words).toHaveLength(50)
    // The first chunk, then three barren ones, and no more.
    expect(model.calls()).toBeLessThanOrEqual(4)
  })

  it('never returns more than the ranks asked for', async () => {
    const model = fakeModel([words(1, 100)])

    expect((await generatePack(model.ask, 'X', 'xx', 10)).words.length).toBeLessThanOrEqual(10)
  })

  it('reports how far it got', async () => {
    const seen: number[] = []

    await generatePack(fakeModel([words(1, 5)]).ask, 'X', 'xx', 5, {
      onProgress: (done) => seen.push(done),
    })

    expect(seen.at(-1)).toBe(5)
  })

  it('carries on from words it was already given', async () => {
    const model = fakeModel([words(10, 5, 'later')])

    const pack = await generatePack(model.ask, 'X', 'xx', 8, {
      existing: [
        ['alpha', 'first', 'noun'],
        ['beta', 'second', 'noun'],
      ],
    })

    expect(pack.words.slice(0, 2).map((w) => w[0])).toEqual(['alpha', 'beta'])
    expect(pack.words.length).toBeGreaterThan(2)
  })

  /**
   * A sentence is only usable if it contains the word it is teaching and its
   * translation. The loader drops the rest anyway; keeping them would be junk
   * in a file people read.
   */
  it('keeps an example only when it can actually be blanked', async () => {
    const model = fakeModel([
      JSON.stringify({
        words: [
          { term: 'casa', gloss: 'house', pos: 'noun', example: 'La casa es grande | The house is big' },
          { term: 'perro', gloss: 'dog', pos: 'noun', example: 'No word here | Nothing' },
          { term: 'gato', gloss: 'cat', pos: 'noun', example: 'missing the translation' },
        ],
      }),
    ])

    const built = materialize(await generatePack(model.ask, 'X', 'xx', 3))

    expect(built.words[0]?.example?.text).toBe('La casa es grande')
    expect(built.words[1]?.example).toBeUndefined()
    expect(built.words[2]?.example).toBeUndefined()
  })
})
