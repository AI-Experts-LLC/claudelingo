/**
 * Bringing a deck over from the version of claudelingo that was a CLI.
 *
 * That version kept everything in `~/.claudelingo`: `settings.json` for the
 * language, `progress-<code>.json` per deck. This one keeps it in `$.store`.
 * Someone who has been using the old one has box levels, due dates and a streak
 * in those files, and deleting the CLI without reading them would quietly throw
 * that away — the deck *is* the product, and a year of it is not something to
 * ask anyone to rebuild.
 *
 * So the first session reads them, once, and says what it found.
 *
 * The file format is the same on both sides, which is not luck: the mod took
 * the CLI's `Progress` type unchanged. That makes this a copy rather than a
 * conversion, and the only real work is deciding what to do about collisions.
 *
 * Three rules, all of them the same rule:
 *
 * - **A deck already here wins.** Anything you have answered in the band is
 *   newer than a file last written before you installed this, and merging two
 *   schedules for one word means inventing an answer nobody gave.
 * - **A read that failed is not an empty deck.** That holds for the directory,
 *   for each deck file, and for the store read that checks whether a deck is
 *   already here — a failure at any of the three says so and changes nothing,
 *   because each of them otherwise reads as "there was nothing there" and
 *   authorises a write over something never seen.
 * - **It runs once, but only once it is finished.** The marker is written when
 *   every deck has been imported, skipped, or found not to be a deck — so a
 *   machine with no old install pays one `exists` check per session and nothing
 *   more, while a deck that could not be reached today is tried again tomorrow.
 *   Marking early is what turns a transient failure into permanent loss.
 */

import { isProgress } from './deck'
import type { Store, Trouble } from './deck'
import { MIGRATED_KEY, progressKey } from './names'
import type { Progress, Settings } from './types'

/** The slice of `$` this needs: the host's filesystem, read-only. */
export interface Files {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<readonly { name: string }[]>
}

export interface Migration {
  /** Decks brought over, by language code. */
  imported: string[]
  /** Decks left alone because one was already here. */
  skipped: string[]
  /** The language the old install was studying, if it said. */
  lang: string | null
  trouble: Trouble
}

const NOTHING: Migration = { imported: [], skipped: [], lang: null, trouble: null }

/** `progress-es.json` -> `es`. */
function codeOf(name: string): string | null {
  const match = /^progress-([A-Za-z-]{2,10})\.json$/.exec(name)

  return match?.[1] ?? null
}

/**
 * Read the old install's decks into the store, once.
 *
 * `home` is the directory `~/.claudelingo` sits in; it is passed rather than
 * looked up so a test can point it somewhere harmless.
 */
export async function migrate(
  store: Store,
  files: Files,
  home: string,
): Promise<Migration> {
  // Already done, or deliberately not to be done again.
  try {
    if ((await store.get(MIGRATED_KEY)) !== undefined) return NOTHING
  } catch {
    // An unreadable store is not the place to start writing decks into.
    return NOTHING
  }

  const dir = `${home}/.claudelingo`

  if (!(await files.exists(dir).catch(() => false))) {
    await mark(store)

    return NOTHING
  }

  const result: Migration = { imported: [], skipped: [], lang: null, trouble: null }

  /** Decks that could not be settled either way, so the marker is withheld. */
  const unresolved: string[] = []

  try {
    const entries = await files.list(dir)

    for (const { name } of entries) {
      const code = codeOf(name)

      if (code === null) continue

      const read = await readProgress(files, `${dir}/${name}`, code)

      if (read.kind === 'unreadable') {
        // The file is there and we could not open it. Skipping quietly and
        // marking the import done would strand that deck for ever, including
        // after the permission that caused it is fixed.
        unresolved.push(`${code} (${read.reason})`)

        continue
      }

      // Present but not a deck: an older schema, or a file that only looks like
      // one. Nothing to import and nothing that will change, so it is not a
      // reason to come back.
      if (read.kind === 'invalid') continue

      const progress = read.progress

      // Anything already answered here is newer than a file written before this
      // was installed; two schedules for one word cannot be merged honestly.
      //
      // `.catch(() => undefined)` here would be the whole point of this module
      // thrown away: a store that failed to answer would read as "no deck here"
      // and the import would write over one it never saw. A read that failed
      // authorises no write, which is the rule `deck.ts` is built on.
      let held: unknown

      try {
        held = await store.get(progressKey(code))
      } catch (error) {
        unresolved.push(`${code} (could not check for an existing deck: ${messageOf(error)})`)

        continue
      }

      if (held !== undefined) {
        result.skipped.push(code)

        continue
      }

      try {
        await store.set(progressKey(code), progress)
        result.imported.push(code)
      } catch (error) {
        unresolved.push(`${code} (could not be saved: ${messageOf(error)})`)
      }
    }

    const settings = await readLang(files, `${dir}/settings.json`)

    result.lang = settings.lang

    if (settings.reason !== undefined) unresolved.push(settings.reason)
  } catch (error) {
    // Say so and try again next session: recording success here would mean
    // never looking at those files again.
    return {
      ...result,
      trouble: {
        text: `could not read your old claudelingo deck (${
          error instanceof Error ? error.message : String(error)
        }) — it is still in ${dir}`,
      },
    }
  }

  // Only once everything is either imported, skipped or known not to be a deck.
  // Marking with something still unresolved is what turns a transient failure
  // into permanent loss: the files stay on disk and nothing ever reads them.
  if (unresolved.length > 0) {
    return {
      ...result,
      trouble: {
        text:
          `could not bring over ${unresolved.join(', ')} from ${dir} — ` +
          'it is still there, and this will try again next session',
      },
    }
  }

  // A marker that would not write means this runs again next session; saying
  // "kept the es deck already here" every session from now on is noise, not
  // news, so an unmarked run that moved nothing says nothing at all.
  const marked = await mark(store)

  if (!marked && result.imported.length === 0) return { ...result, skipped: [] }

  return result
}

