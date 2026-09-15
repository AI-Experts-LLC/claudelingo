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
  PACK_WORDS,
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
  status: (text: string | undefined) => void
  registerCommand: (spec: CommandSpec) => Promise<unknown>
  ask: EngineInterface['ui']['ask']
}

const COMMAND: CommandSpec = {
  name: COMMAND_NAME,
  description: 'claudelingo: your standing, your language, and the band above the prompt',
  argumentHint: '[stats | lang <code> | practise | on | off | pack <Language> <code> | reset]',
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

  /** The same, for settings: a failed read must not authorise writing over them. */
  let settingsReadOnly = false

  /**
   * Which request a memory hook belongs to.
   *
   * Bumped whenever the card changes. A reply that arrives after the card has
   * gone carries a stale token and is dropped — without it, the mnemonic for a
   * word you skipped lands as the aside under the next word's verdict, which is
   * confidently worded and wrong.
   */
  let hookToken = 0

  /**
   * What is wrong, in the words the person reads.
   *
   * Kept per cause, as the CLI's pane keeps it, so one clearing never hides
   * another — and *shown* by severity rather than by arrival, which is the part
   * a Map alone does not give you. A store that has stopped accepting answers
   * matters more than a memory hook that could not be fetched, whichever
   * happened first.
   *
   * It is pinned with `$.ui.status`, not drawn in the band. The band is three
   * rows and the third is the controls; an error that took that row would
   * delete the very keys needed to clear it, which is a trap rather than a
   * message. `$.ui.status` is the engine's own affordance for a line that stays
   * until it is replaced, and it costs the band nothing.
   */
  const troubles = new Map<string, string>()

  /** Worst first. Anything unlisted sorts last, in insertion order. */
  const SEVERITY = ['settings', 'deck', 'save', 'pack', 'lang', 'grade', 'hook']

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

  /**
   * Record or clear one cause, and put the worst of them under the prompt.
   *
   * Every caller that can fail records here, and every caller that can succeed
   * clears the same cause on its way through — a stale error is worse than
   * none, because it hides the next real one behind it.
   */
  function note(cause: string, trouble: Trouble) {
    const had = troubleText()

    if (trouble) troubles.set(cause, trouble.text)
    else troubles.delete(cause)

    const now = troubleText()

    if (now !== had) host?.status(now ?? undefined)
  }

  function troubleText(): string | null {
    if (troubles.size === 0) return null

    const ranked = [...troubles.keys()].sort((a, b) => {
      const rank = (cause: string) => {
        const at = SEVERITY.indexOf(cause)

        return at === -1 ? SEVERITY.length : at
      }

      return rank(a) - rank(b)
    })

    const worst = ranked[0] as string
    const rest = troubles.size - 1

    return `claudelingo: ${troubles.get(worst)}${rest > 0 ? ` (+${rest} more, /lingo stats)` : ''}`
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

  /**
   * Reload the deck for a language.
   *
   * Returns whether it opened, because the callers have already written
   * `settings.lang` by the time they call: one that failed silently would leave
   * the band quizzing the previous language while the settings named another,
   * and the next session opening a language with no pack.
   */
  async function openLanguage(engine: Host, code: string): Promise<boolean> {
    const loaded = await loadPack(engine, code)

    if (loaded.pack === null) {
      note('pack', { text: `${loaded.reason} — /lingo lang to see what there is` })

      return false
    }

    const deck = await loadProgress(engine, code)

    pack = loaded.pack
    progress = deck.progress
    readOnly = deck.readOnly
    hookToken += 1
    note('pack', null)
    note('lang', null)
    note('deck', deck.trouble)

    // `fetchingHook` goes with the token. Leaving it set drops the in-flight
    // reply correctly but strands the next card's explain button on "asking…",
    // where pressing it does nothing.
    state = { ...state, card: null, verdict: null, hook: null, fetchingHook: false, typed: '' }

    return true
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

  /**
   * Write the settings, unless they were never successfully read.
   *
   * Saving defaults over settings we could not see would lose the language,
   * the model and an `/lingo off` in one go.
   */
  async function saveSettingsIfAllowed(engine: Host): Promise<void> {
    if (settingsReadOnly) return

    note('settings', await saveSettings(engine, settings))
  }

  /**
   * Fold an answer in, show how it went, and schedule what comes next.
   *
   * The card comes off the band *before* the first await. Held keys repeat and
   * fingers double-tap, and two presses either side of `await engine.now()`
   * would both capture the same card: `applyAnswer` twice, a doubled streak and
   * a two-box promotion for one answer.
   */
  async function grade(engine: Host, card: Card, response: { choice?: number; text?: string }) {
    if (state.card !== card) return

    state = { ...state, card: null, hook: null, fetchingHook: false, typed: '' }
    hookToken += 1

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

    state = { ...state, verdict }
    note('grade', null)

    await persist(engine)
    engine.invalidate()
  }

  const actions = (engine: Host) => ({
    answer: (index: number) => {
      const card = state.card

      if (!card) return

      void grade(engine, card, { choice: index }).catch((error: unknown) => {
        note('grade', { text: messageOf(error) })
        engine.invalidate()
      })
    },

    type: (text: string) => {
      state = { ...state, typed: text }
    },

    spell: (text: string) => {
      const card = state.card

      if (!card) return

      void grade(engine, card, { text }).catch((error: unknown) => {
        note('grade', { text: messageOf(error) })
        engine.invalidate()
      })
    },

    next: () => {
      const card = state.card

      // A `teach` card is an introduction, not a question: acknowledging it is
      // what schedules the word, so it goes through the grader like any other.
      if (card && card.kind === 'teach') {
        void grade(engine, card, {}).catch((error: unknown) => {
          note('grade', { text: messageOf(error) })
          engine.invalidate()
        })

        return
      }

      state = { ...state, card: null, verdict: null, hook: null, fetchingHook: false, typed: '' }
      hookToken += 1
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

          state = {
            ...state,
            card: null,
            verdict: null,
            hook: null,
            fetchingHook: false,
            typed: '',
          }

          hookToken += 1
          note('grade', null)

          await persist(engine)
          engine.invalidate()
        })
        .catch((error: unknown) => {
          // Silence here left the card on screen with nothing said: press,
          // nothing happens, press again, nothing happens.
          note('grade', { text: `could not skip: ${messageOf(error)}` })
          engine.invalidate()
        })
    },

    explain: () => {
      const word = state.card?.word ?? state.verdict?.word

      if (!word || !pack || state.fetchingHook || !settings.enrich) return

      // The card this hook is for. Anything that changes the card bumps the
      // token, so a slow reply for a word that has gone is dropped rather than
      // drawn under whatever is on screen now.
      const token = hookToken

      state = { ...state, fetchingHook: true }
      engine.invalidate()

      void memoryHook(engine, engine, word, settings.model, pack.englishName)
        .then((hook) => {
          if (token !== hookToken) return

          state = { ...state, hook: hook.text, fetchingHook: false }
          note('hook', hook.text === null ? { text: hook.reason } : null)
          engine.invalidate()
        })
        .catch((error: unknown) => {
          if (token !== hookToken) return

          state = { ...state, fetchingHook: false }
          note('hook', { text: `could not fetch a hook: ${messageOf(error)}` })
          engine.invalidate()
        })
    },

    practise: () => {
      state = { ...state, practising: true }
      engine.invalidate()
    },

    chooseLang: (code: string) => {
      void (async () => {
        const previous = settings.lang

        settings = { ...settings, lang: code }

        if (await openLanguage(engine, code)) {
          await saveSettingsIfAllowed(engine)
        } else {
          // The pack would not open, so do not leave the settings naming it —
          // the next session would start on a language with nothing to study.
          settings = { ...settings, lang: previous }
        }

        engine.invalidate()
      })().catch((error: unknown) => {
        note('lang', { text: messageOf(error) })
        engine.invalidate()
      })
    },
  })

  /** What the picker offers: bundled, then anything generated into the store. */
  async function choicesFor(engine: Host): Promise<PackChoice[]> {
    const generated = await generatedCodes(engine)

    const extra = await Promise.all(
      generated.codes.map(async (code) => {
        const loaded = await loadPack(engine, code)

        return loaded.pack
          ? { code, englishName: loaded.pack.englishName, words: loaded.pack.words.length }
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
      status: (text) => $.ui.status(text),
      registerCommand: (spec) => $.command.register(spec),
      ask: (question, options) => $.ui.ask(question, options),
    }

    // Bound before anything that can fail. Assigning it last meant a single
    // rejection above left `host` null for the session: no band, ever, and
    // `/lingo` falling through to nothing, with no message of its own.
    host = engine
    startTicker(engine)

    try {
      await engine.registerCommand(COMMAND)
    } catch (error) {
      // A command name someone else holds costs the command, not the band.
      engine.log(`claudelingo: /${COMMAND_NAME} is taken (${messageOf(error)})`)
    }

    const loaded = await loadSettings(engine)

    settings = loaded.settings
    settingsReadOnly = loaded.readOnly
    note('settings', loaded.trouble)

    if (settings.lang) await openLanguage(engine, settings.lang)

    return next(e)
  }).catch(($, e, next) => {
    // A hook that throws is skipped, and a skipped `session.start` would leave
    // the band bound to nothing. Whatever failed, the session carries on.
    host?.log(`claudelingo: could not start (${messageOf(next.error)})`)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const engine = host
    const beneath = await next(e)

    if (!engine) return beneath

    // Every path that draws nothing still stamps the frame. Leaving it stale
    // had the ticker fire an invalidate a second for as long as a survey held
    // the band — the dispatch-per-second the signature exists to avoid.
    const standDown = async () => {
      frame = signatureAt(await engine.now().catch(() => 0))

      return beneath
    }

    if (!settings.on) return standDown()

    // A survey holds the band and is the person's to answer; the band yields.
    if (e.props.hasSurvey) return standDown()

    // A band taller than the rows it is given scrolls in a window — and a
    // scrolling band arms none of its Buttons' hotkeys, which is the whole
    // interaction. Below the height it needs it draws nothing at all rather
    // than something that cannot be answered.
    if (e.props.maxRows < BAND_ROWS) return standDown()

    // `mobile` has no `Input`, so a `recall` card could not draw there; the
    // band stays off that surface rather than shipping a card kind that fails.
    if (!isDrawable(e)) return standDown()

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
    const showing = state.card !== null || state.verdict !== null

    if (host && !state.practising && !settings.alwaysOn && showing) {
      // The verdict goes with the card. Leaving it would pin "correct — el =
      // the" across the whole idle stretch, and `pump` refuses a new card while
      // one stands, so the band would be frozen on it until the next prompt.
      state = { ...state, card: null, verdict: null, hook: null, fetchingHook: false, typed: '' }
      hookToken += 1
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
        await saveSettingsIfAllowed(engine)
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

  /** Everything outstanding, for the pinned line that can only show one. */
  function troubleList(): string[] {
    if (troubles.size === 0) return []

    return ['', '**Outstanding:**', ...[...troubles].map(([cause, text]) => `- ${cause}: ${text}`)]
  }

  async function statsText(engine: Host): Promise<string> {
    // Still list the troubles: the pinned line promises they are here, and the
    // no-language case is exactly when a failed read is why.
    if (!pack) {
      return [
        'No language chosen yet — press a digit in the band above your prompt.',
        ...troubleList(),
      ].join('\n')
    }

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
      settingsReadOnly ? '_Your settings could not be read, so changes are not being saved._' : '',
      ...troubleList(),
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
          `\`/${COMMAND_NAME} pack <Language> <code>\` builds a new one.`,
      ].join('\n')
    }

    if (!choices.some((choice) => choice.code === code)) {
      return (
        `No pack for \`${code}\`. You have: ${choices.map((c) => c.code).join(', ')}.\n\n` +
        `\`/${COMMAND_NAME} pack <Language>\` builds one.`
      )
    }

    const previous = settings.lang

    settings = { ...settings, lang: code }

    if (!(await openLanguage(engine, code))) {
      settings = { ...settings, lang: previous }
      engine.invalidate()

      return `Could not open \`${code}\`: ${troubles.get('pack') ?? 'the pack would not load'}`
    }

    await saveSettingsIfAllowed(engine)
    engine.invalidate()

    return `Studying ${pack?.englishName ?? code}. Your other decks are kept as they were.`
  }

  /**
   * Build a pack for a language the mod does not ship.
   *
   * The generator is the CLI's, restated rather than rewritten — see
   * `packgen.ts` for why that matters. What differs is the transport and the
   * refusals: `$.model.complete` instead of a subprocess, and three checks that
   * all exist for one reason. Progress is keyed by code *and* by rank, so any
   * pack that lands on a code some deck already uses re-attaches every box
   * level earned there to whatever word now sits at each rank.
   */
  async function packText(engine: Host, argument: string): Promise<string> {
    const [language = '', given] = argument.split(/\s+/).filter(Boolean)

    if (!language) {
      return `Which language? \`/${COMMAND_NAME} pack Portuguese\`, or ` +
        `\`/${COMMAND_NAME} pack Portuguese pt\` to choose the code.`
    }

    // The code names the pack *and* the deck, so it is worth giving: the
    // fallback is the first two letters, and "Portuguese" that way is `po`,
    // which is nobody's idea of Portuguese and collides with Polish besides.
    // The fallback stays — refusing without one would be unhelpful — but every
    // message below names the code that was actually used.
    const code = (given ?? language.slice(0, 2)).toLowerCase()

    if (!/^[a-z]{2}$/.test(code)) {
      return `\`${code}\` is not a two-letter code. Try \`/${COMMAND_NAME} pack ${language} pt\`.`
    }

    if (BUNDLED_CODES.includes(code)) {
      return (
        `\`${code}\` is a language claudelingo already ships, and progress is keyed by ` +
        `code, so a generated pack would collide with it. Nothing was written. ` +
        `Pick another code: \`/${COMMAND_NAME} pack ${language} xx\`.`
      )
    }

    const known = await generatedCodes(engine)

    // A failed read is not an empty index. Writing one back would erase every
    // pack already generated — the bodies survive under their own keys, but
    // nothing would ever look at them again.
    if (known.failed) {
      note('pack', { text: 'could not read the pack index — not generating over it' })

      return 'Could not read your list of generated packs, so nothing was built: writing a new one would have erased it.'
    }

    if (known.codes.includes(code)) {
      const answer = await engine
        .ask(
          `You already have a pack under "${code}". Replace it?`,
          ['Keep it', 'Replace it'],
        )
        .catch(() => 'Keep it')

      if (answer !== 'Replace it') return `Kept your existing \`${code}\` pack.`
    }

    engine.toast(`claudelingo: building a ${language} pack…`)

    const notes: string[] = []

    try {
      const raw = await generatePack(
        (prompt, { system }) =>
          engine.complete({ model: settings.model, prompt, system, maxTokens: 8000 }),
        language,
        code,
        PACK_WORDS,
        {
          // The generator reports a chunk that failed twice and a run that
          // stopped short. Dropping those reported a 100-word pack as a
          // success when two thirds of it had been lost.
          onProgress: (done, total, note) => {
            if (note) notes.push(note)
            engine.status(`claudelingo: ${language} pack — ${done}/${total}`)
          },
        },
      )

      // Validate before storing: a half-valid pack in the store would fail on
      // every later load instead of once, here, with a reason.
      const built = materialize(raw)

      await engine.set(packKey(code), raw)

      try {
        await engine.set(PACKS_KEY, [...new Set([...known.codes, code])])
      } catch (error) {
        // The pack is written but invisible: say so, rather than reporting a
        // failure for something that is sitting in the store.
        note('pack', { text: `the ${code} pack is saved but not listed: ${messageOf(error)}` })

        return (
          `Built **${built.englishName}** (${built.words.length} words) but could not add it ` +
          `to your list of packs, so it will not appear in \`/${COMMAND_NAME} lang\`. ` +
          `Re-run to try again.`
        )
      }

      note('pack', null)

      // The generator's own last note already explains itself; quoting it under
      // a heading that repeats it reads as a stutter.
      const short =
        built.words.length < PACK_WORDS
          ? `\n\nAsked for ${PACK_WORDS}, ${
              notes.at(-1) ?? `stopped at ${built.words.length}: the ranks asked for are used up`
            }. A short pack of real words beats a full one padded out.`
          : ''

      return (
        `Built **${built.englishName}** as \`${code}\` — ${built.words.length} words.${short}\n\n` +
        `\`/${COMMAND_NAME} lang ${code}\` to start on it.`
      )
    } catch (error) {
      return `Could not build a ${language} pack: ${messageOf(error)}`
    } finally {
      engine.status(troubleText() ?? undefined)
    }
  }

  async function resetText(engine: Host): Promise<string> {
    if (!pack) return 'Nothing to reset yet.'

    const name = pack.englishName

    const answer = await engine
      .ask(`Erase your ${name} progress? This cannot be undone.`, ['Keep it', 'Erase it'])
      .catch(() => 'Keep it')

    if (answer !== 'Erase it') return `Kept your ${name} deck.`

    if (readOnly) {
      // The dialog said "this cannot be undone", and under read-only nothing is
      // written at all: the stored deck would come back at the next session.
      return (
        `Did **not** erase your ${name} deck: it could not be read, so the mod is ` +
        `running read-only and writes nothing. Nothing has changed.`
      )
    }

    progress = emptyProgress(pack.code)
    state = { ...state, card: null, verdict: null, hook: null, fetchingHook: false, typed: '' }
    hookToken += 1

    const trouble = await saveProgress(engine, progress)

    note('save', trouble)
    engine.invalidate()

    if (trouble) return `Could not erase your ${name} deck: ${trouble.text}`

    return `Erased your ${name} deck. Everything starts again from word one.`
  }
}

export const PLUGIN = PLUGIN_NAME
