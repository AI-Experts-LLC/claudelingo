# claudelingo

**Learn a language in the dead time while Claude is working.**

claudelingo puts a vocabulary quiz in the band above your Claude Code prompt.
When Claude starts thinking, a card appears. Press the digit beside your answer.
When Claude needs you back, the card gets out of the way.

```
 ,___,  What does "tiempo" mean?
 (o.o)  1: time   2: weather   3: house   4: always
 /)_)   5: skip   6: explain   box 1/5
```

Spanish, French and Italian are built in, roughly the 310 most common words in
each, which covers most of what you hear in a day. Any other language can be
generated on demand.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh
```

Then start Claude Code as usual with `claude`. The first time, the band asks
which language you want to learn. Press a digit.

**Requirements:** Claude Code **2.1.271 or newer**, `git`, and `python3` (both
come with the Xcode Command Line Tools on macOS). Check your version with
`claude --version`.

claudelingo is a **mod**: a Claude Code plugin built on
[function hooks](https://github.com/anthropics/claude-code/tree/main/mods),
which are early access. That is why it needs a recent Claude Code, and why the
installer has to switch the feature on.

### What the installer does

1. Clones this repository into `~/.claude/skills/claudelingo`, where Claude Code
   loads it as a plugin. Run the same command again to update.
2. Adds `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` to the `env` block of
   `~/.claude/settings.json`, which turns function hooks on. Before changing
   anything it saves a copy as `settings.json.claudelingo-backup`, and it prints
   exactly what it changed. The file keeps its permissions, and if it's a
   symlink (from a dotfiles repo, say), the change is written to the file it
   points to. If the file can't be written, it's left alone and you get a
   launcher command instead.
3. If you used the older version of claudelingo, it removes that version's
   status line and hooks from the same file, so you don't end up with two. It
   only removes entries that run the `claudelingo` program itself; anything of
   yours that merely mentions it is kept. Your old progress is imported the
   first time you start Claude.

Prefer not to have your settings touched? Use this instead:

```bash
curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh -s -- --no-settings
```

With that option, `settings.json` is left alone and you start Claude Code with
`claude-lingo` instead of `claude`.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh -s -- --uninstall
```

This removes the plugin and puts the function-hooks setting back the way it was
before you installed. Your decks are kept, so reinstalling picks up where you
left off. Old-version entries the installer removed aren't restored; they're in
`settings.json.claudelingo-backup` if you want them.

## Using it

### Cards while Claude works

While a turn is running, the band puts a card up. When the turn ends, the card
comes down. You never have to go looking for it, and it never sits between you
and a question Claude is asking you.

### A quiz whenever you want one

Press `1` on the idle band, or type `/lingo quiz`, for a five-card quiz right
where you are, whether or not Claude is busy:

```
 ,___,  What does "el" mean?
 (o.o)  1: the (f. pl.)  2: a (f.)  3: the (m.)  4: the (f.)
 /)_)   5: skip   6: explain   2/5
```

It counts down, keeps going if you send Claude a prompt in the meantime, and
ends with a score:

```
 ,___,  Quiz done — 4 of 5 right
 (o.o)  wrong ones come back sooner; right ones come back later.
 /)_)   1: again   5: done
```

### Keys

Every key is a digit, because a digit works from an empty prompt without
clicking anything first. One keystroke per answer.

| Key | |
|---|---|
| `1`–`4` | answer a multiple-choice card |
| `1` | acknowledge a new word, move past a result, or start a quiz from the idle band |
| `5` | skip a card. No penalty; it comes back in ten minutes |
| `6` | explain: ask Claude for a memory hook for this word |
| type + `Enter` | spell a word out, on cards that ask you to |

### Commands

| | |
|---|---|
| `/lingo quiz [n]` | a quiz now: five cards, or `n` (up to 50) |
| `/lingo stats` | where you stand: words met, mastered, streak, accuracy |
| `/lingo lang` | the languages you have; `/lingo lang fr` switches |
| `/lingo pack Portuguese pt` | generate a pack for a language that isn't built in |
| `/lingo practise` | keep asking while Claude is idle, with no fixed length |
| `/lingo off` / `/lingo on` | hide the band, or bring it back |
| `/lingo reset` | erase the current language's progress, after asking |

Each language keeps its own deck, so switching never costs you progress.

**No API key needed.** Memory hooks and generated packs run through your
existing Claude Code login and usage.

## How it teaches

Every word climbs the same ladder, and only moves up when you get it right:

1. **New word.** You're shown the word, its meaning and where it ranks in the
   frequency list. Nothing is asked yet.
