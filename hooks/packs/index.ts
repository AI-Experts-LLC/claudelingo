import type { RawPack } from '../types'
import { ES } from './es'
import { FR } from './fr'
import { IT } from './it'
import { HIRAGANA, KANJI, KATAKANA } from './ja'

/** The packs built into the mod, in the order the picker offers them. */
export const BUNDLED: readonly RawPack[] = [ES, FR, IT, HIRAGANA, KATAKANA, KANJI]
