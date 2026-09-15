/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  InputProps,
  RenderElement,
  TextProps,
} from 'claude-code'

import {
  BAND_MIN_COLUMNS,
  CONTROL_HOTKEYS,
  KEYS,
  OWL_MIN_COLUMNS,
  answerKey,
  langKey,
} from '../names'
import { MASCOT_WIDTH, owl, remark } from '../ui/mascot'
import type { Mood } from '../ui/mascot'
import { MAX_BOX } from '../srs'
import { bar } from '../ticker'
import type { Tick } from '../ticker'
import type { Card, ItemProgress, Pack, Verdict } from '../types'
import type { PackChoice } from '../pack'
import { buttonOverhead, fit, fitRow } from './row'
import type { Part } from './row'

/**
 * The band above the prompt: three rows, and every one of them pressable.
 *
 * This is the whole reason the mod exists. The CLI draws the same three rows as
 * a status line, and its README is honest about the ceiling that puts on it:
 * "Claude Code draws its own terminal UI and does not host third-party widgets,
 * so there is no way to put an interactive box inside it", and so "because it
 * cannot take input, the bottom row is always the controls" — a row naming the
 * slash commands you must type to reach the thing on screen. `/lingo 2` to
 * answer a question you are already looking at.
 *
 * Here the options are `Button`s. A bare digit in an empty composer presses
 * one. The third row stops being a list of commands to type and becomes what
 * the pane's bottom row always was: the keys that work right now.
 *
 * Three rules hold the layout together:
 *
 * - **Exactly three rows**, always, so the conversation above never jumps as a
 *   card comes and goes — and measured in *rendered cells*, not in children.
 *   `Text` wraps by default, so a row of parts that each fit the body width but
 *   together exceed it is two rows on screen while still being one child in the
 *   tree. Every composite row goes through `fitRow`, which budgets it as a row.
 * - **Never taller than `maxRows`.** A band that overflows scrolls in a window
 *   and — the part that would be fatal — "a bare digit arms none of its
 *   Buttons' hotkeys". An overflowing band is a band you cannot answer, which
 *   is why the budgeting above is a correctness rule and not a cosmetic one.
 * - **The controls row is never given up.** Whatever else is happening, the
 *   keys that work stay on screen. Errors do not live here at all: they are
 *   pinned under the prompt with `$.ui.status`, the engine's own affordance for
 *   exactly that, which costs the band no rows and cannot be truncated away.
 */

/**
 * The elements this view draws with, as `$.ui.resolve(e)` hands them over.
 *
 * Named rather than picked off `Elements['terminal']` because the same four are
 * on `desktop`, and the band is worth drawing there too. `mobile` has no
 * `Input`, so it has no `recall` card — `isDrawable` in `register.ts` keeps the
 * band off it rather than letting one card kind fail to build a tree.
 */
export type BandUi = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input: ElementConstructor<InputProps>
}

/** What a press does. The view names them; `register.ts` supplies them. */
export interface BandActions {
  answer: (index: number) => void
  spell: (text: string) => void
  type: (text: string) => void
  next: () => void
  skip: () => void
  explain: () => void
  practise: () => void
  chooseLang: (code: string) => void
}

export interface BandModel {
  pack: Pack | null
  tick: Tick | null
  card: Card | null
  item: ItemProgress | undefined
  verdict: Verdict | null
  hook: string | null
  fetchingHook: boolean
  typed: string
  streak: number
  /** A turn is running: the band may quiz. */
  isWorking: boolean
  /** Quizzing regardless, because practise was pressed or always-on is set. */
  practising: boolean
  /** The languages the picker offers, when nothing has been chosen yet. */
  choices: readonly PackChoice[] | null
  /** Can the model be asked for a memory hook? */
  enrich: boolean
  /**
   * The time, as `$.clock.now()` gave it.
   *
   * Passed in rather than read here: the clock is an event through the host, so
   * a test can hold it still, and a render hook that read the wall clock itself
   * would draw a different owl on two draws of the same moment.
   */
  now: number
}

export interface BandKit {
  ui: BandUi
  actions: BandActions
  /** Cells across the band (`props.bodyColumns`, not the viewport's). */
  columns: number
}

/** One control in the third row: a Button, and what pressing it does. */
interface Control {
  key: string
  hotkey: string
  part: Part
  onPress: () => void
}

/**
 * The owl's mood, from what is on screen.
 *
 * It is the one piece of the CLI's character that survives unchanged, because
 * it was never about the surface: asleep while Claude is idle, watching while a
 * card is up, pleased when you get one right, startled when you do not.
 */
function moodOf(model: BandModel): Mood {
  if (model.verdict) return model.verdict.correct ? (model.streak >= 5 ? 'proud' : 'happy') : 'oops'
  if (model.card) return 'watching'
  if (model.choices) return 'asking'
  if (!model.isWorking && !model.practising) return 'asleep'

  return model.tick?.revealed ? 'happy' : 'watching'
}

