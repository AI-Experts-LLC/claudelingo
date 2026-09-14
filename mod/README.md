# claudelingo, as a mod

The quiz, inside Claude Code, answered with a digit.

```
 ,___,  What does "tiempo" mean?
 (o.o)  1: time   2: weather   3: house   4: always
 /)_)   box 1/5   5: skip   6: explain
```

Press `1`. That is the whole interaction, and it is the whole reason this
exists.

## Why there is a second claudelingo

The CLI version of claudelingo is good at teaching you a language in the dead
time while Claude works. Most of its code, though, is not about teaching — it is
about reaching around Claude Code, because until function hooks there was no way
to reach into it. Its own README says so plainly:

> Claude Code draws its own terminal UI and does not host third-party widgets,
> so there is no way to put an interactive box inside it.

So the CLI ships three surfaces instead of one. A status-line panel that can
draw but never take a key, whose bottom row is therefore a list of slash
commands — `/lingo 2` to answer a question already on your screen. A `/lingo`
skill that asks through a tool dialog. And a tmux pane, which is the only one of
the three that takes a keypress, and which needs a second terminal to live in.

A mod needs one surface, because the band above the prompt can hold a `Button`
and a bare digit presses one from an empty composer.

That removes four whole subsystems:

| The CLI does this | The mod |
|---|---|
| Installs `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionEnd` and `Notification` hooks that write a `status.json` it reads back; treats a `busy` older than fifteen minutes as idle in case a session was killed mid-turn; tails the newest rollout transcript under `~/.codex/sessions` because Codex has no turn-started hook | `e.props.isWorking`, handed to the band on every draw |
| Three surfaces, one of which needs tmux, because none of them can both draw and listen | One band that does both |
| A lock file per language (two panes each hold the whole deck, so the second to save erases the first), an atomic write per answer, a corrupt deck moved aside with a timestamp | `$.store` |
| Spawns `claude -p`, finds the binary on `PATH`, says so once at startup when it is missing, hides the `e` key when it is | `$.model.complete`, on the session's own credentials |

What is left is what claudelingo was always actually about: the scheduler, the
words, and the owl.

## Install

