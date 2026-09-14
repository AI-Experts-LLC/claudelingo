import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  generatedCodes,
  loadPack,
  loadProgress,
  readSettings,
  saveProgress,
} from '../hooks/deck'
import type { Store } from '../hooks/deck'
import { PACKS_KEY, packKey, progressKey } from '../hooks/names'
import { emptyProgress } from '../hooks/srs'

/**
 * The deck in `$.store`.
 *
 * The CLI's rules about a deck it cannot read are the most carefully-reasoned
 * thing in it, and they survive the move to a store for the same reason they
 * existed: the difference between "the read failed" and "what came back is not
 * a deck" decides whether writing is safe, and getting it wrong erases someone's
 * year of progress rather than losing a card.
 */

/** A store that answers from memory, and can be told to fail. */
function fakeStore(
  entries: Record<string, unknown> = {},
  fail: { get?: string[]; set?: string[] } = {},
): Store & { entries: Record<string, unknown> } {
  const held: Record<string, unknown> = { ...entries }

  return {
    entries: held,
    get: async (key) => {
      if (fail.get?.includes(key)) throw new Error('store unreachable')

      return held[key]
    },
    set: async (key, value) => {
      if (fail.set?.includes(key)) throw new Error('store refused')

      held[key] = value
    },
  }
}

const deckFor = (lang: string) => ({ ...emptyProgress(lang), streak: 7, totalAnswered: 40 })

describe('deck', () => {
  it('starts an empty deck when the store has nothing', async () => {
    const loaded = await loadProgress(fakeStore(), 'es')

    expect(loaded.progress.items).toEqual({})
    expect(loaded.readOnly).toBe(false)
    expect(loaded.trouble).toBeNull()
  })

  it('returns a deck the store already holds', async () => {
    const store = fakeStore({ [progressKey('es')]: deckFor('es') })
    const loaded = await loadProgress(store, 'es')

    expect(loaded.progress.streak).toBe(7)
    expect(loaded.readOnly).toBe(false)
  })

  /**
   * A read that failed says nothing about what is in the store.
   *
   * Break it on purpose — return `readOnly: false` here — and the next answer
   * writes a fresh deck over one that was probably fine.
   */
  it('runs read-only when the deck cannot be read, and saves nothing', async () => {
    const store = fakeStore({}, { get: [progressKey('es')] })
    const loaded = await loadProgress(store, 'es')

    expect(loaded.readOnly).toBe(true)
    expect(loaded.trouble?.text).toContain('not saving')
    expect(store.entries[progressKey('es')]).toBeUndefined()
  })

  it('moves a value that is not a deck aside rather than over it', async () => {
    const wrong = { version: 99, whatever: true }
    const store = fakeStore({ [progressKey('es')]: wrong })
    const loaded = await loadProgress(store, 'es')

    expect(loaded.readOnly).toBe(false)
    expect(loaded.trouble?.text).toContain('quarantine')
    expect(store.entries[`${progressKey('es')}:quarantine`]).toEqual(wrong)
  })

  it('stays read-only when the value could not even be copied aside', async () => {
    const wrong = { version: 99 }

    const store = fakeStore(
      { [progressKey('es')]: wrong },
      { set: [`${progressKey('es')}:quarantine`] },
    )

    const loaded = await loadProgress(store, 'es')

    expect(loaded.readOnly).toBe(true)
    expect(store.entries[progressKey('es')]).toEqual(wrong)
  })

  /**
   * A deck is keyed by language, and the language is part of what makes it one.
   *
   * Without this an `fr` deck read under `es` would be accepted, and every word
   * id in it would miss — silently turning a year of French into an empty
   * Spanish deck that still claims a streak.
   */
  it('does not accept another language’s deck', async () => {
    const store = fakeStore({ [progressKey('es')]: deckFor('fr') })
    const loaded = await loadProgress(store, 'es')

    expect(loaded.progress.streak).toBe(0)
    expect(loaded.trouble?.text).toContain('quarantine')
  })

  it('reports a save it could not make', async () => {
    const store = fakeStore({}, { set: [progressKey('es')] })

    expect(await saveProgress(store, emptyProgress('es'))).not.toBeNull()
    expect(await saveProgress(fakeStore(), emptyProgress('es'))).toBeNull()
  })

  it('falls back field by field rather than losing the whole of settings', () => {
    const settings = readSettings({ lang: 'fr', newPerDay: 'lots', model: '' })

    expect(settings.lang).toBe('fr')
    expect(settings.newPerDay).toBe(DEFAULT_SETTINGS.newPerDay)
    expect(settings.model).toBe(DEFAULT_SETTINGS.model)
  })

  it('takes nothing from a settings value that is not an object', () => {
    expect(readSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('loads a bundled pack', async () => {
    const pack = await loadPack(fakeStore(), 'es')

    expect(pack?.englishName).toBe('Spanish')
    expect(pack?.words.length).toBeGreaterThan(300)
  })

  /**
   * A generated pack cannot shadow a bundled one.
   *
   * Progress is keyed by code *and* by rank, so a store entry claiming `es`
   * would re-attach every box level earned on Spanish to whatever word now sat
   * at that rank. `/lingo pack` refuses to write one; this is the other half.
   */
  it('prefers the bundled pack over anything in the store under its code', async () => {
    const store = fakeStore({
      [packKey('es')]: { code: 'es', name: 'X', englishName: 'X', words: [['x', 'x', 'noun']] },
    })

    const pack = await loadPack(store, 'es')

    expect(pack?.englishName).toBe('Spanish')
  })

  it('loads a generated pack under a code nothing bundles', async () => {
    const store = fakeStore({
      [packKey('pt')]: {
        code: 'pt',
        name: 'Português',
        englishName: 'Portuguese',
        words: [
          ['de', 'of, from', 'prep'],
          ['casa', 'house', 'noun', 'feminine'],
        ],
      },
    })

    const pack = await loadPack(store, 'pt')

    expect(pack?.englishName).toBe('Portuguese')
    expect(pack?.words).toHaveLength(2)
  })

  it('treats an unparseable generated pack as no pack at all', async () => {
    const store = fakeStore({
      [packKey('pt')]: { code: 'pt', words: [['', '', '']] },
    })

    expect(await loadPack(store, 'pt')).toBeNull()
  })

  it('lists generated codes, never bundled ones', async () => {
    const store = fakeStore({ [PACKS_KEY]: ['pt', 'es', 7, 'sv'] })

    expect(await generatedCodes(store)).toEqual(['pt', 'sv'])
  })
})
