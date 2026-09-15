import { describe, expect, it } from 'vitest'

import { BAND_MIN_COLUMNS, OWL_MIN_COLUMNS, answerKey, KEYS } from '../hooks/names'
import { MASCOT_WIDTH } from '../hooks/ui/mascot'
import { stringWidth } from '../hooks/ui/width'
import { GAP, buttonOverhead } from '../hooks/views/row'
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

/**
 * A stand-in element table: the constructors record what they were given.
 *
 * Children keep their strings. An earlier version of this harness filtered them
 * out as "not elements", which quietly made every width assertion below
 * unfalsifiable — every `Text` measured zero cells, so no row could ever be too
 * wide. A test that cannot fail is worse than no test, so `kids` separates the
 * elements for walking without ever discarding the text.
 */
interface Node {
  type: string
  props: Record<string, unknown>
  /** Everything passed as children, strings included. */
  children: (Node | string)[]
}

/** The element children, for walking the tree. */
const kids = (node: Node): Node[] =>
  node.children.filter((child): child is Node => typeof child === 'object' && child !== null)

function fakeUi(): BandUi {
  const make =
    (type: string) =>
    (props: Record<string, unknown>): Node => {
      const { children = [], ...rest } = props

      return { type, props: rest, children: children as (Node | string)[] }
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

/** Every element in the tree, depth first. */
function walk(node: Node): Node[] {
  return [node, ...kids(node).flatMap(walk)]
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
  if (tree.props.flexDirection === 'column') return kids(tree)

  const body = kids(tree).at(-1)

  return body ? kids(body) : []
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
    ['nothing due', { tick: { word: null, revealed: false, learned: 0, total: 0, rank: 0 } }],
  ])('is exactly three rows: %s', (_name, over) => {
    const { tree } = draw(over as Partial<BandModel>)

    expect(bodyRows(tree)).toHaveLength(3)
  })


  it('drops the owl below the width that fits it, keeping the three rows', () => {
    const wide = draw({}, OWL_MIN_COLUMNS)
    const narrow = draw({}, OWL_MIN_COLUMNS - 1)

    expect(wide.tree.props.flexDirection).toBe('row')
    expect(narrow.tree.props.flexDirection).toBe('column')
    expect(bodyRows(narrow.tree)).toHaveLength(3)
  })

  /**
   * Narrow, it keeps the row that can be pressed rather than the one that
   * merely reads: a question nobody can answer is worth less than the keys.
   */
  it('falls back to the controls row when three cannot say anything useful', () => {
    const { tree, nodes } = draw({ card: cardAt(1), item: reviewing(1) }, BAND_MIN_COLUMNS - 1)

    expect(bodyRows(tree)).toHaveLength(1)
    expect(buttons(nodes).length).toBeGreaterThan(0)
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

    // They shorten together rather than the last falling off the end. Not
    // identical: the leftover cells are handed out one at a time, so two
    // labels may differ by one — spending every cell beats a tidy split.
    const widths = labels.map((label) => stringWidth(label))

    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
  })

  it('hides the explain key when enrichment is off', () => {
    const on = draw({ card: cardAt(1), item: reviewing(1), enrich: true })
    const off = draw({ card: cardAt(1), item: reviewing(1), enrich: false })

    expect(buttons(on.nodes).map((b) => b.props.key)).toContain(KEYS.explain)
    expect(buttons(off.nodes).map((b) => b.props.key)).not.toContain(KEYS.explain)
  })
})

/**
 * The height, measured in cells rather than in children.
 *
 * The first version of this file counted the children of the body Box and was
 * satisfied by three. That is not the invariant. `Text` wraps by default, so a
 * row whose parts each fit the body width but which together exceed it is one
 * child and two rows on screen — and the band becomes four rows while every
 * assertion above still passes. It shipped exactly that bug: the default idle
 * band overflowed at several ordinary terminal widths.
 *
 * So this measures what the surface will measure. A row of parts costs the sum
 * of their rendered widths plus two cells per gap, and a plain Button costs its
 * hotkey, a colon and a space on top of its label.
 */

/** What one rendered row costs, in terminal cells. */
function rowCells(row: Node): number {
  if (row.type === 'Text') return stringWidth(textOf(row))

  // An Input is drawn by the surface and sized by it; nothing here can widen it.
  if (row.type === 'Input') return 0

  if (row.type === 'Button') {
    return buttonOverhead(row.props.hotkey as string | undefined) + stringWidth(String(row.props.label ?? ''))
  }

  const children = kids(row).filter((child) => child.type !== 'Input')
  const gaps = row.props.gap === undefined ? 0 : Number(row.props.gap) * Math.max(0, children.length - 1)

  return children.reduce((sum, child) => sum + rowCells(child), 0) + gaps
}