2. **Meaning.** You see the word and choose from four English meanings.
3. **Translate.** You see the English and choose from four words in the
   language.
4. **Fill the gap.** The word is blanked out of a real sentence.
5. **Spell it.** You see the English and type the word. Accents and
   capitalisation are forgiven; spelling isn't.

Scheduling uses spaced repetition. A word still being learned comes back after
1 minute, 10 minutes and an hour. Once it sticks, the gaps grow to 1, 3, 7, 16
and 35 days. A wrong answer drops the word one level and sends it back through
the short gaps, without wiping its history.

At most 8 words are in progress at once and at most 20 new words a day, so a
long afternoon builds a deck you remember rather than a flood you forget.

## Your data

Everything is stored locally, in a file Claude Code keeps for the plugin under
`~/.claude/plugins/store/`. Nothing is sent anywhere except the model requests
behind `explain` and `/lingo pack`. Your deck follows you between projects on
the same machine, but not between machines.

Cards, answers and scores never go into your conversation with Claude, so the
quiz doesn't use up Claude's context.

### Coming from the older claudelingo

Earlier versions of claudelingo were a separate terminal program with a tmux
pane and a status line. The first time you start Claude after installing this
version, it imports your old decks from `~/.claudelingo`: box levels, due dates,
streak and accuracy. It copies them and leaves the originals in place. If a
language already has a deck in the new version, that deck is kept rather than
overwritten.

The installer removes the old version's status line and hooks from
`settings.json` for you. The old program itself can then be deleted:

```bash
rm -rf ~/.claudelingo/src && rm -f "$(command -v claudelingo)"
```

Codex support did not carry over. The old version could quiz you while Codex
worked, but a mod is a Claude Code plugin, so the new version only runs inside
Claude Code.

## Troubleshooting

**Nothing appears above the prompt.**
- Check `claude --version` is 2.1.271 or newer. The `stable` release channel can
  lag behind the version this needs.
- Restart Claude Code after installing; plugins load at startup.
- Type `/lingo stats`. If the command isn't found, the plugin didn't load. Re-run
  the installer and read its output.
- If you installed with `--no-settings`, start Claude with `claude-lingo`, not
  `claude`.

**Two bands, or `/lingo` behaving strangely.** Another copy of claudelingo may
be installed. Re-run the installer, which removes known older copies.

**The band disappears in a narrow terminal.** Below 30 columns it shrinks to a
single row, and in very short terminals it steps aside entirely. It can only
take key presses when it fits.

## Early access

Function hooks may change between Claude Code releases without notice. If an
update breaks claudelingo, re-run the installer to get the latest version, and
[open an issue](https://github.com/AI-Experts-LLC/claudelingo/issues) if that
doesn't fix it.

## Contributing

```bash
git clone https://github.com/AI-Experts-LLC/claudelingo
cd claudelingo
npm install
npm run check     # typecheck, plugin validation, unit tests, installer tests
```

To run your working copy inside Claude Code:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

**Layout**

| | |
|---|---|
| `hooks/register.ts` | the mod's entry point: every hook it registers |
| `hooks/views/` | the band. `row.ts` fits each row into the terminal width |
| `hooks/srs.ts` | the spaced-repetition scheduler |
| `hooks/deck.ts` | reading and writing decks, settings and packs |
| `hooks/migrate.ts` | importing decks from the older claudelingo |
| `hooks/packgen.ts` | generating a word pack for a new language |
| `hooks/packs/` | the built-in Spanish, French and Italian word lists |
| `install.sh` | the installer |
| `types/claude-code.d.ts` | the function-hooks API, as written by Claude Code's `/plugin-types` |

**Tests**

- `tests/*.spec.ts` run under vitest: the scheduler, the band's layout at every
  width, the word packs, deck storage and the migration.
- `tests/installer.sh` runs the installer against throwaway home directories.
- `tests/*.test.ts` use Claude Code's own plugin test kit and run with
  `npm run test:kit`. The `claude plugin test` command isn't available in
  current releases yet, so these don't run today.

Two rules worth knowing before you change anything:

- **The band must always be exactly three rows tall.** A band taller than the
  space it's given scrolls, and a scrolling band ignores digit key presses. That
  would silently disable every answer. The tests measure rendered width in
  terminal columns at many sizes, not just the number of rows in the layout.
- **A failed read must never lead to a write.** If a deck, setting or pack can't
  be read, nothing is written in its place. A read failure isn't the same as an
  empty deck, and treating it as one would overwrite real progress.

A useful habit: when you add a test, break the code it covers and check the test
fails.

## Licence

MIT
