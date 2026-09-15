import { sliceToWidth, stringWidth } from '../ui/width'

/**
 * Sharing one row between several things, measured in rendered cells.
 *
 * The band promises to be three rows. The first version of it kept that promise
 * in the wrong units: it fitted each part of a row against the *whole* body
 * width, so three parts each "fitting" in 38 columns produced a 39-cell row in
 * a 38-cell band. `Text` wraps by default, so the row became two and the band
 * became four — which is not merely untidy. A band taller than the rows it is
 * given scrolls, and a scrolling band "arms none of its Buttons' hotkeys": the
 * overflow would silently turn every answer key off, which is the whole
 * interaction.
 *
 * So a row is budgeted as a row. Parts declare the cells they cost besides
 * their label, the gaps between them are counted, and the labels shrink
 * together until the total fits.
 */

/** Cells between two children of a `flexDirection="row"` Box, as drawn. */
export const GAP = 2

/**
 * A plain `Button` draws as `1: label` — the hotkey, a colon, a space.
 *
 * Without a hotkey there is no prefix. This is the one place that knows the
 * shape, so a change to how a button renders is a change here and nowhere else.
 */
export const buttonOverhead = (hotkey?: string): number =>
  hotkey === undefined ? 0 : stringWidth(hotkey) + 2

/** One thing sharing a row: its label, and what it costs besides the label. */
export interface Part {
  label: string
  /** Cells the part costs whatever its label says (a button's `1: `). */
  overhead?: number
  /**
   * Whether the label may be shortened. A control's name is worth keeping
   * whole; a gloss is not.
   */
  fixed?: boolean
}

/** Truncate to a column budget, in columns. */
export function fit(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (stringWidth(text) <= columns) return text

  const { text: head } = sliceToWidth(text, Math.max(0, columns - 1))

  return `${head}…`
}

/**
 * The labels, shortened together until the whole row fits `columns`.
 *
 * Water-filling rather than an equal split: a row of one short gloss and three
 * long ones should shorten the long ones and leave the short one whole. Each
 * pass gives every still-too-long label an equal share of what is left, and
 * hands back what the ones that fit did not use.
 *
 * Parts marked `fixed` keep their labels and are charged in full; where even
 * they do not fit, the shrinkable labels go to nothing and the row is
 * truncated by the surface as a last resort — there is no width at which this
 * returns something wider than it was asked for, except one narrower than the
 * fixed parts alone.
 */
export function fitRow(parts: readonly Part[], columns: number): string[] {
  if (parts.length === 0) return []

  const overhead = parts.reduce((sum, part) => sum + (part.overhead ?? 0), 0)
  const gaps = GAP * (parts.length - 1)
  const widths = parts.map((part) => stringWidth(part.label))

  let available = columns - overhead - gaps

  // Fixed labels are charged whole; what they leave is shared by the rest.
  parts.forEach((part, index) => {
    if (part.fixed) available -= widths[index] ?? 0
  })

  const shrinkable = parts
    .map((part, index) => ({ index, width: widths[index] ?? 0 }))
    .filter(({ index }) => !parts[index]?.fixed)

  const wanted = shrinkable.reduce((sum, { width }) => sum + width, 0)

  if (available >= wanted) return parts.map((part) => part.label)

  const budgets = new Map<number, number>()
  let remaining = Math.max(0, available)
  let open = shrinkable

  while (open.length > 0) {
    const share = Math.floor(remaining / open.length)

    // Nothing left to share: everything still open gets nothing.
    if (share <= 0) {
      for (const { index } of open) budgets.set(index, 0)
      break
    }

    const settled = open.filter(({ width }) => width <= share)

    if (settled.length === 0) {
      // Every one of them wants more than its share: split what is left.
      let spare = remaining % open.length

      for (const { index } of open) {
        budgets.set(index, share + (spare > 0 ? 1 : 0))
        spare -= 1
      }

      break
    }

    for (const { index, width } of settled) {
      budgets.set(index, width)
      remaining -= width
    }

    open = open.filter(({ width }) => width > share)
  }

  return parts.map((part, index) =>
    part.fixed ? part.label : fit(part.label, budgets.get(index) ?? 0),
  )
}
