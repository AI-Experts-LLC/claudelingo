/**
 * The deck, in `$.store`.
 *
 * claudelingo used to keep this under `~/.claudelingo`, and most of that
 * hard-won care was about the filesystem rather than about learning: an atomic
 * write per answer, a lock file so two panes could not each hold the whole deck
 * and have the second erase the first, a corrupt deck moved aside with a
 * timestamp, a read error told apart from a parse error so a permission problem
 * on a networked home did not replace a deck that was almost certainly fine.
 *
 * None of that is needed here. `$.store` is one store per plugin, owned by the
 * engine, serialised by it, and there is exactly one band. What remains is the
 * part that was never about files: a value read back that is not a deck.
 *
 * Two failures, still told apart, because the right answer differs:
 *
 * - The read **failed** (the host refused, the store is unreachable). That says
 *   nothing about what is in it, so the band runs read-only and saves nothing
 *   rather than writing a fresh deck over one it could not see.
 * - The read **succeeded** and the value is not a deck (an older schema, a
 *   hand-edited store). Overwriting it would silently discard whatever it was,
 *   so it is moved aside under `<key>:quarantine` first, and the band says
 *   where it went.
 */

import { emptyProgress } from './srs'
import { PACKS_KEY, SETTINGS_KEY, packKey, progressKey } from './names'
import type { Pack, Progress, RawPack, Settings } from './types'
import { BUNDLED_CODES, bundledPack, materialize } from './pack'

/** The slice of `$` this module touches. */
export interface Store {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

export const DEFAULT_SETTINGS: Settings = {
  lang: '',
  maxLearning: 8,
  newPerDay: 20,
  alwaysOn: false,
  enrich: true,
  model: 'haiku',
  on: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Settings, with anything unreadable falling back to the default for that
 * field alone.
 *
 * Per field rather than per object: a store written by a later version with one
 * key this one does not understand should cost that key, not the language you
 * chose six months ago.
 */
export function readSettings(value: unknown): Settings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS }

  const pick = <K extends keyof Settings>(key: K, ok: (v: unknown) => boolean): Settings[K] =>
    ok(value[key]) ? (value[key] as Settings[K]) : DEFAULT_SETTINGS[key]

  const isPositive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0

  return {
    lang: pick('lang', (v) => typeof v === 'string'),
    maxLearning: pick('maxLearning', isPositive),
    newPerDay: pick('newPerDay', isPositive),
    alwaysOn: pick('alwaysOn', (v) => typeof v === 'boolean'),
    enrich: pick('enrich', (v) => typeof v === 'boolean'),
    model: pick('model', (v) => typeof v === 'string' && v.length > 0),
    on: pick('on', (v) => typeof v === 'boolean'),
  }
}

/**
 * Is this a deck?
 *
 * Deliberately shallow: the version and the item map. A single malformed item
 * inside an otherwise good deck is not worth quarantining a year of progress
 * over, and every reader of an item already copes with a missing field.
 */
export function isProgress(value: unknown, lang: string): value is Progress {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.lang === lang &&
    isRecord(value.items)
  )
}

/** What went wrong, in the words the band puts on screen. */
export type Trouble = { text: string } | null

export interface LoadedProgress {
  progress: Progress
  /** Save is off: the store could not be read, so it must not be written. */
  readOnly: boolean
  trouble: Trouble
}

/**
 * The deck for a language, and whether it may be written back.
 *
 * Never throws: the band draws whatever this returns, and a card is better than
 * a blank band with an exception behind it.
 */
export async function loadProgress(store: Store, lang: string): Promise<LoadedProgress> {
  const key = progressKey(lang)

  let value: unknown

  try {
    value = await store.get(key)
  } catch (error) {
    return {
      progress: emptyProgress(lang),
      readOnly: true,
      trouble: {
        text: `could not read your deck (${messageOf(error)}) — not saving, so nothing is lost`,
      },
    }
  }

  if (value === undefined) {
    return { progress: emptyProgress(lang), readOnly: false, trouble: null }
  }

  if (isProgress(value, lang)) {
    return { progress: value, readOnly: false, trouble: null }
  }

  // Something is there and it is not a deck. Keep it before writing over it.
  try {
    await store.set(`${key}:quarantine`, value)

    return {
      progress: emptyProgress(lang),
      readOnly: false,
      trouble: { text: `your ${lang} deck could not be read; it is kept at ${key}:quarantine` },
    }
  } catch {
    // The copy failed, so the original is all there is: do not overwrite it.
    return {
      progress: emptyProgress(lang),
      readOnly: true,
      trouble: { text: `your ${lang} deck could not be read or copied aside — not saving` },
    }
  }
}