Function hooks are early access, so the mod loads only where they are enabled:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir mod
```

Without that variable the hooks module is ignored entirely and nothing appears —
that is the flag doing its job, not a broken install.

The first band you see asks which language, with a digit per answer. It never
asks again.

## The keys

Every hotkey is a digit, and that is a constraint rather than a taste. In the
band a bare digit presses from an empty composer with nothing focused — which is
what makes an answer cost one keystroke. A letter presses only once one of the
band's Buttons already has the focus, which is a chord and a hunt.

| Key | |
|---|---|
| `1`–`4` | answer a multiple-choice card |
| `1` | acknowledge a new word, or move past a verdict |
| `5` | skip, without penalty — the word comes back in ten minutes |
| `6` | ask the model for a memory hook |
| type + `Enter` | spell a word out, on a card that asks you to |

Everything the band cannot say in three rows is on `/lingo`:

| | |
|---|---|
| `/lingo` or `/lingo stats` | where you stand |
| `/lingo lang` | the languages you have; `/lingo lang fr` switches |
| `/lingo practise` | quiz me now, even though Claude is idle |
| `/lingo off` / `on` | clear the band without uninstalling |
| `/lingo pack Portuguese` | build a pack for a language it does not ship |
| `/lingo reset` | erase this language's deck, after asking |

## How it behaves

**It teaches while Claude thinks and stands down when Claude needs you.** A card
goes up only while a turn is running. When the turn completes the card comes
down, because it was put up for the dead time and the dead time is over.
`Notification` needed special handling in the CLI — Claude fires it when it wants
a permission decision, which is exactly when you should be looking at Claude
rather than at a vocabulary card — and here it needs none, because a turn waiting
on you is not a turn running.

**It is always exactly three rows.** Two reasons, and the second is the sharp
one. Three rows means the conversation above never jumps as a card comes and
goes. And a band taller than the rows it is given scrolls in a window — at which
point, in the engine's words, "a bare digit arms none of its Buttons' hotkeys". A
fourth row would not look wrong. It would silently turn every answer key off. So
the height is pinned by a test, per branch, and the band draws nothing at all
where it has not been given three rows to be pressable in.

**Nothing reaches the model that you did not press for.** The band is drawn by a
render hook and graded in the plugin's own environment. No card, no answer and no
verdict is ever written to the transcript, so a session's context costs the same
whether you are learning Spanish or not. The CLI has a careful dance for this —
`claudelingo next` withholds the right answer so it cannot leak into the
transcript before you have replied — and here there is nothing to withhold from.

**The owl still blinks.** It is asleep while Claude is idle, watching while a
card is up, pleased when you get one right, a bit startled when you do not, and
it steps aside on a band too narrow to hold it.

## Where things live

`$.store`, which the engine owns:

```
claudelingo:settings:v1        your language and preferences
claudelingo:progress:v1:<lang> your deck, one per language
claudelingo:hook:v1:<word>     a memory hook already paid for
claudelingo:pack:v1:<code>     a generated word pack
claudelingo:packs:v1           the index of generated packs
```

Two rules survive the move off the filesystem, because they were never really
about files — they are about the difference between *the read failed* and *what
came back is not a deck*:

- **A read that failed** says nothing about what is in the store, so the band
  runs read-only and saves nothing rather than writing a fresh deck over one
  that is almost certainly fine.
- **A value that is not a deck** is moved to `<key>:quarantine` before anything
  is written over it, and the band says where it went.

A deck also carries its own language, and one that does not match is quarantined
rather than accepted — otherwise a French deck read under `es` would miss on
every word id and silently become an empty Spanish deck that still claims a
streak.

## Shared with the CLI, not copied from it

A hooks module has no filesystem and no Node, so it cannot read
`src/packs/*.json` at startup and cannot import across the package boundary. The
words and the scheduler therefore exist twice — and a second copy of a scheduler
means two claudelingos disagreeing about when a word is due, while a second copy
of a pack means progress keyed by rank pointing at different words on each side.

So they are generated, never edited:

```bash
npm run mod:restate            # restate src/ under mod/hooks/
npm run mod:restate -- --check # fail instead, if it is stale
```

`src/` is the one source. The port is an import rewrite and nothing else;
anything that needs real changes is a hand-written module of the mod's own,
where it can be read as what it is.

Pack generation went the other way. It is the most hard-won code in the
repository — every comment in it records a real run that went wrong, from a
truncated reply losing 693 words of French to a model that, asked to fill a quota
past the point where it knows the frequency order, starts reciting the dictionary
alphabetically. Rather than copy it, `src/packgen.ts` was extracted to take an
injected asker: `claude -p` for the CLI, `$.model.complete` for the mod. Both
call the same generator.

## Developing

```bash
npm run mod:typecheck   # tsc against the real declarations in mod/types
npm run mod:validate    # claude plugin validate
npx vitest run mod/tests
```

Two test suites, deliberately different suffixes:

- **`mod/tests/*.spec.ts`** run under vitest today. They check the band's tree —
  that options are Buttons, that they carry the digits, that pressing one reaches
  the action, that the height holds in every branch — and the deck's behaviour
  when the store misbehaves.
- **`mod/tests/*.test.ts`** are written against `claude-code/testing` and run
  with `claude plugin test mod`. They drive the band the way a person does:
  `$.ui.press` presses a Button the band actually rendered, through every hook,
  and the deck that comes out is the one the engine's own store holds.

`mod/types/claude-code.d.ts` is what `/plugin-types` wrote for the Claude Code
version named on its first line. Regenerate it with that command after an update
rather than editing it.

## Early access

Hooks modules load only where function hooks are enabled, and the API this is
written against may change between releases without notice. The CLI is not going
anywhere: it is the one that works in Codex, in a plain terminal, and in a
version of Claude Code without function hooks.
