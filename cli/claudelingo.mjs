#!/usr/bin/env node
// claudelingo — installs the claudelingo mod into Claude Code.
//
//   npx claudelingo@latest install     install or update
//   npx claudelingo@latest uninstall   remove it (your decks are kept)
//   npx claudelingo@latest status      what is installed, and whether it will load
//
// The package carries the plugin itself. `install` copies it into
// ~/.claude/skills/claudelingo, where Claude Code loads it, and turns on function
// hooks — the early-access feature mods run on — in ~/.claude/settings.json.
//
// Nothing happens at `npm install` time. npm blocks install scripts by default,
// and a package that quietly rewrote your settings on install would deserve it.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FLAG = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'
const MIN_CLAUDE = '2.1.271'

/** What goes into the plugin folder: everything Claude Code reads, nothing else. */
const PLUGIN_FILES = ['.claude-plugin', 'hooks', 'README.md', 'LICENSE']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const home = () => process.env.HOME || os.homedir()
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude')
const pluginDir = () => path.join(claudeDir(), 'skills', 'claudelingo')
const settingsPath = () => path.join(claudeDir(), 'settings.json')
const statePath = () => path.join(pluginDir(), '.install-state')
const launcherPath = () => path.join(home(), '.local', 'bin', 'claude-lingo')

const colour = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text)

const say = (text = '') => console.log(text)
const step = (text) => console.log(`${paint(32, '✓')} ${text}`)
const warn = (text) => console.error(`${paint(33, '!')} ${text}`)

class Refusal extends Error {}

function fail(text) {
  console.error(`${paint(31, '✗')} ${text}`)
  process.exit(1)
}

function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))

  return pkg.version
}

/** `2.1.1000` >= `2.1.271`, compared part by part. */
function versionAtLeast(have, need) {
  const h = String(have).split('.').map((n) => parseInt(n, 10) || 0)
  const n = String(need).split('.').map((x) => parseInt(x, 10) || 0)

  for (let i = 0; i < 3; i++) {
    if ((h[i] ?? 0) > (n[i] ?? 0)) return true
    if ((h[i] ?? 0) < (n[i] ?? 0)) return false
  }

  return true
}

function claudeVersion() {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8' })

  if (result.error) return null

  return (result.stdout || '').trim().split(/\s+/)[0] || ''
}

/**
 * A command line split into words the way a POSIX shell would, or null if the
 * quoting is unbalanced.
 */
function shellWords(command) {
  const words = []
  let word = ''
  let inWord = false
  let quote = null

  for (let i = 0; i < command.length; i++) {
    const c = command[i]

    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) word += command[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }

  if (quote !== null) return null
  if (inWord) words.push(word)

  return words
}

/**
 * True only if the program being run *is* claudelingo, asked for one of `verbs`.
 *
 * The rule the older claudelingo used to recognise its own entries. A command
 * that merely mentions claudelingo — a `sh -c` that also runs it, a script called
 * `notify-claudelingo` — belongs to someone else and is kept.
 */
function isOldClaudelingo(command, verbs) {
  const words = shellWords(String(command ?? ''))

  return (
    words !== null &&
    words.length >= 2 &&
    path.basename(words[0]) === 'claudelingo' &&
    verbs.includes(words[1])
  )
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'))

    return isObject(state) ? state : {}
  } catch {
    return {}
  }
}

/**
 * Apply `change` to settings.json, safely, and return what it did.
 *
 * Every rule here exists because breaking it hurts someone:
 *
 * - Write through a symlink, never over it: settings managed from a dotfiles
 *   repo are a link to the real file.
 * - Keep the file's permissions: its env block often holds API keys.
 * - A file that cannot be read, parsed or written is left exactly as it is.
 * - Back up before the first change, and never overwrite an earlier backup.
 * - Write a temporary file, fsync it, then rename it into place.
 */
