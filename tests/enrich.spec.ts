import { describe, expect, it, vi } from 'vitest'

import type { Store } from '../hooks/deck'
import { memoryHook, oneLine } from '../hooks/enrich'
import type { Completer } from '../hooks/enrich'
import { hookKey } from '../hooks/names'
import { materialize } from '../hooks/pack'
import { BUNDLED } from '../hooks/packs'

/**
 * Memory hooks — the `explain` key.
 *
 * This module had no tests at all until someone asked whether the button did
 * anything, which is a fair question to have been unable to answer from the
 * suite. The function itself is verified against the real model separately; what
 * is checked here is everything around the call, which is where it can go wrong
 * quietly: a cache that is read before paying, a reply that would break the
 * band's height, and three different failures that must not be reported as the
 * same thing.
 */

const WORD = materialize(BUNDLED[0]!).words.find((w) => w.term === 'tiempo') ?? {
  id: 'es:1', rank: 1, term: 'tiempo', gloss: 'time, weather', pos: 'noun',
}

function fakeStore(entries: Record<string, unknown> = {}, fail: { get?: boolean; set?: boolean } = {}) {
  const held: Record<string, unknown> = { ...entries }

  const store: Store & { entries: Record<string, unknown> } = {
    entries: held,
    get: async (key) => {
      if (fail.get) throw new Error('store unreachable')

      return held[key]
    },
    set: async (key, value) => {
      if (fail.set) throw new Error('store refused')

      held[key] = value
    },
  }

  return store
}

/** A model that answers with `reply`, or throws `fails`. */
function fakeModel(reply: string | Error) {
  const complete = vi.fn(async () => {
    if (reply instanceof Error) throw reply

    return reply
  })

  return { complete } as Completer & { complete: ReturnType<typeof vi.fn> }
}

const ask = (store: Store, model: Completer) =>
  memoryHook(store, model, WORD, 'haiku', 'Spanish')

describe('a memory hook', () => {
  it('asks the model and hands back what it said', async () => {
    const model = fakeModel('Both come from Latin "tempus".')
    const hook = await ask(fakeStore(), model)

    expect(hook.text).toBe('Both come from Latin "tempus".')
    expect(hook.reason).toBeUndefined()
    expect(model.complete).toHaveBeenCalledTimes(1)
  })

  it('tells the model which word, in which language', async () => {
    const model = fakeModel('a hook')

    await ask(fakeStore(), model)

    const request = model.complete.mock.calls[0]?.[0] as { prompt: string; model: string }

    expect(request.prompt).toContain('tiempo')
    expect(request.prompt).toContain('Spanish')
    expect(request.model).toBe('haiku')
  })

  /** A word is only ever paid for once. */
  it('reads the cache before it reaches for the model', async () => {
    const store = fakeStore({ [hookKey(WORD.id)]: 'already known' })
    const model = fakeModel('should not be asked')

    const hook = await ask(store, model)

    expect(hook.text).toBe('already known')
    expect(model.complete).not.toHaveBeenCalled()
  })

  it('caches what it fetched, so the next press is free', async () => {
    const store = fakeStore()

    await ask(store, fakeModel('a hook worth keeping'))

    expect(store.entries[hookKey(WORD.id)]).toBe('a hook worth keeping')
  })

  it('treats an unreadable cache as a miss, not a failure', async () => {
    const hook = await ask(fakeStore({}, { get: true }), fakeModel('fetched anyway'))

    expect(hook.text).toBe('fetched anyway')
  })

  it('still shows a hook it could not cache', async () => {
    const hook = await ask(fakeStore({}, { set: true }), fakeModel('useful right now'))

    expect(hook.text).toBe('useful right now')
  })

  /**
   * Three failures, three messages.
   *
   * `settings.model` takes any non-empty string, so a typo'd model id would
   * otherwise read as "could not reach the model" on every word for ever, while
   * the message that fixes it in one go is the one being discarded.
   */
  it('says which way it failed', async () => {
    const unreachable = await ask(fakeStore(), fakeModel(new Error('no such model: haiku-3')))

    expect(unreachable.text).toBeNull()
    expect(unreachable.reason).toContain('no such model: haiku-3')
    expect(unreachable.reason).toContain('haiku')

    const empty = await ask(fakeStore(), fakeModel('   '))

    expect(empty.text).toBeNull()
    expect(empty.reason).toContain('nothing to say')
    expect(empty.reason).not.toContain('could not reach')
  })

  it('never throws, whatever the model does', async () => {
    const odd = { complete: async () => undefined as unknown as string }

    await expect(ask(fakeStore(), odd)).resolves.toMatchObject({ text: null })
  })

  /**
   * The band has promised to be three rows, and this text is drawn inside it.
   * A newline from the model would break that promise, and a raw escape would
   * be model output restyling the terminal.
   */
  it('flattens a reply that would break the band', async () => {
    const hook = await ask(fakeStore(), fakeModel('two\nlinesand a bell'))

    expect(hook.text).not.toMatch(/[\n\r]/)
    expect(hook.text).toBe('two lines and a bell')
  })

  it('shortens a reply too long to sit in a row', async () => {
    const hook = await ask(fakeStore(), fakeModel('word '.repeat(200)))

    expect(hook.text!.length).toBeLessThanOrEqual(160)
    expect(hook.text!.endsWith('…')).toBe(true)
  })
})

describe('oneLine', () => {
  it('collapses whitespace and control characters', () => {
    expect(oneLine('  a\t b \n c  ')).toBe('a b c')
    expect(oneLine('a[31mb')).toBe('a [31mb')
  })

  it('leaves a short line alone', () => {
    expect(oneLine('already fine')).toBe('already fine')
  })

  it('is empty for an empty reply', () => {
    expect(oneLine('   \n  ')).toBe('')
  })
})