/** The three body rows for one draw, before the gutter goes beside them. */
function rowsOf(kit: BandKit, model: BandModel, columns: number): RenderElement[] {
  const { Text, Box, Button, Input } = kit.ui
  const { actions } = kit

  /** A row on its own: one Text, fitted to the width and never wrapped. */
  const line = (text: string, props: Record<string, unknown> = {}) => (
    <Text wrap="truncate-end" {...props}>
      {fit(text, columns)}
    </Text>
  )

  const dim = (text: string) => line(text, { dimColor: true })

  const named = (hotkey: string, label: string): Part => ({
    label,
    overhead: buttonOverhead(hotkey),
  })

  /**
   * The controls row, budgeted as a row.
   *
   * `notes` are dim asides — a box level, the commands that do what the band
   * cannot — and they shrink first. The buttons keep their names whole, because
   * a control whose label has been eaten is a control nobody can find.
   */
  const controls = (buttons: Control[], notes: string[] = []) => {
    const parts: Part[] = [
      ...buttons.map((button) => ({ ...button.part, fixed: true })),
      ...notes.map((label) => ({ label })),
    ]

    const labels = fitRow(parts, columns)

    return (
      <Box flexDirection="row" gap={2}>
        {buttons.map((button, index) => (
          <Button
            key={button.key}
            hotkey={button.hotkey}
            plain
            dimColor={button.key !== KEYS.next}
            label={labels[index] ?? button.part.label}
            onPress={button.onPress}
          />
        ))}
        {notes.map((_note, index) => (
          <Text dimColor wrap="truncate-end">
            {labels[buttons.length + index] ?? ''}
          </Text>
        ))}
      </Box>
    )
  }

  const skipButton: Control = {
    key: KEYS.skip,
    hotkey: CONTROL_HOTKEYS.skip,
    part: named(CONTROL_HOTKEYS.skip, 'skip'),
    onPress: actions.skip,
  }

  const explainButton: Control = {
    key: KEYS.explain,
    hotkey: CONTROL_HOTKEYS.explain,
    part: named(CONTROL_HOTKEYS.explain, model.fetchingHook ? 'asking…' : 'explain'),
    onPress: actions.explain,
  }

  /** Explain is only offered where the model may actually be asked. */
  const withExplain = (buttons: Control[]): Control[] =>
    model.enrich ? [...buttons, explainButton] : buttons

  // ── Nothing chosen yet ───────────────────────────────────────────────────
  //
  // The CLI asks this in a pane, over three screens. Here it is one row of
  // buttons, and the answer is one digit.
  if (model.choices) {
    const offered = model.choices.slice(0, 4)

    const labels = fitRow(
      offered.map((choice, index) => ({
        label: choice.englishName,
        overhead: buttonOverhead(String(index + 1)),
      })),
      columns,
    )

    return [
      line('Which language do you want to learn?', { bold: true }),
      <Box flexDirection="row" gap={2}>
        {offered.map((choice, index) => (
          <Button
            key={langKey(choice.code)}
            hotkey={String(index + 1)}
            plain
            label={labels[index] ?? choice.englishName}
            onPress={() => actions.chooseLang(choice.code)}
          />
        ))}
      </Box>,
      dim('press a digit · /lingo lang <code> for any other'),
    ]
  }

  // ── Just answered ────────────────────────────────────────────────────────
  if (model.verdict) {
    const { correct, answer, word } = model.verdict

    const said = correct
      ? `correct — ${word.term} = ${word.gloss}`
      : `not quite — ${word.term} = ${answer}`

    const aside =
      model.hook || remark(moodOf(model), model.streak) || word.note || word.example?.text || ''

    return [
      line(said, { bold: true, color: correct ? 'success' : 'error' }),
      dim(aside),
      controls(
        withExplain([
          {
            key: KEYS.next,
            hotkey: CONTROL_HOTKEYS.next,
            part: named(CONTROL_HOTKEYS.next, 'next'),
            onPress: actions.next,
          },
        ]),
      ),
    ]
  }

  // ── A card is up ─────────────────────────────────────────────────────────
  if (model.card && model.pack) {
    const card = model.card
    const pack = model.pack
    const box = model.item ? `box ${model.item.box}/${MAX_BOX}` : 'new'

    if (card.kind === 'teach') {
      // Term and rank share the first row, and both are budgeted: a generated
      // pack can hold a term far longer than anything the bundled ones do.
      const [term = '', rank = ''] = fitRow(
        [{ label: card.word.term }, { label: `#${card.word.rank}`, fixed: true }],
        columns,
      )

      const note = card.word.note ? ` (${card.word.note})` : ''

      return [
        <Box flexDirection="row" gap={2}>
          <Text bold color="suggestion" wrap="truncate-end">
            {term}
          </Text>
          <Text dimColor wrap="truncate-end">
            {rank}
          </Text>
        </Box>,
        line(`${card.word.gloss}  ${card.word.pos}${note}`),
        controls(
          withExplain([
            {
              key: KEYS.next,
              hotkey: CONTROL_HOTKEYS.next,
              part: named(CONTROL_HOTKEYS.next, 'got it'),
              onPress: actions.next,
            },
            skipButton,
          ]),
        ),
      ]
    }

    if (card.kind === 'recall') {
      return [
        line(`Spell the ${pack.englishName} for "${card.prompt}"`, { bold: true }),
        <Input
          key={KEYS.spell}
          placeholder="type it, then Enter"
          value={model.typed}
          submitLabel="answer"
          onInput={actions.type}
          onSubmit={actions.spell}
        />,
        controls(withExplain([skipButton]), [box]),
      ]
    }

    // recognize / reverse / cloze: four options, one digit each, sharing the
    // row — so four long glosses shorten together rather than the fourth
    // falling off the end and taking the band's height with it.
    const labels = fitRow(
      card.choices.map((choice, index) => ({
        label: choice,
        overhead: buttonOverhead(String(index + 1)),
      })),
      columns,
    )

    return [
      line(questionRow(card, pack.englishName), { bold: true }),
      <Box flexDirection="row" gap={2}>
        {card.choices.map((choice, index) => (
          <Button
            key={answerKey(index)}
            hotkey={String(index + 1)}
            plain
            label={labels[index] ?? choice}
            onPress={() => actions.answer(index)}
          />
        ))}
      </Box>,
      controls(withExplain([skipButton]), [box]),
    ]
  }

  // ── Caught up, or standing down ──────────────────────────────────────────
  //
  // The ticker, exactly as the CLI's panel runs it: a word alone, a moment to
  // reach for it, then the meaning. Nothing here is graded and nothing written.
  const practiseButton: Control = {
    key: KEYS.practise,
    hotkey: CONTROL_HOTKEYS.practise,
    part: named(CONTROL_HOTKEYS.practise, 'practise'),
    onPress: actions.practise,
  }

  const tick = model.tick

  if (!tick?.word) {
    return [
      line(model.pack ? `${model.pack.englishName} · all caught up` : 'claudelingo'),
      dim(`${bar(1, 10)}  nothing due`),
      controls([practiseButton], ['/lingo stats']),
    ]
  }

  const counts = `${tick.learned}/${tick.total}${model.streak > 0 ? ` · streak ${model.streak}` : ''}`

  // `«term» = gloss` is one row of three parts. The separator is fixed and
  // carries its own cells, so the two words share exactly what is left.
  const [term = '', , gloss = ''] = fitRow(
    [
      { label: `«${tick.word.term}»` },
      { label: ' = ', fixed: true, overhead: -4 },
      { label: tick.revealed ? tick.word.gloss : '?' },
    ],
    columns,
  )

  return [
    <Box flexDirection="row">
      <Text color="suggestion" wrap="truncate-end">
        {term}
      </Text>
      <Text dimColor>{' = '}</Text>
      <Text bold={tick.revealed} dimColor={!tick.revealed} wrap="truncate-end">
        {gloss}
      </Text>
    </Box>,
    dim(`${bar(tick.total ? tick.learned / tick.total : 0, 10)}  ${counts} · #${tick.rank}`),
    controls([practiseButton], ['/lingo stats', '/lingo lang']),
  ]
}

