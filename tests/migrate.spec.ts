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

function fakeStore(entries: Record<string, unknown> = {}, fail: { set?: string[] } = {}) {
  const held: Record<string, unknown> = { ...entries }

  const store: Store & { entries: Record<string, unknown> } = {
    entries: held,
    get: async (key) => held[key],
    set: async (key, value) => {
      if (fail.set?.includes(key)) throw new Error('store refused')

      held[key] = value
    },
  }

  return store
}

/** A `~/.claudelingo` in memory. */
function fakeFiles(files: Record<string, string> | null, fail: { list?: boolean } = {}): Files {
  return {
    exists: async (path) => files !== null && path === '/home/.claudelingo',
    list: async () => {
      if (fail.list) throw new Error('directory unreadable')

      return Object.keys(files ?? {}).map((name) => ({ name }))
    },
    read: async (path) => {
      const name = path.split('/').pop() as string
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
