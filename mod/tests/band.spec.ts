import { describe, expect, it } from 'vitest'

import { BAND_MIN_COLUMNS, OWL_MIN_COLUMNS, answerKey, KEYS } from '../hooks/names'
import { materialize } from '../hooks/pack'
import { BUNDLED } from '../hooks/packs'
import { buildCard, emptyProgress, makeRng } from '../hooks/srs'
import { tickAt } from '../hooks/ticker'
import type { ItemProgress, Pack } from '../hooks/types'
import { bandView } from '../hooks/views/band'
import type { BandActions, BandModel, BandUi } from '../hooks/views/band'

/**
 * The band, checked where it can be checked.
 *
 * Its whole reason for existing is that a digit presses a Button, and nothing
 * on this side of the engine can press one. What *can* be checked is the tree
 * handed over: that the options are Buttons, that they carry the digits, that
 * pressing one reaches the action, and that the thing is the height it has
 * promised to be. Those are the properties that break silently.
 *
 * The height in particular is load-bearing twice over: three rows is what keeps
 * the conversation above from jumping, and a band taller than the rows it is
 * given "arms none of its Buttons' hotkeys" — so a fourth row would not look
 * wrong, it would quietly turn every answer key off.
 */

/** A stand-in element table: the constructors record what they were given. */
interface Node {
  type: string
  props: Record<string, unknown>
  children: Node[]
}

function fakeUi(): BandUi {
  const make =
    (type: string) =>
    (props: Record<string, unknown>): Node => {
      const { children = [], ...rest } = props

      return { type, props: rest, children: (children as Node[]).filter((c) => typeof c === 'object') }
    }

  return {
    Box: make('Box'),
    Text: make('Text'),
    Button: make('Button'),
    Input: make('Input'),
  } as unknown as BandUi
}

function noActions(): BandActions & { pressed: string[] } {
  const pressed: string[] = []

  return {
    pressed,
    answer: (index) => pressed.push(`answer:${index}`),
    spell: (text) => pressed.push(`spell:${text}`),
    type: (text) => pressed.push(`type:${text}`),
    next: () => pressed.push('next'),
    skip: () => pressed.push('skip'),
    explain: () => pressed.push('explain'),
    practise: () => pressed.push('practise'),
    chooseLang: (code) => pressed.push(`lang:${code}`),
  }
}

const SPANISH: Pack = materialize(BUNDLED[0]!)

function model(over: Partial<BandModel> = {}): BandModel {
  const progress = emptyProgress('es')

  return {
    pack: SPANISH,
    tick: tickAt(SPANISH, progress, 0),
    card: null,
    item: undefined,
    verdict: null,
    hook: null,
    fetchingHook: false,
    typed: '',
    streak: 0,
    isWorking: true,
    practising: false,
    choices: null,
    trouble: null,
    enrich: true,
    now: 0,
    ...over,
  }
}

const reviewing = (box: number): ItemProgress => ({
  id: 'es:1',
  stage: 'review',
  box,
  step: 0,
  due: 0,
  lastSeen: 0,
  seen: 3,
  correct: 2,
  lapses: 0,
})

/** Every node in the tree, depth first. */
function walk(node: Node): Node[] {
  return [node, ...node.children.flatMap(walk)]
}

function draw(over: Partial<BandModel> = {}, columns = 80) {
  const actions = noActions()
  const tree = bandView({ ui: fakeUi(), actions, columns }, model(over)) as unknown as Node

  return { tree, actions, nodes: walk(tree) }
}

const buttons = (nodes: Node[]) => nodes.filter((node) => node.type === 'Button')

/**
 * The rows of the band: the children of the column that holds the body.
 *
 * With a gutter the body is the second column of a row; without one the band
 * *is* the body.
 */
function bodyRows(tree: Node): Node[] {
  if (tree.props.flexDirection === 'column') return tree.children

  const body = tree.children[tree.children.length - 1]

  return body?.children ?? []
}

/** The card Spanish word #1 is asked with at a given box. */
function cardAt(box: number) {
  const word = SPANISH.words[0]!

  return buildCard(SPANISH, word, reviewing(box), makeRng(1))
}

/** The introduction a word gets before it is ever asked about. */
function teachCard() {
  return buildCard(SPANISH, SPANISH.words[0]!, null, makeRng(1))
}