/** How a card is asked, in words. The CLI's `questionFor`, minus the teach case. */
function questionRow(card: Card, englishName: string): string {
  switch (card.kind) {
    case 'recognize':
      return `What does "${card.prompt}" mean?`
    case 'reverse':
      return `How do you say "${card.prompt}" in ${englishName}?`
    case 'cloze':
      return `Fill the gap:  ${card.prompt}`
    default:
      return card.prompt
  }
}

/**
 * The band, drawn.
 *
 * Below `BAND_MIN_COLUMNS` three rows cannot say anything useful, so it gives
 * up the layout and keeps the interaction: the controls row, which is the one
 * row that can still be pressed.
 */
export function bandView(kit: BandKit, model: BandModel): RenderElement {
  const { Box, Text } = kit.ui
  const gutter = kit.columns >= OWL_MIN_COLUMNS
  const columns = Math.max(1, kit.columns - (gutter ? MASCOT_WIDTH + 2 : 0))

  const body = rowsOf(kit, model, columns)

  if (kit.columns < BAND_MIN_COLUMNS) {
    // The last row, not the first: a question nobody can answer is worth less
    // than the keys that answer it.
    return <Box flexDirection="column">{body.slice(-1)}</Box>
  }

  if (!gutter) {
    return <Box flexDirection="column">{body}</Box>
  }

  const face = owl(moodOf(model), Math.floor(model.now / 2000))

  return (
    <Box flexDirection="row" gap={2}>
      <Box flexDirection="column">
        {face.map((row) => (
          <Text dimColor>{row}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {body}
      </Box>
    </Box>
  )
}

/**
 * The band under whatever else the engine and other plugins put there.
 *
 * Under, not over: the engine's own notices are about the session and this is
 * about vocabulary, so the thing you might need to act on stays nearest the
 * conversation and the quiz sits closest to the prompt you answer it from.
 */
export function withBand(ui: BandUi, beneath: RenderElement, band: RenderElement): RenderElement {
  const { Box } = ui

  return (
    <Box flexDirection="column">
      {beneath}
      {band}
    </Box>
  )
}
