# claudelingo

Learn a language in the dead time while Claude is working.

claudelingo is a Claude Code **mod**: a quiz in the band above your prompt,
answered with a digit. When Claude starts thinking, it teaches you a word. When
Claude needs you back, it gets out of the way.

```
 ,___,  What does "tiempo" mean?
 (o.o)  1: time   2: weather   3: house   4: always
 /)_)   5: skip   6: explain   box 1/5
```

Press `1`. That is the whole interaction.

Spanish, French and Italian ship in the box — roughly the 310 most common words
in each, which is most of what you actually hear in a day. Any other language
can be generated on demand.

## Install

Function hooks are early access, so the mod loads only where they are enabled:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/claudelingo
```

Or add the repo as a marketplace and install from it:

```
/plugin marketplace add AI-Experts-LLC/claudelingo
/plugin install claudelingo@claudelingo
```

Without that variable the hooks module is ignored entirely and nothing appears —
that is the flag doing its job, not a broken install.

The first band you see asks which language, with a digit per answer. It never
asks again.

**No API key, ever.** Memory hooks and generated packs run through
`$.model.complete`, on the Claude Code login and quota you already have.

## Two ways a card gets in front of you

**The band decides.** While a turn is running it puts a card up, because that is
the dead time this exists to fill. When the turn ends the card comes down.

**You decide.** Press `1` on the idle band, or run `/lingo quiz`, and you get a
bounded run of five cards right where you are — whether or not Claude is doing
anything:

```
 ,___,  What does "el" mean?
 (o.o)  1: the (f. pl.)  2: a (f.)  3: the (m.)  4: the (f.)
 /)_)   5: skip   6: explain   2/5
```

It counts down, carries on across a prompt you send, and ends with a score
instead of trailing off:

```
 ,___,  Quiz done — 4 of 5 right
 (o.o)  wrong ones come back sooner; right ones come back later.
 /)_)   1: again   5: done
