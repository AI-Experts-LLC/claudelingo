import { describe, expect, it } from 'vitest'

import type { Store } from '../hooks/deck'
import { MIGRATED_KEY, progressKey } from '../hooks/names'
import { migrate, migrationNotice } from '../hooks/migrate'
import type { Files } from '../hooks/migrate'
import { emptyProgress } from '../hooks/srs'

/**
 * Bringing a deck over from the version of claudelingo that was a CLI.
 *
 * This is the code that decides whether deleting the CLI costs anyone their
 * progress, so it gets the most suspicious tests in the repo. The cases that
 * matter are the ones where it should do *less* than it could: a deck already
 * here, a file it cannot read, a store it cannot write.
 */

function fakeStore(
  entries: Record<string, unknown> = {},
  fail: { set?: string[]; get?: string[] } = {},
) {
  const held: Record<string, unknown> = { ...entries }

  const store: Store & { entries: Record<string, unknown> } = {
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

  return store
}

/** A `~/.claudelingo` in memory. */
function fakeFiles(
  files: Record<string, string> | null,
  fail: { list?: boolean; read?: string[] } = {},
): Files {
  return {
    exists: async (path) => {
      if (files === null) return false
      if (path === '/home/.claudelingo') return true

      return Object.keys(files).includes(path.split('/').pop() as string)
    },
    list: async () => {
      if (fail.list) throw new Error('directory unreadable')

      return Object.keys(files ?? {}).map((name) => ({ name }))
    },
    read: async (path) => {
      const name = path.split('/').pop() as string

      if (fail.read?.includes(name)) throw new Error('EACCES: permission denied')

      const text = files?.[name]

      if (text === undefined) throw new Error(`no such file: ${path}`)

      return text
    },
  }
}

const deck = (lang: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ ...emptyProgress(lang), streak: 4, totalAnswered: 11, totalCorrect: 9, ...over })