/**
 * Record that the import is finished, and say whether that stuck.
 *
 * A marker that cannot be written is not a correctness problem — the next
 * session finds every deck already present and imports nothing — but it does
 * mean the notice would be repeated for ever. The caller uses this to stay
 * quiet about decks it did not actually move.
 */
async function mark(store: Store): Promise<boolean> {
  try {
    await store.set(MIGRATED_KEY, new Date().toISOString())

    return true
  } catch {
    return false
  }
}

/**
 * One deck file: readable and a deck, readable and not a deck, or unreadable.
 *
 * Three outcomes rather than two, because the middle one is final and the last
 * one is not. A file whose contents are not a deck will never become one; a
 * file that would not open today may open tomorrow, and the difference decides
 * whether it is safe to stop looking.
 */
type ReadDeck =
  | { kind: 'deck'; progress: Progress }
  | { kind: 'invalid' }
  | { kind: 'unreadable'; reason: string }

async function readProgress(files: Files, path: string, code: string): Promise<ReadDeck> {
  let text: string

  try {
    text = await files.read(path)
  } catch (error) {
    return { kind: 'unreadable', reason: `could not be read: ${messageOf(error)}` }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    // Parsed and rejected: the contents are not a deck and never will be.
    return { kind: 'invalid' }
  }

  // The filename claims a language and the deck carries one. If they disagree
  // the file is not what it says it is, and importing it would attach one
  // language's box levels to another's word ids.
  return isProgress(parsed, code) ? { kind: 'deck', progress: parsed } : { kind: 'invalid' }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The language the old install was on, so this one opens where you left off.
 *
 * Told apart the same way the decks are: a settings file that would not open is
 * not a settings file that named nothing. The difference is small here — the
 * decks are imported either way and the picker asks once — but conflating them
 * would write the marker and lose the answer for good, which is the failure
 * this module exists to avoid.
 */
async function readLang(
  files: Files,
  path: string,
): Promise<{ lang: string | null; reason?: string }> {
  // Absent is a perfectly ordinary answer: it means no language was ever set.
  if (!(await files.exists(path))) return { lang: null }

  let text: string

  try {
    text = await files.read(path)
  } catch (error) {
    return { lang: null, reason: `settings.json could not be read: ${messageOf(error)}` }
  }

  try {
    const parsed: unknown = JSON.parse(text)

    if (typeof parsed !== 'object' || parsed === null) return { lang: null }

    const lang = (parsed as Partial<Settings>).lang

    return { lang: typeof lang === 'string' && lang.length > 0 ? lang : null }
  } catch {
    return { lang: null }
  }
}

/** What to tell someone whose deck has just moved. */
export function migrationNotice(result: Migration): string | null {
  const { imported, skipped } = result

  if (imported.length === 0 && skipped.length === 0) return null

  const parts: string[] = []

  if (imported.length > 0) {
    parts.push(
      `brought ${imported.length === 1 ? 'your' : ''} ${imported.join(', ')} ${
        imported.length === 1 ? 'deck' : 'decks'
      } over from the old claudelingo`.replace('  ', ' '),
    )
  }

  if (skipped.length > 0) {
    parts.push(`kept the ${skipped.join(', ')} deck already here`)
  }

  return `claudelingo: ${parts.join('; ')}.`
}