function editSettings(change) {
  const target = fs.existsSync(settingsPath()) || isDanglingLink(settingsPath())
    ? resolveTarget(settingsPath())
    : settingsPath()
  const directory = path.dirname(target)

  let settings = {}
  let exists = false

  try {
    const text = fs.readFileSync(target, 'utf8')

    settings = text.trim() ? JSON.parse(text) : {}
    exists = true
  } catch (error) {
    if (error.code === 'ENOENT') {
      exists = false
    } else if (error instanceof SyntaxError) {
      throw new Refusal(`settings.json is not valid JSON (${error.message})`)
    } else {
      throw new Refusal(`settings.json could not be read (${error.message})`)
    }
  }

  if (!isObject(settings)) throw new Refusal('settings.json is not a JSON object')

  if (exists) {
    // `access` always says yes to root, so a file with no write bit at all is
    // also the owner saying "don't". (Untested: it only differs as root.)
    const writable = canWrite(target) && (fs.statSync(target).mode & 0o222) !== 0

    if (!writable) throw new Refusal('settings.json is not writable, so it is probably managed elsewhere')
  }

  if (fs.existsSync(directory) && !canWrite(directory)) {
    throw new Refusal(`${directory} is not writable`)
  }

  const before = JSON.stringify(settings)
  const state = readState()
  const changes = change(settings, state)

  if (JSON.stringify(settings) === before) return { changes, state }

  if (exists) {
    let backup = `${target}.claudelingo-backup`
    let n = 1

    while (fs.existsSync(backup)) {
      n += 1
      backup = `${target}.claudelingo-backup-${n}`
    }

    fs.copyFileSync(target, backup)
    fs.chmodSync(backup, fs.statSync(target).mode & 0o777)
    changes.push(`backup: ${backup}`)
  } else {
    fs.mkdirSync(directory, { recursive: true })
  }

  const tmp = path.join(directory, `.settings.${process.pid}.${Date.now()}.claudelingo-tmp`)

  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)

    try {
      fs.writeSync(fd, `${JSON.stringify(settings, null, 2)}\n`)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    fs.chmodSync(tmp, exists ? fs.statSync(target).mode & 0o777 : 0o600)
    fs.renameSync(tmp, target)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }

  return { changes, state }
}

function canWrite(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK)

    return true
  } catch {
    return false
  }
}

function isDanglingLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The real file behind a chain of links, even when the last one dangles.
 *
 * `..` has to be resolved *after* following directory links, the way the kernel
 * does it. Treating it as text goes wrong when ~/.claude is itself a link and
 * settings.json is a relative link that climbs out of it: the path looks fine,
 * points somewhere else, and the install reports success while writing a stray
 * file. So every hop is resolved against the real path of its directory.
 */
function resolveTarget(file) {
  try {
    return fs.realpathSync(file)
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new Refusal('settings.json could not be read (too many levels of symbolic links)')
    }
    // Dangling: follow it hop by hop to where the file should be.
  }

  let current = file

  for (let hops = 0; hops < 40; hops++) {
    let stat

    try {
      stat = fs.lstatSync(current)
    } catch {
      return current
    }

    if (!stat.isSymbolicLink()) return current

    let directory

    try {
      directory = fs.realpathSync(path.dirname(current))
    } catch {
      directory = path.dirname(current)
    }

    current = path.resolve(directory, fs.readlinkSync(current))
  }

  throw new Refusal('settings.json could not be read (too many levels of symbolic links)')
}

/** Turn function hooks on and remove the older claudelingo's entries. */
function installChange(settings, state) {
  const changes = []

  if (settings.env === undefined) settings.env = {}
  if (!isObject(settings.env)) throw new Refusal('settings.json "env" is not an object')

  if (settings.env[FLAG] !== '1') {
    // Remember what this install found, so uninstall can put it back exactly.
    // The most recent install wins: if you set the flag yourself in between,
    // that is the choice uninstall should restore.
    state.flag = { present: FLAG in settings.env, value: settings.env[FLAG] ?? null }

    settings.env[FLAG] = '1'
    changes.push(`set env.${FLAG} = 1`)
  }

  if (isObject(settings.statusLine) && isOldClaudelingo(settings.statusLine.command, ['statusline'])) {
    delete settings.statusLine
    changes.push('removed the old claudelingo status line')
  }

  if (isObject(settings.hooks)) {
    let removed = 0

    for (const event of Object.keys(settings.hooks)) {
      const groups = settings.hooks[event]

      if (!Array.isArray(groups)) continue

      const keptGroups = []

      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) {
          keptGroups.push(group)
          continue
        }

        const kept = group.hooks.filter(
          (hook) => !(isObject(hook) && isOldClaudelingo(hook.command, ['hook', 'session-start'])),
        )

        removed += group.hooks.length - kept.length

        if (kept.length > 0) {
          group.hooks = kept
          keptGroups.push(group)
        }
      }

      if (keptGroups.length > 0) settings.hooks[event] = keptGroups
      else delete settings.hooks[event]
    }

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks
    if (removed > 0) changes.push(`removed ${removed} old claudelingo hook${removed === 1 ? '' : 's'}`)
  }

  return changes
}

/** Put the function-hooks setting back the way install found it. */
function uninstallChange(settings, state) {
  const changes = []
  const previous = state.flag

  if (!isObject(previous) || !isObject(settings.env) || settings.env[FLAG] !== '1') return changes

  if (previous.present) {
    settings.env[FLAG] = previous.value
    changes.push(`restored env.${FLAG} to its previous value`)
  } else {
    delete settings.env[FLAG]
    if (Object.keys(settings.env).length === 0) delete settings.env
    changes.push(`removed env.${FLAG}`)
  }

  return changes
}

