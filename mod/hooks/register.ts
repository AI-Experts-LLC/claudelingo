import type { CommandSpec, EngineInterface, On, RenderSurface, Timer } from 'claude-code'

import {
  DEFAULT_SETTINGS,
  generatedCodes,
  loadPack,
  loadProgress,
  loadSettings,
  messageOf,
  saveProgress,
  saveSettings,
} from './deck'
import type { Store, Trouble } from './deck'
import { memoryHook } from './enrich'
import {
  BAND_ROWS,
  COMMAND_NAME,
  PACKS_KEY,
  PLUGIN_NAME,
  REDRAW_MS,
  TICK_MS,
  packKey,
} from './names'
import { BUNDLED_CHOICES, BUNDLED_CODES, materialize } from './pack'
import type { PackChoice } from './pack'
import { generatePack } from './packgen'
import {
  applyAnswer,
  buildCard,
  deferItem,
  emptyProgress,
  isCorrect,
  makeRng,
  selectNext,
  stats,
} from './srs'
import { tickAt } from './ticker'
import { standing } from './ui/tiers'
import type { BandState, Card, Pack, Progress, Settings, Verdict } from './types'
import { bandView, withBand } from './views/band'

/**
 * claudelingo, as a mod.
 *
 * The CLI version of this teaches you a language in the dead time while Claude
 * works, and it is good at that, but it spends most of its code reaching around
 * Claude Code rather than into it. Four things it has to do, and does not have
 * to do here:
 *
 * 1. **Know when the agent is working.** It installs `UserPromptSubmit`, `Stop`,
 *    `SubagentStop`, `SessionEnd` and `Notification` hooks that write a
 *    `status.json` it reads back, treats a `busy` older than fifteen minutes as
 *    idle in case a session was killed mid-turn, and tails the newest rollout
 *    transcript under `~/.codex/sessions` because Codex has no turn-started
 *    hook. Here the band is handed `isWorking` on every draw.
 * 2. **Find a surface that takes a keypress.** Claude Code's status line cannot,
 *    so the CLI ships three surfaces: a read-only panel that names the slash
 *    commands you must type, a `/lingo` skill that asks via a tool dialog, and a
 *    tmux pane for the one surface that takes a key directly. Here the band's
 *    options are `Button`s and a digit presses one.
 * 3. **Own a deck safely.** A lock file per language, because two panes each
 *    hold the whole deck and the second to save erases the first; an atomic
 *    write per answer; a corrupt deck moved aside with a timestamp. Here there
 *    is one band and `$.store`.
 * 4. **Reach a model.** It spawns `claude -p`, which means finding the binary,
 *    saying so once when it is missing, and hiding the explain key. Here,
 *    `$.model.complete`.
 *
 * What is left is the part that was always the point: the scheduler, the words,
 * and the owl. Those are shared with the CLI rather than rewritten — see
 * `mod/scripts/restate.mjs`.
 */

/** The slice of `$` this mod uses, bound once at `session.start`. */
interface Host extends Store {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  complete: EngineInterface['model']['complete']
  invalidate: () => void
  toast: (text: string) => void
  log: (text: string) => void
  registerCommand: (spec: CommandSpec) => Promise<unknown>
  ask: EngineInterface['ui']['ask']
}

const COMMAND: CommandSpec = {
  name: COMMAND_NAME,
  description: 'claudelingo: your standing, your language, and the band above the prompt',
  argumentHint: '[stats | lang <code> | practise | on | off | pack <Language> | reset]',
  // A turn being in flight is exactly when the band is busiest, and every one
  // of these is about the band rather than about the conversation. Waiting for
  // the turn to end would answer questions about a screen that has moved on.
  immediate: true,
}

/**
 * Whether this surface can draw the band: every one but the mobile app, which
 * has no `Input` and so could not put up a `recall` card.
 */
const isDrawable = <E extends Record<'surface', RenderSurface>>(
  e: E,
): e is Exclude<E, Record<'surface', 'mobile'>> => e.surface !== 'mobile'