describe('band', () => {
  it('asks a multiple-choice card with one digit per option', () => {
    const card = cardAt(1)
    const { nodes } = draw({ card, item: reviewing(1) })

    expect(card.choices).toHaveLength(4)

    const options = buttons(nodes).filter((b) => String(b.props.key).startsWith('answer:'))

    expect(options.map((b) => b.props.key)).toEqual([0, 1, 2, 3].map(answerKey))
    expect(options.map((b) => b.props.hotkey)).toEqual(['1', '2', '3', '4'])
  })

  it('reaches the answer action when an option is pressed', () => {
    const { nodes, actions } = draw({ card: cardAt(1), item: reviewing(1) })

    const second = buttons(nodes).find((b) => b.props.key === answerKey(1))

    expect(second).toBeDefined()
    ;(second!.props.onPress as () => void)()

    expect(actions.pressed).toEqual(['answer:1'])
  })

  /**
   * The height is the promise. Every branch, one assertion.
   *
   * Break it on purpose — add a row to any branch of `rowsOf` — and this is
   * what notices.
   */
  it.each([
    ['the picker', { choices: [{ code: 'es', englishName: 'Spanish', words: 312 }] }],
    ['a teach card', { card: teachCard() }],
    ['a multiple-choice card', { card: cardAt(1), item: reviewing(1) }],
    ['a spelling card', { card: cardAt(5), item: reviewing(5) }],
    ['a verdict', { verdict: { correct: true, answer: 'the', word: SPANISH.words[0]! } }],
    ['the idle ticker', {}],
    ['trouble', { trouble: 'the store is unreachable' }],
  ])('is exactly three rows: %s', (_name, over) => {
    const { tree } = draw(over as Partial<BandModel>)

    expect(bodyRows(tree)).toHaveLength(3)
  })

  it('shows trouble in the third row rather than a fourth', () => {
    const quiet = draw({})
    const loud = draw({ trouble: 'the store is unreachable' })

    expect(bodyRows(loud.tree)).toHaveLength(3)
    expect(bodyRows(loud.tree).at(-1)?.props.color).toBe('error')

    // It took the row the controls were in; the two above are untouched.
    expect(bodyRows(loud.tree).slice(0, 2)).toEqual(bodyRows(quiet.tree).slice(0, 2))
    expect(bodyRows(quiet.tree).at(-1)?.props.color).toBeUndefined()
  })

  it('drops the owl below the width that fits it, keeping the three rows', () => {
    const wide = draw({}, OWL_MIN_COLUMNS)
    const narrow = draw({}, OWL_MIN_COLUMNS - 1)

    expect(wide.tree.props.flexDirection).toBe('row')
    expect(narrow.tree.props.flexDirection).toBe('column')
    expect(bodyRows(narrow.tree)).toHaveLength(3)
  })

  it('falls back to one row when three cannot say anything useful', () => {
    const { tree } = draw({}, BAND_MIN_COLUMNS - 1)

    expect(bodyRows(tree)).toHaveLength(1)
  })

  it('offers a teach card an acknowledgement, not options', () => {
    const { nodes } = draw({ card: teachCard() })
    const keys = buttons(nodes).map((b) => b.props.key)

    expect(keys).toContain(KEYS.next)
    expect(keys).toContain(KEYS.skip)
    expect(keys.some((key) => String(key).startsWith('answer:'))).toBe(false)
  })

  it('takes a spelling card on an Input, not on buttons', () => {
    const { nodes, actions } = draw({ card: cardAt(5), item: reviewing(5) })
    const input = nodes.find((node) => node.type === 'Input')

    expect(input?.props.key).toBe(KEYS.spell)
    ;(input!.props.onSubmit as (v: string) => void)('el')

    expect(actions.pressed).toEqual(['spell:el'])
  })

  it('gives the picker one digit per language', () => {
    const choices = [
      { code: 'es', englishName: 'Spanish', words: 312 },
      { code: 'fr', englishName: 'French', words: 311 },
      { code: 'it', englishName: 'Italian', words: 310 },
    ]

    const { nodes, actions } = draw({ choices })
    const picks = buttons(nodes).filter((b) => String(b.props.key).startsWith('lang:'))

    expect(picks.map((b) => b.props.hotkey)).toEqual(['1', '2', '3'])
    ;(picks[1]!.props.onPress as () => void)()

    expect(actions.pressed).toEqual(['lang:fr'])
  })

  /**
   * The options share the row, so four long glosses shorten together.
   *
   * Measured in columns rather than code points, because a generated CJK pack
   * would otherwise be budgeted at half the space it takes.
   */
  it('shortens every option to fit the row rather than losing the last', () => {
    const card = cardAt(1)

    const long = {
      ...card,
      choices: card.choices.map(() => 'a gloss far longer than any row could hold'),
    }

    const { nodes } = draw({ card: long, item: reviewing(1) }, 60)
    const labels = buttons(nodes)
      .filter((b) => String(b.props.key).startsWith('answer:'))
      .map((b) => String(b.props.label))

    expect(labels).toHaveLength(4)
    expect(labels.every((label) => label.endsWith('…'))).toBe(true)
    expect(new Set(labels.map((label) => label.length)).size).toBe(1)
  })

  it('hides the explain key when enrichment is off', () => {
    const on = draw({ card: cardAt(1), item: reviewing(1), enrich: true })
    const off = draw({ card: cardAt(1), item: reviewing(1), enrich: false })

    expect(buttons(on.nodes).map((b) => b.props.key)).toContain(KEYS.explain)
    expect(buttons(off.nodes).map((b) => b.props.key)).not.toContain(KEYS.explain)
  })
})
