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
 * - **A read that failed is not an empty deck.** If the file is there but
 *   unreadable, the import stops and says so, rather than recording "nothing to
 *   import" and never looking again.
 * - **It runs once.** The marker is written whatever the outcome, so a machine
 *   with no old install pays one `exists` check per session and nothing more.
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

  try {
    const entries = await files.list(dir)

    for (const { name } of entries) {
      const code = codeOf(name)

      if (code === null) continue

      const progress = await readProgress(files, `${dir}/${name}`, code)

      if (progress === null) continue

      // Anything already answered here is newer than a file written before this
      // was installed; two schedules for one word cannot be merged honestly.
      if ((await store.get(progressKey(code)).catch(() => undefined)) !== undefined) {
        result.skipped.push(code)

        continue
      }

      await store.set(progressKey(code), progress)
      result.imported.push(code)
    }

    result.lang = await readLang(files, `${dir}/settings.json`)
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

  await mark(store)

  return result
}

async function mark(store: Store): Promise<void> {
  try {
    await store.set(MIGRATED_KEY, new Date().toISOString())
  } catch {
    // Worst case it looks again next session and finds everything already here.
  }
}

/** One deck file, if it is a deck for the language its name claims. */
async function readProgress(
  files: Files,
  path: string,
  code: string,
): Promise<Progress | null> {
  let parsed: unknown

  try {
    parsed = JSON.parse(await files.read(path))
  } catch {
    // One unreadable deck does not stop the others.
    return null
  }

  return isProgress(parsed, code) ? parsed : null
}

/** The language the old install was on, so this one opens where you left off. */
async function readLang(files: Files, path: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await files.read(path))

    if (typeof parsed !== 'object' || parsed === null) return null

    const lang = (parsed as Partial<Settings>).lang

    return typeof lang === 'string' && lang.length > 0 ? lang : null
  } catch {
    return null
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