export function register(on: On) {
  let host: Host | null = null

  let settings: Settings = { ...DEFAULT_SETTINGS }
  let pack: Pack | null = null
  let progress: Progress = emptyProgress('')

  /** Save is off because the deck could not be read. See `deck.ts`. */
  let readOnly = false

  /**
   * What is wrong, in the words the band shows.
   *
   * Kept per cause rather than as one slot, as the CLI's pane keeps it, so a
   * save failure clearing does not hide a store that still cannot be read.
   */
  const troubles = new Map<string, string>()

  let state: BandState = {
    card: null,
    verdict: null,
    practising: false,
    hook: null,
    fetchingHook: false,
    typed: '',
  }

  /** The last frame drawn, so the timer only redraws what has actually moved. */
  let frame = ''

  let ticker: Timer | null = null

  function note(cause: string, trouble: Trouble) {
    if (trouble) troubles.set(cause, trouble.text)
    else troubles.delete(cause)
  }

  const troubleText = (): string | null => {
    const first = troubles.values().next()

    return first.done === true ? null : first.value
  }

  /**
   * Redraw, but only when the picture has changed.
   *
   * The band animates on a clock — the ticker reveals a meaning halfway through
   * each word and the owl blinks — and the engine's own redraws go quiet
   * exactly while a turn is running, which is when the band is meant to be
   * teaching. So it asks for its own. A plain `every(1s) -> invalidate()`
   * would work and would also cost a dispatch a second for the life of every
   * session, most of them repainting an identical band; this signature is what
   * makes that a fair trade.
   */
  function signatureAt(now: number): string {
    if (!settings.on) return 'off'

    const slot = Math.floor(now / TICK_MS)
    const revealed = (now % TICK_MS) / TICK_MS >= 0.5
    const blink = Math.floor(now / 2000) % 4

    return [
      settings.lang,
      state.card?.word.id ?? '-',
      state.verdict ? (state.verdict.correct ? 'y' : 'n') : '-',
      state.hook ? 'h' : '-',
      state.fetchingHook ? 'f' : '-',
      state.typed,
      state.practising ? 'p' : '-',
      troubleText() ?? '-',
      // The ticker's own frame only matters while it is the thing on screen.
      state.card || state.verdict ? '' : `${slot}${revealed ? 'r' : ''}${blink}`,
    ].join('|')
  }

  function startTicker(engine: Host) {
    if (ticker) return

    ticker = engine.every(REDRAW_MS, () => {
      void engine
        .now()
        .then((now) => {
          const next = signatureAt(now)

          if (next === frame) return

          frame = next
          engine.invalidate()
        })
        .catch(() => undefined)
    })
  }

  /** Reload the deck for `settings.lang`, or leave the band on its picker. */
  async function openLanguage(engine: Host, code: string): Promise<void> {
    const loaded = await loadPack(engine, code)

    if (!loaded) {
      note('pack', { text: `no word pack for "${code}" — /lingo lang to see what there is` })

      return
    }

    const deck = await loadProgress(engine, code)

    pack = loaded
    progress = deck.progress
    readOnly = deck.readOnly
    note('deck', deck.trouble)
    state = { ...state, card: null, verdict: null, hook: null, typed: '' }
  }

  /** Whether the band should be asking questions at this moment. */
  const isQuizzing = (isWorking: boolean) =>
    settings.on && (isWorking || state.practising || settings.alwaysOn)

  /**
   * Put a card up if one is due and there is room for it.
   *
   * Called from the render hook, which is where the CLI's pane calls its
   * equivalent from too: the deck and the clock are both already in hand there,
   * and a card chosen anywhere else would be chosen for a band that may since
   * have been told to stand down.
   *
   * `isWorking` is the gate, and it is the whole of the CLI's
   * hooks-plus-status-file-plus-transcript-tailing apparatus reduced to a
   * boolean the engine hands over. Idle means no card: a vocabulary question is
   * the wrong thing to be looking at when Claude is waiting on you.
   */
  function pump(now: number, isWorking: boolean): void {
    if (!pack || state.card || state.verdict) return
    if (!isQuizzing(isWorking)) return

    const picked = selectNext(pack, progress, settings, now)

    if (!picked) return

    state = {
      ...state,
      card: buildCard(pack, picked.word, picked.item, makeRng(now)),
      hook: null,
      typed: '',
    }
  }

  async function persist(engine: Host): Promise<void> {
    if (readOnly) return

    note('save', await saveProgress(engine, progress))
  }

  /** Fold an answer in, show how it went, and schedule what comes next. */
  async function grade(engine: Host, card: Card, response: { choice?: number; text?: string }) {
    const now = await engine.now()
    const correct = isCorrect(card, response)

    progress = applyAnswer(progress, card.word, card, correct, now)

    const verdict: Verdict | null =
      card.kind === 'teach'
        ? null
        : {
            correct,
            answer: card.choices[card.answerIndex] ?? card.accepted[0] ?? card.word.term,
            word: card.word,
          }

    state = { ...state, card: null, verdict, hook: null, typed: '' }

    await persist(engine)
    engine.invalidate()
  }

  const actions = (engine: Host) => ({
    answer: (index: number) => {
      const card = state.card

      if (!card) return

      void grade(engine, card, { choice: index }).catch((error: unknown) =>
        note('grade', { text: messageOf(error) }),
      )
    },

    type: (text: string) => {
      state = { ...state, typed: text }
    },

    spell: (text: string) => {
      const card = state.card

      if (!card) return

      void grade(engine, card, { text }).catch((error: unknown) =>
        note('grade', { text: messageOf(error) }),
      )
    },

    next: () => {
      const card = state.card

      // A `teach` card is an introduction, not a question: acknowledging it is
      // what schedules the word, so it goes through the grader like any other.
      if (card && card.kind === 'teach') {
        void grade(engine, card, {}).catch(() => undefined)

        return
      }

      state = { ...state, card: null, verdict: null, hook: null, typed: '' }
      engine.invalidate()
    },

    skip: () => {
      const card = state.card

      if (!card) return

      void engine
        .now()
        .then(async (now) => {
          // A skip costs nothing but a delay: punishing it would poison the box
          // levels, and it has to work on a word not yet taught, or `selectNext`
          // hands straight back the card just skipped.
          progress = {
            ...progress,
            items: {
              ...progress.items,
              [card.word.id]: deferItem(progress.items[card.word.id], card.word.id, now),
            },
          }

          state = { ...state, card: null, verdict: null, hook: null, typed: '' }

          await persist(engine)
          engine.invalidate()
        })
        .catch(() => undefined)
    },

    explain: () => {
      const word = state.card?.word ?? state.verdict?.word

      if (!word || !pack || state.fetchingHook || !settings.enrich) return

      state = { ...state, fetchingHook: true }
      engine.invalidate()

      void memoryHook(engine, engine, word, settings.model, pack.englishName)
        .then((hook) => {
          state = { ...state, hook, fetchingHook: false }

          if (hook === null) note('hook', { text: 'could not reach the model for a hook' })
          else note('hook', null)

          engine.invalidate()
        })
        .catch(() => {
          state = { ...state, fetchingHook: false }
          engine.invalidate()
        })
    },

    practise: () => {
      state = { ...state, practising: true }
      engine.invalidate()
    },

    chooseLang: (code: string) => {
      void (async () => {
        settings = { ...settings, lang: code }
        note('settings', await saveSettings(engine, settings))
        await openLanguage(engine, code)
        engine.invalidate()
      })().catch((error: unknown) => note('lang', { text: messageOf(error) }))
    },
  })

  /** What the picker offers: bundled, then anything generated into the store. */
  async function choicesFor(engine: Host): Promise<PackChoice[]> {
    const generated = await generatedCodes(engine)

    const extra = await Promise.all(
      generated.map(async (code) => {
        const loaded = await loadPack(engine, code)

        return loaded
          ? { code, englishName: loaded.englishName, words: loaded.words.length }
          : null
      }),
    )

    return [...BUNDLED_CHOICES, ...extra.filter((choice): choice is PackChoice => choice !== null)]
  }

  on('session.start', async ($, e, next) => {
    const engine: Host = {
      now: () => $.clock.now(),
      every: (ms, fn) => $.clock.every(ms, fn),
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      complete: (request) => $.model.complete(request),
      invalidate: () => $.ui.invalidate('ui.render'),
      toast: (text) => $.ui.toast(text),
      log: (text) => $.ui.log(text),
      registerCommand: (spec) => $.command.register(spec),
      ask: (question, options) => $.ui.ask(question, options),
    }

    try {
      await engine.registerCommand(COMMAND)
    } catch (error) {
      // A command name someone else holds costs the command, not the band.
      engine.log(`claudelingo: /${COMMAND_NAME} is taken (${messageOf(error)})`)
    }

    settings = await loadSettings(engine)

    if (settings.lang) await openLanguage(engine, settings.lang)

    host = engine
    startTicker(engine)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const engine = host
    const beneath = await next(e)

    if (!engine || !settings.on) return beneath

    // A survey holds the band and is the person's to answer; the band yields.
    if (e.props.hasSurvey) return beneath

    // A band taller than the rows it is given scrolls in a window — and a
    // scrolling band arms none of its Buttons' hotkeys, which is the whole
    // interaction. Below the height it needs it draws nothing at all rather
    // than something that cannot be answered.
    if (e.props.maxRows < BAND_ROWS) return beneath

    // `mobile` has no `Input`, so a `recall` card could not draw there; the
    // band stays off that surface rather than shipping a card kind that fails.
    if (!isDrawable(e)) return beneath

    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const ui = { Box, Text, Button, Input }
    const now = await engine.now()

    const choices = settings.lang ? null : await choicesFor(engine)

    if (settings.lang) pump(now, e.props.isWorking)

    frame = signatureAt(now)

    const band = bandView(
      { ui, actions: actions(engine), columns: e.props.bodyColumns },
      {
        pack,
        tick: pack ? tickAt(pack, progress, now) : null,
        card: state.card,
        item: state.card ? progress.items[state.card.word.id] : undefined,
        verdict: state.verdict,
        hook: state.hook,
        fetchingHook: state.fetchingHook,
        typed: state.typed,
        streak: progress.streak,
        isWorking: e.props.isWorking,
        practising: state.practising || settings.alwaysOn,
        choices,
        trouble: troubleText(),
        enrich: settings.enrich,
        now,
      },
    )

    return withBand(ui, beneath, band)
  })

  /**
   * The band stands down when Claude needs you.
   *
   * `isWorking` already says whether a turn is running, so nothing here has to
   * track that. What this does is drop a card that is on screen at the moment
   * the turn ends, because the card was put up for the dead time and the dead
   * time is over: leaving it would have you answering vocabulary while Claude
   * waits. Practise mode is the person saying otherwise, so it survives.
   */
  on('turn.complete', ($, e, next) => {
    if (host && !state.practising && !settings.alwaysOn && state.card) {
      state = { ...state, card: null, hook: null, typed: '' }
      host.invalidate()
    }

    return next(e)
  })

  /**
   * A new prompt is a new stretch of dead time, and the end of a practice run.
   *
   * Practise is "quiz me now, even though Claude is idle" — once Claude is not
   * idle any more, the ordinary rule is the better one, and leaving it latched
   * would quiz through the next Notification too.
   */
  on('prompt.submit', ($, e, next) => {
    state = { ...state, practising: false, verdict: null }

    return next(e)
  })

  on('command.run', { command: COMMAND_NAME }, async ($, e, next) => {
    const engine = host

    if (!engine) return next(e)

    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const argument = rest.join(' ')

    switch (verb.toLowerCase()) {
      case '':
      case 'stats':
        return { text: await statsText(engine) }

      case 'lang':
      case 'language':
        return { text: await langText(engine, argument) }

      case 'practise':
      case 'practice':
      case 'quiz':
        state = { ...state, practising: true }
        engine.invalidate()

        return { text: 'Practising: the band will keep asking while Claude is idle.' }

      case 'on':
      case 'off': {
        settings = { ...settings, on: verb.toLowerCase() === 'on' }
        note('settings', await saveSettings(engine, settings))
        engine.invalidate()

        return {
          text: settings.on
            ? 'The band is back above your prompt.'
            : 'The band is off. `/lingo on` brings it back.',
        }
      }

      case 'pack':
        return { text: await packText(engine, argument) }

      case 'reset':
        return { text: await resetText(engine) }

      default:
        return {
          text:
            `Unknown: \`/${COMMAND_NAME} ${verb}\`.\n\n` +
            `\`/${COMMAND_NAME}\` or \`stats\` · \`lang [code]\` · \`practise\` · ` +
            `\`on\`/\`off\` · \`pack <Language>\` · \`reset\``,
        }
    }
  })

  async function statsText(engine: Host): Promise<string> {
    if (!pack) return 'No language chosen yet — press a digit in the band above your prompt.'

    const now = await engine.now()
    const counts = stats(pack, progress, now)
    const where = standing(counts.learned)
    const accuracy = counts.accuracy ? `${Math.round(counts.accuracy * 100)}%` : '—'

    const ahead = where.next
      ? `${where.toGo} more for "${where.next.name}"`
      : 'the top of the list'

    return [
      `**${pack.englishName}** — ${where.tier.name}, ${ahead}`,
      '',
      `words met    ${counts.learned} of ${counts.total}`,
      `mastered     ${counts.mastered}`,
      `due now      ${counts.due}`,
      `streak       ${counts.streak}${counts.bestStreak > counts.streak ? ` (best ${counts.bestStreak})` : ''}`,
      `accuracy     ${accuracy}`,
      readOnly ? '\n_Running read-only: the deck could not be read, so nothing is being saved._' : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  async function langText(engine: Host, code: string): Promise<string> {
    const choices = await choicesFor(engine)

    if (!code) {
      const rows = choices.map(
        (choice) =>
          `- \`${choice.code}\` ${choice.englishName} — ${choice.words} words` +
          (choice.code === settings.lang ? '  ← studying' : ''),
      )

      return [
        'Languages you have:',
        '',
        ...rows,
        '',
        `\`/${COMMAND_NAME} lang <code>\` switches. ` +
          `\`/${COMMAND_NAME} pack <Language>\` builds a new one.`,
      ].join('\n')
    }

    if (!choices.some((choice) => choice.code === code)) {
      return (
        `No pack for \`${code}\`. You have: ${choices.map((c) => c.code).join(', ')}.\n\n` +
        `\`/${COMMAND_NAME} pack <Language>\` builds one.`
      )
    }

    settings = { ...settings, lang: code }
    note('settings', await saveSettings(engine, settings))
    await openLanguage(engine, code)
    engine.invalidate()

    return `Studying ${pack?.englishName ?? code}. Your other decks are kept as they were.`
  }

  /**
   * Build a pack for a language the mod does not ship.
   *
   * The generator is the CLI's, restated rather than rewritten — see
   * `packgen.ts` for why that matters. What differs is the transport and the
   * refusals: `$.model.complete` instead of a subprocess, and a code that a
   * bundled pack already uses is refused here for the reason the CLI refuses
   * it, since progress is keyed by code *and* by rank — a generated `es` would
   * re-attach box levels earned on Spanish to whatever word now sits at each
   * rank.
   */
  async function packText(engine: Host, language: string): Promise<string> {
    if (!language) return `Which language? \`/${COMMAND_NAME} pack Portuguese\``

    const code = language.slice(0, 2).toLowerCase()

    if (BUNDLED_CODES.includes(code)) {
      return (
        `\`${code}\` is a language claudelingo already ships, and progress is keyed by ` +
        `code, so a generated pack would collide with it. Nothing was written.`
      )
    }

    engine.toast(`claudelingo: building a ${language} pack…`)

    try {
      const raw = await generatePack(
        (prompt, { system }) =>
          engine.complete({ model: settings.model, prompt, system, maxTokens: 8000 }),
        language,
        code,
        300,
      )

      // Validate before storing: a half-valid pack in the store would fail on
      // every later load instead of once, here, with a reason.
      const built = materialize(raw)

      await engine.set(packKey(code), raw)

      const known = await generatedCodes(engine)

      await engine.set(PACKS_KEY, [...new Set([...known, code])])

      return (
        `Built **${built.englishName}** — ${built.words.length} words.\n\n` +
        `\`/${COMMAND_NAME} lang ${code}\` to start on it.`
      )
    } catch (error) {
      return `Could not build a ${language} pack: ${messageOf(error)}`
    }
  }

  async function resetText(engine: Host): Promise<string> {
    if (!pack) return 'Nothing to reset yet.'

    const name = pack.englishName

    const answer = await engine
      .ask(`Erase your ${name} progress? This cannot be undone.`, ['Keep it', 'Erase it'])
      .catch(() => 'Keep it')

    if (answer !== 'Erase it') return `Kept your ${name} deck.`

    progress = emptyProgress(pack.code)
    state = { ...state, card: null, verdict: null, hook: null, typed: '' }

    await persist(engine)
    engine.invalidate()

    return `Erased your ${name} deck. Everything starts again from word one.`
  }
}

export const PLUGIN = PLUGIN_NAME