/** The text a Text node draws, nested Texts included. */
function textOf(node: Node): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('')
}

describe('band height, in cells', () => {
  const states: [string, Partial<BandModel>][] = [
    ['the picker', { choices: [
      { code: 'es', englishName: 'Spanish', words: 312 },
      { code: 'fr', englishName: 'French', words: 311 },
      { code: 'it', englishName: 'Italian', words: 310 },
    ] }],
    ['a teach card', { card: teachCard() }],
    ['a multiple-choice card', { card: cardAt(1), item: reviewing(1) }],
    ['a spelling card', { card: cardAt(5), item: reviewing(5) }],
    ['a correct verdict', { verdict: { correct: true, answer: 'the', word: SPANISH.words[0]! } }],
    ['a wrong verdict', { verdict: { correct: false, answer: 'the', word: SPANISH.words[0]! } }],
    ['the idle ticker', {}],
    ['the ticker revealed', { tick: { ...tickAt(SPANISH, emptyProgress('es'), 0), revealed: true } }],
    ['nothing due', { tick: { word: null, revealed: false, learned: 0, total: 0, rank: 0 } }],
  ]

  /**
   * Every width from the narrowest the band draws at up to a wide terminal,
   * and both sides of the gutter threshold — the original overflow appeared at
   * exactly 46, where the owl takes eight and leaves thirty-eight.
   */
  const widths = [BAND_MIN_COLUMNS, 32, 36, 40, 45, OWL_MIN_COLUMNS, 47, 52, 60, 80, 100, 120]

  it.each(states)('never overflows its width: %s', (_name, over) => {
    for (const columns of widths) {
      const { tree } = draw(over, columns)
      const body = columns >= OWL_MIN_COLUMNS ? columns - MASCOT_WIDTH - GAP : columns

      for (const row of bodyRows(tree)) {
        expect(
          rowCells(row),
          `${_name} at ${columns} columns (body ${body}): row too wide, so it wraps and the band becomes four rows`,
        ).toBeLessThanOrEqual(body)
      }
    }
  })

  /**
   * A generated pack can hold a word far longer than anything bundled, and the
   * band must not grow a row because a model was verbose.
   */
  it('survives a pack with absurdly long entries', () => {
    const word = {
      ...SPANISH.words[0]!,
      term: 'a'.repeat(120),
      gloss: 'b'.repeat(200),
    }

    const long = { ...SPANISH, words: [word, ...SPANISH.words.slice(1)] }

    const cases: Partial<BandModel>[] = [
      { pack: long, card: buildCard(long, word, null, makeRng(1)) },
      { pack: long, card: buildCard(long, word, reviewing(1), makeRng(1)), item: reviewing(1) },
      { pack: long, tick: tickAt(long, emptyProgress('es'), 4000) },
      { pack: long, verdict: { correct: false, answer: word.gloss, word } },
    ]

    for (const over of cases) {
      for (const columns of widths) {
        const { tree } = draw(over, columns)
        const body = columns >= OWL_MIN_COLUMNS ? columns - MASCOT_WIDTH - GAP : columns

        expect(bodyRows(tree).length).toBeLessThanOrEqual(3)

        for (const row of bodyRows(tree)) {
          expect(rowCells(row), `${columns} columns`).toBeLessThanOrEqual(body)
        }
      }
    }
  })

  /** CJK glyphs take two cells each; budgeting by code point halves the row. */
  it('budgets a double-width pack in columns, not code points', () => {
    const word = { ...SPANISH.words[0]!, term: '日本語'.repeat(8), gloss: '言葉'.repeat(12) }
    const wide = { ...SPANISH, words: [word, ...SPANISH.words.slice(1)] }

    for (const columns of widths) {
      const { tree } = draw({ pack: wide, tick: tickAt(wide, emptyProgress('es'), 4000) }, columns)
      const body = columns >= OWL_MIN_COLUMNS ? columns - MASCOT_WIDTH - GAP : columns

      for (const row of bodyRows(tree)) {
        expect(rowCells(row), `${columns} columns`).toBeLessThanOrEqual(body)
      }
    }
  })
})