describe('migrating the old CLI deck', () => {
  it('brings every deck over and remembers the language', async () => {
    const store = fakeStore()

    const result = await migrate(
      store,
      fakeFiles({
        'progress-es.json': deck('es'),
        'progress-fr.json': deck('fr'),
        'settings.json': JSON.stringify({ lang: 'fr' }),
      }),
      '/home',
    )

    expect(result.imported.sort()).toEqual(['es', 'fr'])
    expect(result.lang).toBe('fr')

    const moved = store.entries[progressKey('es')] as { streak: number; totalAnswered: number }

    expect(moved.streak).toBe(4)
    expect(moved.totalAnswered).toBe(11)
  })

  /**
   * Anything answered here is newer than a file written before this was
   * installed, and two schedules for one word cannot be merged without
   * inventing an answer nobody gave.
   */
  it('never writes over a deck that is already here', async () => {
    const mine = { ...emptyProgress('es'), streak: 99 }
    const store = fakeStore({ [progressKey('es')]: mine })

    const result = await migrate(store, fakeFiles({ 'progress-es.json': deck('es') }), '/home')

    expect(result.imported).toEqual([])
    expect(result.skipped).toEqual(['es'])
    expect((store.entries[progressKey('es')] as { streak: number }).streak).toBe(99)
  })

  it('runs once, and says so in the store', async () => {
    const store = fakeStore()
    const files = fakeFiles({ 'progress-es.json': deck('es') })

    await migrate(store, files, '/home')

    expect(store.entries[MIGRATED_KEY]).toBeDefined()

    // A second pass finds the marker and does nothing, even though the file and
    // the deck are both still sitting there.
    store.entries[progressKey('es')] = undefined
    const again = await migrate(store, files, '/home')

    expect(again.imported).toEqual([])
    expect(store.entries[progressKey('es')]).toBeUndefined()
  })

  it('marks a machine that never had the old install, so it stops looking', async () => {
    const store = fakeStore()
    const result = await migrate(store, fakeFiles(null), '/home')

    expect(result.imported).toEqual([])
    expect(store.entries[MIGRATED_KEY]).toBeDefined()
  })

  /**
   * A directory that would not open is not an empty one. Recording success here
   * would mean never looking at those files again — the deck would be sitting
   * on disk, unreachable, with nothing ever saying why.
   */
  it('does not mark itself done when it could not read the directory', async () => {
    const store = fakeStore()
    const result = await migrate(store, fakeFiles({}, { list: true }), '/home')

    expect(result.trouble?.text).toContain('could not read')
    expect(result.trouble?.text).toContain('/home/.claudelingo')
    expect(store.entries[MIGRATED_KEY]).toBeUndefined()
  })

  it('skips a file that is not a deck, and keeps the ones that are', async () => {
    const store = fakeStore()

    const result = await migrate(
      store,
      fakeFiles({
        'progress-es.json': 'not json',
        'progress-fr.json': deck('fr'),
        'progress-it.json': JSON.stringify({ version: 99 }),
        'status.json': '{"state":"idle"}',
      }),
      '/home',
    )

    expect(result.imported).toEqual(['fr'])
  })

  /**
   * A deck carries its own language, and the filename claims one too. If they
   * disagree the file is not what it says it is, and importing it would attach
   * one language's box levels to another's word ids.
   */
  it('refuses a deck whose contents disagree with its filename', async () => {
    const store = fakeStore()
    const result = await migrate(store, fakeFiles({ 'progress-es.json': deck('fr') }), '/home')

    expect(result.imported).toEqual([])
    expect(store.entries[progressKey('es')]).toBeUndefined()
  })

  /**
   * A settings file that would not open is not one that named no language.
   * Conflating them writes the marker and loses the answer for good.
   */
  it('comes back for settings it could not read', async () => {
    const store = fakeStore()

    const result = await migrate(
      store,
      fakeFiles(
        { 'progress-es.json': deck('es'), 'settings.json': '{"lang":"fr"}' },
        { read: ['settings.json'] },
      ),
      '/home',
    )

    expect(result.imported).toEqual(['es'])
    expect(result.lang).toBeNull()
    expect(result.trouble?.text).toContain('settings.json')
    expect(store.entries[MIGRATED_KEY]).toBeUndefined()
  })

  /**
   * A marker that will not write means this runs again next session. Repeating
   * "kept the es deck already here" every session from then on is noise.
   */
  /**
    * The quiet rule is narrow on purpose: silence is for a run that moved
    * nothing. A genuine import must still be announced even if the marker
    * would not write, or someone's deck moves and nobody says so.
    */
  it('still announces a real import even when the marker would not write', async () => {
    const store = fakeStore(
      { [progressKey('fr')]: emptyProgress('fr') },
      { set: [MIGRATED_KEY] },
    )

    const result = await migrate(
      store,
      fakeFiles({ 'progress-es.json': deck('es'), 'progress-fr.json': deck('fr') }),
      '/home',
    )

    // One moved and one was left alone. The quiet rule is for a run that moved
    // nothing, so widening it to every unmarked run would drop the second half
    // of a notice that still has something to say.
    expect(result.imported).toEqual(['es'])
    expect(result.skipped).toEqual(['fr'])

    const notice = migrationNotice(result)

    expect(notice).toContain('es')
    expect(notice).toContain('kept the fr deck')
  })

  it('stays quiet when it moved nothing and could not record that it finished', async () => {
    const store = fakeStore(
      { [progressKey('es')]: emptyProgress('es') },
      { set: [MIGRATED_KEY] },
    )

    const result = await migrate(store, fakeFiles({ 'progress-es.json': deck('es') }), '/home')

    expect(result.imported).toEqual([])
    expect(migrationNotice(result)).toBeNull()
  })

  it('ignores settings that name no language', async () => {
    const store = fakeStore()

    const result = await migrate(
      store,
      fakeFiles({ 'progress-es.json': deck('es'), 'settings.json': '{"lang":""}' }),
      '/home',
    )

    expect(result.lang).toBeNull()
    expect(result.imported).toEqual(['es'])
  })

  /**
   * The three ways a read can fail, each of which otherwise reads as "nothing
   * there" and authorises a write over something never seen.
   *
   * Every one of these passed before the check that produces it existed — they
   * are here because a reviewer found them by probing, not because the suite
   * did. Break any of the three guards and the matching case fails.
   */
  describe('a read that failed authorises no write', () => {
    it('does not overwrite a deck it could not check for', async () => {
      const mine = { ...emptyProgress('es'), streak: 99 }

      const store = fakeStore(
        { [progressKey('es')]: mine },
        { get: [progressKey('es')] },
      )

      const result = await migrate(store, fakeFiles({ 'progress-es.json': deck('es') }), '/home')

      // The store said nothing about whether a deck was there, so nothing is
      // written over it, and the import is not recorded as done.
      expect((store.entries[progressKey('es')] as { streak: number }).streak).toBe(99)
      expect(result.imported).toEqual([])
      expect(result.trouble?.text).toContain('es')
      expect(store.entries[MIGRATED_KEY]).toBeUndefined()
    })

    it('comes back for a deck file it could not open', async () => {
      const store = fakeStore()

      const result = await migrate(
        store,
        fakeFiles(
          { 'progress-es.json': deck('es'), 'progress-fr.json': deck('fr') },
          { read: ['progress-es.json'] },
        ),
        '/home',
      )

      // The one that opened is imported; the one that did not is named, and
      // the marker is withheld so it is tried again rather than stranded.
      expect(result.imported).toEqual(['fr'])
      expect(result.trouble?.text).toContain('es')
      expect(result.trouble?.text).toContain('try again')
      expect(store.entries[MIGRATED_KEY]).toBeUndefined()
    })

    it('comes back for a deck it read but could not save', async () => {
      const store = fakeStore({}, { set: [progressKey('es')] })

      const result = await migrate(store, fakeFiles({ 'progress-es.json': deck('es') }), '/home')

      expect(result.imported).toEqual([])
      expect(result.trouble?.text).toContain('could not be saved')
      expect(store.entries[MIGRATED_KEY]).toBeUndefined()
    })

    /**
     * Contents that are not a deck are final, not transient: they will never
     * become one, so they are not a reason to keep looking for ever.
     */
    /**
     * A store that will not answer is no place to start writing decks into,
     * and the marker check is the first thing that touches it.
     */
    it('does nothing at all when the store will not answer', async () => {
      const store = fakeStore({}, { get: [MIGRATED_KEY] })

      const result = await migrate(store, fakeFiles({ 'progress-es.json': deck('es') }), '/home')

      expect(result.imported).toEqual([])
      expect(store.entries[progressKey('es')]).toBeUndefined()
      expect(store.entries[MIGRATED_KEY]).toBeUndefined()
    })

    it('still finishes when a file is merely not a deck', async () => {
      const store = fakeStore()

      const result = await migrate(
        store,
        fakeFiles({ 'progress-es.json': 'not json', 'progress-fr.json': deck('fr') }),
        '/home',
      )

      expect(result.imported).toEqual(['fr'])
      expect(result.trouble).toBeNull()
      expect(store.entries[MIGRATED_KEY]).toBeDefined()
    })
  })

  it('says what it did, and nothing when it did nothing', () => {
    expect(migrationNotice({ imported: [], skipped: [], lang: null, trouble: null })).toBeNull()

    const moved = migrationNotice({ imported: ['es'], skipped: [], lang: 'es', trouble: null })

    expect(moved).toContain('es')
    expect(moved).toContain('old claudelingo')

    const both = migrationNotice({ imported: ['fr'], skipped: ['es'], lang: null, trouble: null })

    expect(both).toContain('fr')
    expect(both).toContain('kept the es deck')
  })
})