function installLauncher() {
  fs.mkdirSync(path.dirname(launcherPath()), { recursive: true })
  fs.writeFileSync(
    launcherPath(),
    '#!/bin/sh\n# Claude Code with function hooks on, for claudelingo. Installed by claudelingo.\n' +
      `exec env ${FLAG}=1 claude "$@"\n`,
    { mode: 0o755 },
  )
  fs.chmodSync(launcherPath(), 0o755)
}

/**
 * Copy the plugin in, replacing any earlier copy in one step.
 *
 * Copied to a staging folder first and then moved in, so an interrupted copy
 * leaves the old plugin untouched rather than half of a new one.
 */
function copyPlugin() {
  const destination = pluginDir()
  // Outside skills/: a staging folder left by a crash must not load as a second
  // copy of the plugin. Same parent filesystem as the destination, so the
  // rename is atomic.
  const staging = path.join(claudeDir(), '.claudelingo-staging')
  const previousState = fs.existsSync(statePath()) ? fs.readFileSync(statePath()) : null

  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  for (const entry of PLUGIN_FILES) {
    const from = path.join(PACKAGE_ROOT, entry)

    if (fs.existsSync(from)) fs.cpSync(from, path.join(staging, entry), { recursive: true })
  }

  if (previousState) fs.writeFileSync(path.join(staging, '.install-state'), previousState)

  const existed = fs.existsSync(destination)

  fs.rmSync(destination, { recursive: true, force: true })
  fs.renameSync(staging, destination)

  return existed
}

/**
 * Things earlier installs left behind that would now get in the way: a second
 * copy of the plugin draws a second band, and the old /lingo skill competes
 * with the mod's /lingo.
 */
function removeLeftovers() {
  const legacy = path.join(claudeDir(), 'skills', 'claudelingo-mod')

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(legacy, '.claude-plugin', 'plugin.json'), 'utf8'))

    if (manifest.name === 'claudelingo') {
      fs.rmSync(legacy, { recursive: true, force: true })
      step(`removed an older copy at ${legacy}`)
    }
  } catch {
    // Not there, or not ours.
  }

  const skill = path.join(claudeDir(), 'skills', 'lingo')

  try {
    if (fs.lstatSync(skill).isSymbolicLink() && fs.readlinkSync(skill).includes('.claudelingo')) {
      fs.rmSync(skill, { force: true })
      step('removed the old /lingo skill link')
    }
  } catch {
    // Not there.
  }

  // An earlier hand-made launcher ran Claude Code with a settings overlay this
  // removes. Replace it rather than leave it pointing at a file that is gone.
  try {
    if (fs.readFileSync(launcherPath(), 'utf8').includes('claudelingo-mod-trial')) {
      installLauncher()
      step(`updated ${launcherPath()}`)
    }
  } catch {
    // No launcher.
  }

  fs.rmSync(path.join(claudeDir(), 'claudelingo-mod-trial.settings.json'), { force: true })
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true })
  fs.writeFileSync(statePath(), JSON.stringify(state))
}

function install(options) {
  say(`Installing claudelingo ${packageVersion()}`)

  const version = claudeVersion()

  if (version === null) {
    fail('Claude Code is required: https://docs.claude.com/en/docs/claude-code')
  }

  if (version && !versionAtLeast(version, MIN_CLAUDE)) {
    fail(
      `Claude Code ${version} is too old; claudelingo needs ${MIN_CLAUDE} or newer, which is on the ` +
        'latest release channel (the stable channel may not have reached it yet)',
    )
  }

  fs.mkdirSync(path.join(claudeDir(), 'skills'), { recursive: true })

  const updated = copyPlugin()

  step(`${updated ? 'updated' : 'installed'} ${pluginDir()}`)
  removeLeftovers()

  let useSettings = options.settings

  if (useSettings) {
    try {
      const { changes, state } = editSettings(installChange)

      // Only once the write has landed does a record of it mean anything.
      saveState(state)
      for (const change of changes) step(change)
      say()
      say('Done. Start Claude Code as usual:  claude')
    } catch (error) {
      // A refusal is a decision; anything else (a full disk, a directory that
      // cannot be created) is a failure. Either way settings.json is unchanged,
      // and the plugin is already copied, so the launcher still gets you going.
      warn(
        error instanceof Refusal
          ? `${error.message}; leaving settings.json alone`
          : `could not update settings.json (${error.message}); it is unchanged`,
      )
      useSettings = false
    }
  }

  if (!useSettings) {
    installLauncher()
    step(`installed ${launcherPath()}`)
    say()

    const onPath = (process.env.PATH || '').split(path.delimiter).includes(path.dirname(launcherPath()))

    say(
      onPath
        ? 'Done. Start Claude Code with:  claude-lingo'
        : `Done. Start Claude Code with:  ${launcherPath()}   (or add ${path.dirname(launcherPath())} to your PATH)`,
    )
  }

  say()
  say('Start a task and a card appears above your prompt; press the digit beside')
  say('your answer. Press 1 on the idle band for a quiz. /lingo shows the rest.')
  say('Update: npx claudelingo@latest install    Uninstall: npx claudelingo@latest uninstall')
}