export async function saveProgress(store: Store, progress: Progress): Promise<Trouble> {
  try {
    await store.set(progressKey(progress.lang), progress)

    return null
  } catch (error) {
    return { text: `could not save: ${messageOf(error)}` }
  }
}

export interface LoadedSettings {
  settings: Settings
  /** Save is off: the settings could not be read, so they must not be written. */
  readOnly: boolean
  trouble: Trouble
}

/**
 * Settings, and whether they may be written back.
 *
 * The same rule as the deck, and it matters more here than it looks. Handing
 * back the defaults on a failed read means `lang: ''` — the language picker, as
 * though you had never chosen — and `on: true`, the band returning for someone
 * who ran `/lingo off`. The first press would then save those defaults over the
 * real settings. A read that failed authorises no write.
 */
export async function loadSettings(store: Store): Promise<LoadedSettings> {
  try {
    return {
      settings: readSettings(await store.get(SETTINGS_KEY)),
      readOnly: false,
      trouble: null,
    }
  } catch (error) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      readOnly: true,
      trouble: {
        text: `could not read your settings (${messageOf(error)}) — not saving over them`,
      },
    }
  }
}

export async function saveSettings(store: Store, settings: Settings): Promise<Trouble> {
  try {
    await store.set(SETTINGS_KEY, settings)

    return null
  } catch (error) {
    return { text: `could not save settings: ${messageOf(error)}` }
  }
}

/**
 * The pack for a code: bundled first, then one generated into the store.
 *
 * Bundled first, because progress is keyed by code *and* by rank: a generated
 * `es` would re-attach box levels earned on Spanish to whatever word now sits
 * at each rank. `/lingo pack` refuses to write one; this order is the belt to
 * that's braces.
 */
export type LoadedPack =
  | { pack: Pack; reason?: undefined }
  | { pack: null; reason: string }

export async function loadPack(store: Store, code: string): Promise<LoadedPack> {
  const bundled = bundledPack(code)

  if (bundled) return { pack: materialize(bundled) }

  let value: unknown

  try {
    value = await store.get(packKey(code))
  } catch (error) {
    // Not "there is no such pack": the store did not answer. Saying the pack is
    // missing would send someone off to spend ten minutes regenerating one that
    // is sitting right there.
    return { pack: null, reason: `could not read the ${code} pack: ${messageOf(error)}` }
  }

  if (!isRecord(value)) {
    return { pack: null, reason: `no word pack for "${code}"` }
  }

  try {
    return { pack: materialize(value as unknown as RawPack) }
  } catch (error) {
    // `materialize` knows exactly what is wrong (`duplicate term "casa"`), and
    // that is the only thing that tells someone how to fix it by hand.
    return { pack: null, reason: `the ${code} pack could not be read: ${messageOf(error)}` }
  }
}

export interface LoadedCodes {
  codes: string[]
  /** The read failed, so this list is not evidence that there are no packs. */
  failed: boolean
}

/**
 * The codes of packs generated into the store, bundled ones excluded.
 *
 * `failed` is the whole point of the shape. `/lingo pack` rewrites this index
 * by reading it and writing it back, and an empty list from a failed read would
 * make that write erase every pack the user has ever generated — the bodies
 * survive under their own keys, but nothing would ever look at them again.
 * A read that failed authorises no write, here as everywhere else.
 */
export async function generatedCodes(store: Store): Promise<LoadedCodes> {
  try {
    const value = await store.get(PACKS_KEY)

    if (!Array.isArray(value)) return { codes: [], failed: false }

    return {
      codes: value.filter(
        (code): code is string => typeof code === 'string' && !BUNDLED_CODES.includes(code),
      ),
      failed: false,
    }
  } catch {
    return { codes: [], failed: true }
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
