/**
 * Restates the CLI's shared source under mod/hooks/, and checks it is current.
 *
 * A hooks module runs with no filesystem and no Node: it cannot read
 * src/packs/*.json at startup, and it cannot import across the package
 * boundary. So the words and the scheduler exist twice — and a second copy of
 * anything drifts, which for a scheduler means two claudelingos disagreeing
 * about when a word is due, and for a pack means progress keyed by rank
 * pointing at different words on each side.
 *
 * They are therefore generated, never edited. src/ is the one source;
 * `npm run mod:restate` restates it, and `npm run mod:restate -- --check`
 * re-derives and compares instead of writing, so CI fails on a hand-edit or a
 * stale copy rather than shipping two decks that disagree.
 *
 * Only mechanically-portable modules qualify: the port is an import rewrite and
 * nothing else. Anything needing real changes belongs in a hand-written module
 * of the mod's own, where it can be read as what it is.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const packSource = path.join(root, 'src', 'packs')
const packTarget = path.join(here, '..', 'hooks', 'packs')
const hooks = path.join(here, '..', 'hooks')

const isCheck = process.argv.includes('--check')

/** Modules the mod takes from the CLI unchanged but for their imports. */
const SHARED = ['cloze.ts', 'packgen.ts', 'srs.ts', 'ui/tiers.ts', 'ui/mascot.ts', 'ui/width.ts']

const BANNER = (from) =>
  `// Restated from ${from} by mod/scripts/restate.mjs.\n` +
  `// Do not edit: change ${from} and run \`npm run mod:restate\`.\n\n`

/** The module, with extensionless imports the hooks loader resolves. */
function sharedModule(name) {
  const text = fs.readFileSync(path.join(root, 'src', name), 'utf8')

  return BANNER(`src/${name}`) + text.replace(/(from\s+"\.[^"]*)\.js"/g, '$1"')
}

/** The JSON's words as a TS literal: one word a line, so a diff reads. */
function packModule(code, raw) {
  const words = raw.words.map((entry) => `  ${JSON.stringify(entry)},`).join('\n')

  return (
    BANNER(`src/packs/${code}.json`) +
    `import type { RawPack } from '../types'\n\n` +
    `export const ${code.toUpperCase()}: RawPack = {\n` +
    `  code: ${JSON.stringify(raw.code)},\n` +
    `  name: ${JSON.stringify(raw.name)},\n` +
    `  englishName: ${JSON.stringify(raw.englishName)},\n` +
    `  words: [\n${words}\n  ],\n}\n`
  )
}

const codes = fs
  .readdirSync(packSource)
  .filter((file) => file.endsWith('.json'))
  .map((file) => path.basename(file, '.json'))
  .sort()

const written = new Map()

for (const name of SHARED) {
  written.set(path.join(hooks, name), sharedModule(name))
}

for (const code of codes) {
  const raw = JSON.parse(fs.readFileSync(path.join(packSource, `${code}.json`), 'utf8'))
  written.set(path.join(packTarget, `${code}.ts`), packModule(code, raw))
}

written.set(
  path.join(packTarget, 'index.ts'),
  BANNER('src/packs') +
    `import type { RawPack } from '../types'\n` +
    codes.map((code) => `import { ${code.toUpperCase()} } from './${code}'`).join('\n') +
    `\n\n/** The packs built into the mod, in the order the picker offers them. */\n` +
    `export const BUNDLED: readonly RawPack[] = [${codes.map((c) => c.toUpperCase()).join(', ')}]\n`,
)

if (isCheck) {
  const stale = [...written]
    .filter(([file, text]) => {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

      return current !== text
    })
    .map(([file]) => path.relative(root, file))

  if (stale.length) {
    console.error(`stale, run \`npm run mod:restate\`:\n  ${stale.join('\n  ')}`)
    process.exit(1)
  }

  console.log(`mod matches src (${SHARED.length} modules, ${codes.length} packs)`)
} else {
  for (const [file, text] of written) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }

  console.log(`restated ${SHARED.length} modules and ${codes.length} packs`)
}
