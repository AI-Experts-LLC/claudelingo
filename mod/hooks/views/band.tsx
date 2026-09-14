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
import { sliceToWidth, stringWidth } from '../ui/width'
import { MAX_BOX } from '../srs'
import { bar } from '../ticker'
import type { Tick } from '../ticker'
import type { Card, ItemProgress, Pack, Verdict } from '../types'
import type { PackChoice } from '../pack'

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
 *   card comes and goes. Every branch returns the same height.
 * - **Never taller than `maxRows`.** A band that overflows scrolls in a window
 *   and — the part that would be fatal here — "a bare digit arms none of its
 *   Buttons' hotkeys". An overflowing band is a band you cannot answer.
 * - **Everything measured in columns, not code points**, so a generated CJK
 *   pack budgets its options correctly rather than overflowing the row.
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
  /** Something is wrong and stays on screen until it is not. */
  trouble: string | null
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

/** Truncate to a column budget, in columns. */
function fit(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (stringWidth(text) <= columns) return text

  const { text: head } = sliceToWidth(text, Math.max(0, columns - 1))

  return `${head}…`
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

  const dim = (text: string) => <Text dimColor>{fit(text, columns)}</Text>

  /** The third row, unless something has taken it. */
  const controls = (...children: RenderElement[]) => (
    <Box flexDirection="row" gap={2}>
      {children}
    </Box>
  )

  const skipButton = (
    <Button
      key={KEYS.skip}
      hotkey={CONTROL_HOTKEYS.skip}
      plain
      dimColor
      label="skip"
      onPress={actions.skip}
    />
  )

  const explainButton = model.enrich ? (
    <Button
      key={KEYS.explain}
      hotkey={CONTROL_HOTKEYS.explain}
      plain
      dimColor
      label={model.fetchingHook ? 'asking…' : 'explain'}
      onPress={actions.explain}
    />
  ) : null

  // ── Nothing chosen yet ───────────────────────────────────────────────────
  //
  // The CLI asks this in a pane, over three screens. Here it is one row of
  // buttons, and the answer is one digit.
  if (model.choices) {
    return [
      <Text bold>{fit('Which language do you want to learn?', columns)}</Text>,
      <Box flexDirection="row" gap={2}>
        {model.choices.slice(0, 4).map((choice, index) => (
          <Button
            key={langKey(choice.code)}
            hotkey={String(index + 1)}
            plain
            label={choice.englishName}
            onPress={() => actions.chooseLang(choice.code)}
          />
        ))}
      </Box>,
      dim('press a digit · /lingo lang <code> for any other language'),
    ]
  }

  // ── Just answered ────────────────────────────────────────────────────────
  if (model.verdict) {
    const { correct, answer, word } = model.verdict

    const verdictRow = correct ? (
      <Text color="success" bold>
        {fit(`correct — ${word.term} = ${word.gloss}`, columns)}
      </Text>
    ) : (
      <Text color="error" bold>
        {fit(`not quite — ${word.term} = ${answer}`, columns)}
      </Text>
    )

    const aside = model.hook
      ? dim(model.hook)
      : dim(remark(moodOf(model), model.streak) || word.note || word.example?.text || '')

    return [
      verdictRow,
      aside,
      controls(
        <Button
          key={KEYS.next}
          hotkey={CONTROL_HOTKEYS.next}
          plain
          label="next"
          onPress={actions.next}
        />,
        ...(explainButton ? [explainButton] : []),
      ),
    ]
  }

  // ── A card is up ─────────────────────────────────────────────────────────
  if (model.card && model.pack) {
    const card = model.card
    const pack = model.pack
    const box = model.item ? `box ${model.item.box}/${MAX_BOX}` : 'new'

    if (card.kind === 'teach') {
      const note = card.word.note ? ` (${card.word.note})` : ''

      return [
        <Text>
          <Text bold color="suggestion">
            {fit(card.word.term, Math.max(1, columns - 2))}
          </Text>
          <Text dimColor>{fit(`  #${card.word.rank}`, 12)}</Text>
        </Text>,
        <Text>{fit(`${card.word.gloss}  ${card.word.pos}${note}`, columns)}</Text>,
        controls(
          <Button
            key={KEYS.next}
            hotkey={CONTROL_HOTKEYS.next}
            plain
            label="got it"
            onPress={actions.next}
          />,
          skipButton,
          ...(explainButton ? [explainButton] : []),
        ),
      ]
    }

    if (card.kind === 'recall') {
      return [
        <Text bold>{fit(`Spell the ${pack.englishName} for "${card.prompt}"`, columns)}</Text>,
        <Input
          key={KEYS.spell}
          placeholder="type it, then Enter"
          value={model.typed}
          submitLabel="answer"
          onInput={actions.type}
          onSubmit={actions.spell}
        />,
        controls(dim(box), skipButton, ...(explainButton ? [explainButton] : [])),
      ]
    }

    // recognize / reverse / cloze: four options, one digit each.
    //
    // The labels share what is left of the row after the gutter, so four long
    // glosses shorten together rather than the fourth falling off the end.
    const budget = Math.max(4, Math.floor((columns - 6) / Math.max(1, card.choices.length)) - 4)

    return [
      <Text bold>{fit(questionRow(card, pack.englishName), columns)}</Text>,
      <Box flexDirection="row" gap={2}>
        {card.choices.map((choice, index) => (
          <Button
            key={answerKey(index)}
            hotkey={String(index + 1)}
            plain
            label={fit(choice, budget)}
            onPress={() => actions.answer(index)}
          />
        ))}
      </Box>,
      controls(dim(box), skipButton, ...(explainButton ? [explainButton] : [])),
    ]
  }

  // ── Caught up, or standing down ──────────────────────────────────────────
  //
  // The ticker, exactly as the CLI's panel runs it: a word alone, a moment to
  // reach for it, then the meaning. Nothing here is graded and nothing written.
  const tick = model.tick

  if (!tick?.word) {
    return [
      <Text>{fit(model.pack ? `${model.pack.englishName} · all caught up` : 'claudelingo', columns)}</Text>,
      dim(`${bar(1, 10)}  nothing due`),
      controls(
        <Button
          key={KEYS.practise}
          hotkey={CONTROL_HOTKEYS.practise}
          plain
          dimColor
          label="practise"
          onPress={actions.practise}
        />,
        dim('/lingo stats'),
      ),
    ]
  }

  const counts = `${tick.learned}/${tick.total}${model.streak > 0 ? ` · streak ${model.streak}` : ''}`

  return [
    <Text>
      <Text color="suggestion">{fit(`«${tick.word.term}»`, Math.max(1, columns - 20))}</Text>
      <Text dimColor>{' = '}</Text>
      {tick.revealed ? (
        <Text bold>{fit(tick.word.gloss, 40)}</Text>
      ) : (
        <Text dimColor>?</Text>
      )}
    </Text>,
    dim(`${bar(tick.total ? tick.learned / tick.total : 0, 10)}  ${counts} · #${tick.rank}`),
    controls(
      <Button
        key={KEYS.practise}
        hotkey={CONTROL_HOTKEYS.practise}
        plain
        dimColor
        label="practise"
        onPress={actions.practise}
      />,
      dim('/lingo stats   /lingo lang'),
    ),
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
 * up the layout and keeps the interaction: one row, still pressable.
 */
export function bandView(kit: BandKit, model: BandModel): RenderElement {
  const { Box, Text } = kit.ui
  const gutter = kit.columns >= OWL_MIN_COLUMNS
  const columns = Math.max(1, kit.columns - (gutter ? MASCOT_WIDTH + 2 : 0))

  const rows = rowsOf(kit, model, columns)

  // Trouble takes the third row rather than adding a fourth: the height is a
  // promise, and an error that broke the layout would be its own second bug.
  const body =
    model.trouble === null
      ? rows
      : [
          ...rows.slice(0, 2),
          <Text color="error">{fit(model.trouble, columns)}</Text>,
        ]

  if (kit.columns < BAND_MIN_COLUMNS) {
    return <Box flexDirection="column">{body.slice(0, 1)}</Box>
  }

  if (!gutter) {
    return <Box flexDirection="column">{body}</Box>
  }

  const face = owl(moodOf(model), Math.floor(model.now / 2000))

  return (
    <Box flexDirection="row" gap={2}>
      <Box flexDirection="column">
        {face.map((line) => (
          <Text dimColor>{line}</Text>
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
