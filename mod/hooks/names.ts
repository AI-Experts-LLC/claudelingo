/**
 * The fixed names: what the band is called, and what it keeps where.
 *
 * Store keys are versioned in their own right (`v1`) rather than under one
 * schema number, because the deck and the settings change for different
 * reasons and a settings migration should not orphan a year of progress.
 */

/** The plugin's name, as `ui.press` and `ui.focus` carry it. */
export const PLUGIN_NAME = 'claudelingo'

/** The slash command the band's third row names. */
export const COMMAND_NAME = 'lingo'

/** Settings: the language, the caps, whether the band draws at all. */
export const SETTINGS_KEY = 'claudelingo:settings:v1'

/** One deck per language, so switching language never touches the other. */
export const progressKey = (lang: string) => `claudelingo:progress:v1:${lang}`

/** A memory hook, cached by word id: a word is only ever paid for once. */
export const hookKey = (wordId: string) => `claudelingo:hook:v1:${wordId}`

/** A pack generated for a language the mod does not bundle. */
export const packKey = (code: string) => `claudelingo:pack:v1:${code}`

/** The index of generated packs, so the picker can offer them. */
export const PACKS_KEY = 'claudelingo:packs:v1'

/* ── Button keys ──────────────────────────────────────────────────────────
 *
 * `e.element` at `ui.press` is one of these. They are addresses, not labels:
 * a test presses `answer:2` without knowing what the option says.
 */

/** One per multiple-choice option, `answer:0` upwards. */
export const answerKey = (index: number) => `answer:${index}`
/** One per language the picker offers. */
export const langKey = (code: string) => `lang:${code}`

export const KEYS = {
  /** Acknowledges a `teach` card, or moves past a verdict. */
  next: 'next',
  /** Drops the card and delays it ten minutes, without penalty. */
  skip: 'skip',
  /** Asks the model for a memory hook. */
  explain: 'explain',
  /** Quizzes while Claude is idle. */
  practise: 'practise',
  /** Where a `recall` card's typing goes. */
  spell: 'spell',
} as const

/**
 * Hotkeys are digits throughout, and that is a constraint rather than a taste.
 *
 * In the band a bare digit presses from an empty composer, with nothing
 * focused: that is the whole reason this mod exists, and it is what lets an
 * answer cost one keystroke. A letter presses only once one of the band's
 * Buttons already has the focus, which is a chord and a hunt. So every control
 * that has to work from where your hands already are gets a digit, and the
 * digits after the options are the controls.
 */
export const CONTROL_HOTKEYS = {
  /** Never collides: options take at most 1-4, and `teach` offers no options. */
  next: '1',
  skip: '5',
  explain: '6',
  practise: '1',
} as const

/** Rows the band draws. Fixed, so the conversation above it never jumps. */
export const BAND_ROWS = 3

/**
 * Below this many columns the owl gutter costs more than it gives.
 *
 * The CLI's panel uses the same figure for the same reason; kept a literal on
 * each side because the two surfaces are free to diverge.
 */
export const OWL_MIN_COLUMNS = 46

/** Below this, three rows cannot say anything useful: draw one instead. */
export const BAND_MIN_COLUMNS = 30

/** How long one word holds the idle ticker before the next takes over. */
export const TICK_MS = 8000

/** Fraction of that spent hidden, before the meaning is revealed. */
export const HIDDEN_FRACTION = 0.5

/**
 * How often the band redraws itself while it is drilling.
 *
 * The ticker reveals on a clock, and the engine redraws on its own events —
 * which go quiet exactly while a turn is running, which is when the band is
 * supposed to be teaching. So it asks for its own redraws, at a rate the
 * engine's ten-a-second ceiling never has to fold.
 */
export const REDRAW_MS = 1000