```

Cards that introduce a word are shown rather than asked, so they count towards
the run but never towards the score — five new words is not nought out of five.
`/lingo quiz 20` asks for more; fifty is the cap, because a run keeps asking
until it is done.

## The keys

Every hotkey is a digit, and that is a constraint rather than a taste. In the
band a bare digit presses from an empty composer with nothing focused — which is
what makes an answer cost one keystroke. A letter presses only once one of the
band's Buttons already has the focus, which is a chord and a hunt.

| Key | |
|---|---|
| `1` | start a quiz, when the band is idle |
| `1`–`4` | answer a multiple-choice card |
| `1` | acknowledge a new word, or move past a verdict |
| `5` | skip, without penalty — the word comes back in ten minutes |
| `6` | ask the model for a memory hook |
| type + `Enter` | spell a word out, on a card that asks you to |
| `1` / `5` | at the score: go again, or put it away |

Everything the band cannot say in three rows is on `/lingo`:

| | |
|---|---|
| `/lingo quiz [n]` | a quiz, right now — five cards unless you say otherwise |
| `/lingo` or `/lingo stats` | where you stand |
| `/lingo lang` | the languages you have; `/lingo lang fr` switches |
| `/lingo practise` | keep asking while Claude is idle, without a fixed length |
| `/lingo off` / `on` | clear the band without uninstalling |
| `/lingo pack Portuguese pt` | build a pack for a language it does not ship |
| `/lingo reset` | erase this language's deck, after asking |

## How it teaches

Every word walks the same ramp, and only moves up when you get it right:

1. **New word** — shown, not asked. Term, gloss, gender, and where it sits in
   the frequency list.
2. **Meaning** (boxes 1–2) — the word, four English glosses.
3. **Translate** (boxes 3–4) — the English, four words in the target language.
4. **Fill the gap** (box 4, where the word has a sentence) — the word in
   context, which is most of what "knowing" it means.
5. **Spell it** (box 5) — the English, and you type the word. Accents and case
   are forgiven; the spelling is not.

Scheduling is Leitner-style with two tiers: short steps of 1 minute, 10 minutes
and an hour while a word is still `learning`, then 1, 3, 7, 16 and 35 days once
it graduates to `review`. A wrong answer drops the word one box and sends it
back through the short steps — it never wipes your history.

At most 8 words are in flight at once and at most 20 new ones per day, so a long
afternoon of agent-watching builds a real deck instead of a flood you forget.

## How it behaves

**It teaches while Claude thinks and stands down when Claude needs you.** A card
goes up only while a turn is running. When the turn completes the card comes
down, because it was put up for the dead time and the dead time is over. A quiz
you asked for is the exception: it is bounded, so it finishes where it said it
would.

**It is always exactly three rows.** Two reasons, and the second is the sharp
one. Three rows means the conversation above never jumps as a card comes and
goes. And a band taller than the rows it is given scrolls in a window — at which
point, in the engine's words, "a bare digit arms none of its Buttons' hotkeys".
A fourth row would not look wrong. It would silently turn every answer key off.

Which makes *how* the height is measured the whole game. Counting the rows you
wrote is not enough: `Text` wraps, so three parts that each fit the body width
can still exceed it together, and then one row is two on screen while the tree
still looks like three. An early version did exactly that and overflowed at
ordinary terminal widths. So every composite row is budgeted as a row by
`hooks/views/row.ts`, and the tests measure rendered cells — every state, at a
dozen widths, including a pack with 200-character glosses and one written in
double-width CJK.

**Nothing reaches the model that you did not press for.** The band is drawn by a
render hook and graded in the plugin's own environment. No card, no answer and
no verdict is ever written to the transcript, so a session's context costs the
same whether you are learning Spanish or not.

**The owl still blinks.** Asleep while Claude is idle, watching while a card is
up, pleased when you get one right, a bit startled when you do not, and it steps
aside on a band too narrow to hold it.

## Where things live

`$.store`, which the engine owns — one JSON file per plugin under your Claude
Code configuration directory, at the user level rather than per project, so your
deck follows you between repos:

```
claudelingo:settings:v1        your language and preferences
claudelingo:progress:v1:<lang> your deck, one per language
claudelingo:hook:v1:<word>     a memory hook already paid for
claudelingo:pack:v1:<code>     a generated word pack
claudelingo:packs:v1           the index of generated packs
claudelingo:migrated:v1        when the old CLI's decks were read in
```

One rule runs through all of it: **a read that failed authorises no write.** It
applies to the deck, the settings, a word pack and the pack index, and it turns
on the difference between *the read failed* and *what came back is not what we
expected*:

- **A read that failed** says nothing about what is in the store, so the band
  runs read-only and saves nothing rather than writing a fresh deck over one
  that is almost certainly fine.
- **A value that is not a deck** is moved to `<key>:quarantine` before anything
  is written over it, and the band says where it went.

A deck also carries its own language, and one that does not match is quarantined
rather than accepted — otherwise a French deck read under `es` would miss on
every word id and silently become an empty Spanish deck that still claims a
streak. The settings get the same treatment, and there the defaults are the
danger: a failed read that fell back to them would show the language picker to
someone who chose a year ago, bring the band back for someone who ran
`/lingo off`, and then save all of that over the real settings on the first
press.

Errors are pinned under the prompt with `$.ui.status` rather than drawn in the
band. The band is three rows and the third is the controls, so an error that
took a row would delete the very keys needed to clear it — a trap, not a
message. `/lingo stats` lists all of them; the pinned line shows the most
serious.

## Coming from the version that was a CLI

claudelingo used to be a terminal program: a tmux pane, a status-line panel, a
`/lingo` skill, five hook events writing a `status.json` it read back to guess
whether the agent was working, a Codex transcript tailer, a lock file per
language, and a `claude -p` subprocess whenever it needed a model. All of that
existed to reach *around* Claude Code, because until function hooks there was no
way to reach into it.

It is gone. `e.props.isWorking` answers the first, a `Button` answers the
second, `$.store` the third, `$.model.complete` the last.

**Your deck comes with you.** The first session reads `~/.claudelingo` and
imports every `progress-<lang>.json` it finds, along with the language you were
studying — box levels, due dates, streak and accuracy intact. It copies rather
than moves, so the old files stay where they are. A deck already in the store
wins, because anything answered here is newer than a file written before this
was installed and two schedules for one word cannot be merged honestly.

It runs once, and says what it found — but *once* is why the next part matters.

### Turn the old one off first

The old install does not remove itself, and this version has deleted the command
that used to (`claudelingo uninit`). Until you remove it by hand you have two
claudelingos running: the mod above your prompt, and the old status-line panel
below it, each writing its own deck. Because the import runs once, every answer
you give through the old panel after that first session is invisible to the mod
for ever.

Open `~/.claude/settings.json` and delete:

- the `"statusLine"` block, if its `command` **ends in** `claudelingo
  statusline` — a plugin-style install wrote an absolute path there, so it may
  read `"/long/path/bin/claudelingo" statusline` rather than the bare name
- every hook entry whose command mentions `claudelingo` — there are six, under
  `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionEnd` and
  `Notification`

Then remove the old program itself:

```bash
npm rm -g claudelingo            # if you installed it from npm
rm -rf ~/.claudelingo/src        # if you used the curl installer
rm -f ~/.local/bin/claudelingo   # the symlink that installer left on your PATH
```

Leave `~/.claudelingo/progress-*.json` alone until the import has run; after
that they are only a backup.

If you would rather keep the old one for now, that is fine — but run
`/lingo stats` after your first mod session and check the numbers match what the
panel was showing, because from then on the two decks drift apart.

What is not coming back: **Codex support**. The pane watched Codex rollout
transcripts so it could quiz you while Codex worked. A mod is a Claude Code
plugin and there is no equivalent hook, so that went with the CLI.

## Developing

```bash
npm install
npm run check      # typecheck + validate + tests
npm run typecheck  # tsc against types/claude-code.d.ts
npm run validate   # claude plugin validate .
npm test           # vitest
```

Two test suites, deliberately different suffixes:

- **`tests/*.spec.ts`** run under vitest today. They cover the scheduler, the
  width tables, the pack generator, the deck's behaviour when the store
  misbehaves, the migration, the 933 shipped words and the owl's fixed size, and
  the band's tree — that options are Buttons, that they carry the digits, that
  pressing one reaches the action, and that the height holds in every branch at
  every width.
- **`tests/*.test.ts`** are written against `claude-code/testing` and run with
  `npm run test:kit` (`claude plugin test .`). They drive the band the way a
  person does: `$.ui.press` presses a Button the band actually rendered, through
  every hook, and the deck that comes out is the one the engine's own store
  holds.

  **These have never been executed.** `claude plugin test` does not exist in
  Claude Code 2.1.271, the build they were written against — the command errors
  with `unknown command 'test'`. They typecheck against the real declarations
  and they are the right tests, but until that runner ships they are unverified,
  and the `*.spec.ts` files are what actually guards this. (There is no CI in
  this repo yet either, so "guards" means `npm run check` before you push.)

`types/claude-code.d.ts` is what `/plugin-types` wrote for the Claude Code
version named on its first line. Regenerate it with that command after an update
rather than editing it.

Several behaviours here are pinned by tests written specifically so that
deleting the behaviour makes them fail. If you change something load-bearing,
break it on purpose first and check the suite notices — twice during this
project a test passed with the bug deliberately reinstated, and both times that
check was the only thing that caught it.

## Early access

Hooks modules load only where function hooks are enabled, and the API this is
written against may change between releases without notice. That is the bet this
version makes: there is no longer a fallback that works without them.

## Licence

MIT
