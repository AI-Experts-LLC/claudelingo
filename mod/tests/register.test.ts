import type { Args, RenderPropsOf } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { COMMAND_NAME, PLUGIN_NAME, SETTINGS_KEY, answerKey, KEYS, progressKey } from '../hooks/names'

tier('user')

/**
 * The band, driven the way a person drives it.
 *
 * These are the tests the specs beside them cannot be: `$.ui.press` presses a
 * Button the band actually rendered, through every hook, and the deck that
 * comes out the other side is the one the engine's own store holds. The specs
 * check the tree; these check that pressing it does something.
 *
 * Run with `claude plugin test mod`.
 */

const SESSION: Args<'session.start'> = {
  cwd: '/work',
  surface: 'terminal',
  isInteractive: true,
}

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

/** The band's own render argument, as the engine raises it. */
const band = (props: Partial<RenderPropsOf['AbovePrompt']> = {}): Args<'ui.render'> => ({
  surface: 'terminal',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 100, rows: 40 },
  props: { ...BAND_PROPS, ...props },
})

/** Running a slash command the way the composer does. */
const running = (args: string): Args<'command.run'> => ({
  command: COMMAND_NAME,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 100 },
})

/** A session already studying Spanish, with a clock and a store beneath. */
function studying(on: Parameters<typeof mock.clock>[0], entries: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })

  mock.store(on, {
    [SETTINGS_KEY]: { lang: 'es', maxLearning: 8, newPerDay: 20, on: true, enrich: true },
    ...entries,
  })

  return clock
}

/** Every Button key in a rendered tree, in the order they were drawn. */
function keysOf(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) keysOf(child, found)

    return found
  }

  if (typeof node !== 'object' || node === null) return found

  const element = node as { type?: string; props?: Record<string, unknown> }

  if (element.type === 'Button' && typeof element.props?.key === 'string') {
    found.push(element.props.key)
  }

  keysOf(element.props?.children, found)

  return found
}

describe('register', () => {
  test('registers /lingo when the session starts', async ($, on) => {
    const registered: string[] = []

    studying(on)

    on('command.register', ($, e, next) => {
      registered.push(e.name)

      return next(e)
    })

    await $.session.start(SESSION)

    expect(registered).toContain(COMMAND_NAME)
  })

  /**
   * Nothing chosen yet is the first thing anyone sees, and it has to be
   * answerable from the band rather than from a command.
   */
  test('offers the languages as buttons before one is chosen', async ($, on) => {
    mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)

    const tree = await $.ui.render(band())

    expect(keysOf(tree)).toEqual(['lang:es', 'lang:fr', 'lang:it'])
  })

  test('choosing a language from the band sticks', async ($, on) => {
    mock.clock(on)
    mock.store(on)

    await $.session.start(SESSION)
    await $.ui.render(band())

    await $.ui.press({ plugin: PLUGIN_NAME, key: 'lang:fr' })

    const { text } = await $.command.run(running('stats'))

    expect(text).toContain('French')
  })

  /**
   * The whole point, in one test: a digit answers a card.
   *
   * `$.ui.press` is the terminal pressing the Button, as a click or its hotkey
   * does. Break the band's hotkeys and the tree still renders; break this and
   * the mod has no reason to exist.
   */
  test('answering a card with a button moves the deck on', async ($, on) => {
    studying(on)

    await $.session.start(SESSION)
    await $.ui.render(band())

    // The first card for an untouched deck is an introduction, acknowledged
    // rather than answered; that is what schedules the word.
    expect(keysOf(await $.ui.render(band()))).toContain(KEYS.next)

    await $.ui.press({ plugin: PLUGIN_NAME, key: KEYS.next })

    const { text } = await $.command.run(running('stats'))

    expect(text).toContain('words met    1')
  })

  test('a multiple-choice card carries one answer button per option', async ($, on) => {
    const now = 1_700_000_000_000

    studying(on, {
      // A word already past its introduction and due: the band asks it.
      [progressKey('es')]: {
        version: 1,
        lang: 'es',
        items: {
          'es:1': {
            id: 'es:1',
            stage: 'learning',
            box: 1,
            step: 0,
            due: now - 1000,
            lastSeen: now - 60_000,
            seen: 1,
            correct: 1,
            lapses: 0,
          },
        },
        streak: 0,
        bestStreak: 0,
        totalAnswered: 1,
        totalCorrect: 1,
        introducedByDay: {},
      },
    })

    await $.session.start(SESSION)

    const keys = keysOf(await $.ui.render(band()))

    expect(keys).toContain(answerKey(0))
    expect(keys).toContain(answerKey(3))
    expect(keys).toContain(KEYS.skip)
  })

  /**
   * Idle means no card. This is the one behaviour the CLI needs five hook
   * events, a status file and a Codex transcript watcher to get right.
   */
  test('draws no card while no turn is running', async ($, on) => {
    studying(on)

    await $.session.start(SESSION)

    const idle = keysOf(await $.ui.render(band({ isWorking: false })))

    expect(idle).toEqual([KEYS.practise])
  })

  test('practise asks anyway, and a new prompt ends it', async ($, on) => {
    studying(on)

    await $.session.start(SESSION)

    const idle = band({ isWorking: false })

    await $.ui.render(idle)
    await $.ui.press({ plugin: PLUGIN_NAME, key: KEYS.practise })

    expect(keysOf(await $.ui.render(idle))).toContain(KEYS.next)

    await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } })

    expect(keysOf(await $.ui.render(idle))).toEqual([KEYS.practise])
  })

  /**
   * A band taller than the rows it is given arms none of its hotkeys, so it
   * draws nothing rather than something that cannot be answered.
   */
  test('stands aside where it has no room to be pressable', async ($, on) => {
    studying(on)

    await $.session.start(SESSION)

    const cramped = band({ maxRows: 2 })

    expect(keysOf(await $.ui.render(cramped))).toEqual([])
  })

  test('yields the band to a survey', async ($, on) => {
    studying(on)

    await $.session.start(SESSION)

    const survey = band({ hasSurvey: true })

    expect(keysOf(await $.ui.render(survey))).toEqual([])
  })

  test('/lingo off clears the band, /lingo on brings it back', async ($, on) => {
    studying(on)

    await $.session.start(SESSION)

    await $.command.run(running('off'))

    expect(keysOf(await $.ui.render(band()))).toEqual([])

    await $.command.run(running('on'))

    expect(keysOf(await $.ui.render(band())).length).toBeGreaterThan(0)
  })

  test('refuses to build a pack over a language it already ships', async ($, on) => {
    studying(on)

    await $.session.start(SESSION)

    const { text } = await $.command.run(running('pack Espanol'))

    expect(text).toContain('already ships')
  })
})