function uninstall() {
  say('Uninstalling claudelingo')

  if (fs.existsSync(statePath())) {
    try {
      const { changes } = editSettings(uninstallChange)

      for (const change of changes) step(change)
    } catch (error) {
      warn(
        `could not update settings.json (${error.message}); remove env.${FLAG} from it by hand if you want it gone`,
      )
    }
  }

  if (fs.existsSync(pluginDir())) {
    fs.rmSync(pluginDir(), { recursive: true, force: true })
    step(`removed ${pluginDir()}`)
  }

  try {
    if (fs.readFileSync(launcherPath(), 'utf8').includes('Installed by claudelingo')) {
      fs.rmSync(launcherPath(), { force: true })
      step(`removed ${launcherPath()}`)
    }
  } catch {
    // No launcher.
  }

  say()
  say(`Your decks are kept, in ${path.join(claudeDir(), 'plugins', 'store')}/claudelingo_*.json.`)
  say('Reinstall any time and they will be there.')
}

function status() {
  const version = claudeVersion()
  let installed = null

  try {
    installed = JSON.parse(fs.readFileSync(path.join(pluginDir(), '.claude-plugin', 'plugin.json'), 'utf8')).version
  } catch {
    installed = null
  }

  let flag = process.env[FLAG] === '1'

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))

    flag = flag || settings?.env?.[FLAG] === '1'
  } catch {
    // No settings, or unreadable: the flag can still come from the launcher.
  }

  const launcher = fs.existsSync(launcherPath())
  const recentEnough = version !== null && version !== '' && versionAtLeast(version, MIN_CLAUDE)

  say(`claudelingo package   ${packageVersion()}`)
  say(`plugin installed      ${installed ? `${installed} at ${pluginDir()}` : 'no'}`)
  say(`Claude Code           ${version === null ? 'not found' : version || 'unknown'}${recentEnough || !version ? '' : ` (needs ${MIN_CLAUDE}+)`}`)
  say(`function hooks        ${flag ? 'on' : launcher ? `off; start with ${launcherPath()}` : 'off'}`)

  const ready = installed && recentEnough && (flag || launcher)

  say()
  say(ready ? 'Ready.' : 'Not ready. Run: npx claudelingo@latest install')

  process.exit(ready ? 0 : 1)
}

const USAGE = `claudelingo ${packageVersion()} — a vocabulary quiz above your Claude Code prompt

  npx claudelingo@latest install        install or update
  npx claudelingo@latest install --no-settings
                                        leave settings.json alone; start with claude-lingo instead
  npx claudelingo@latest uninstall      remove it (your decks are kept)
  npx claudelingo@latest status         what is installed, and whether it will load`

function main(argv) {
  const [command, ...rest] = argv

  if (process.platform === 'win32' && ['install', 'update', 'uninstall', 'status'].includes(command)) {
    fail('claudelingo does not support Windows yet: https://github.com/AI-Experts-LLC/claudelingo/issues')
  }

  switch (command) {
    case 'install':
    case 'update': {
      const unknown = rest.filter((arg) => arg !== '--no-settings')

      if (unknown.length > 0) fail(`unknown option: ${unknown[0]}`)

      return install({ settings: !rest.includes('--no-settings') })
    }

    case 'uninstall':
      return uninstall()

    case 'status':
      return status()

    case '--version':
    case '-v':
      return say(packageVersion())

    // The older claudelingo was also a program called `claudelingo`, and its
    // hooks and status line call it by name. Anyone who never cleaned those up
    // now reaches this one, on every prompt. Answering silently is the only
    // right thing: printing would put text in their status line, and failing
    // would put an error on every turn.
    case 'hook':
    case 'session-start':
    case 'statusline':
    case 'notify':
      return

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return say(USAGE)

    default:
      console.error(USAGE)
      process.exit(1)
  }
}

main(process.argv.slice(2))
