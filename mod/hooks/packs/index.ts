// Restated from src/packs by mod/scripts/restate.mjs.
// Do not edit: change src/packs and run `npm run mod:restate`.

import type { RawPack } from '../types'
import { ES } from './es'
import { FR } from './fr'
import { IT } from './it'

/** The packs built into the mod, in the order the picker offers them. */
export const BUNDLED: readonly RawPack[] = [ES, FR, IT]
