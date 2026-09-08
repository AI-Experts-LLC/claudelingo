# claudelingo

Learn a language in the dead time while Claude Code or Codex is working.

`claudelingo` is a small terminal pane you keep beside your agent. When Claude starts
thinking, it teaches you a word. When Claude needs you back, it gets out of the way.

```
┌─ claudelingo · Spanish   ● agent working ──────────────┐
│  meaning · box 1/5                                     │
│                                                        │
│  what does «tiempo» mean?                              │
│                                                        │
│  1) time          2) weather                           │
│  3) house         4) always                            │
│                                                        │
│  ████░░░░░░░░░░░░░░░░░░░░                              │
│  streak 7 · learned 42/312 · due 11 · mastered 3       │
└─ 1-4 answer / s skip / q quit ─────────────────────────┘
```

Spanish, French and Italian ship in the box — roughly the 310 most common words in
each, which is most of what you actually hear in a day. Any other language can be
generated on demand.

## Install

Inside Claude Code:

```
/plugin install AI-Experts-LLC/claudelingo
```

That is the whole install. The plugin brings its own hooks and puts its command on
PATH, so there is nothing to build, nothing to add to your PATH, and nothing to
edit. One line goes in `~/.claude/settings.json` if you want the status line —
`claudelingo init --statusline-only` writes it — because Claude Code only lets the
main config set that field, not a plugin.

Prefer not to use plugins? The standalone installer still works:

```bash
curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh
```

**No API key, ever.** Everything that needs a model — memory hooks, generating a
pack for a new language — runs through the `claude` command you already have, on
the Claude Code login and quota you are already using. claudelingo ships with no
API SDK and no credential handling of any kind.

Requirements: Node 20.11+. tmux is optional and only used to place the pane beside
you.

## What you get, without doing anything else

One command:

```bash
claudelingo start
```

Claude Code opens with the pane already beside it. Or just run `claude` as usual —
the pane opens itself, because `init` wires that up.

Then, when Claude starts working on something, the pane asks rather than assuming:

```
┌─ claudelingo · Spanish   ● agent working ──────────┐
│                                                    │
│   ,___,  Claude is working.                        │
│   (o.-)  Want a quiz?                              │
│   /)_)   3 cards ready                             │
│                                                    │
│  y  yes, go on                                     │
│  n  not now                                        │
│                                                    │
└─ y yes / n not now / q quit ───────────────────────┘
```

Say yes once and it stops asking for the rest of that pane's life. Say no and it
asks again next time Claude picks something up. A pane you opened yourself never
asks — running it was the answer.

The owl reacts as you go: asleep while Claude is idle, watching while a card is
up, pleased when you get one right, and a bit startled when you do not. It steps
aside entirely on a pane too narrow to hold it.

## A quiz in the chat

If you are not in tmux — or you just want a couple of cards where you are:

```
/lingo
```

Claude asks a card using its own multiple-choice UI, you click an answer, and the
schedule updates. It never sees which answer is right: `claudelingo next` withholds
it and `claudelingo answer` does the grading, so the answer cannot leak into the
transcript before you have replied and the deck stays the single source of truth.

It stands aside if a pane is already open — two graders writing one deck is how
progress gets lost.

## Three surfaces

Claude Code draws its own terminal UI and does not host third-party widgets, so
there is no way to put an interactive box inside it. claudelingo works around that
with two surfaces that do different jobs.

**The status line** lives *inside* Claude Code, on the row under your prompt:

```
«tiempo» = ?          42/312 · streak 7 · box 3/5
«tiempo» = time, weather   42/312 · streak 7 · box 3/5
```

It cannot take keystrokes — Claude Code renders the line, it does not forward input
to it — so it is a passive drill: the word appears alone for six seconds, giving you
a moment to retrieve the meaning, then the answer appears. Trying and then checking
is most of what makes recall stick, and it is all a display-only surface can offer.
It is installed by `init` (skip it with `--no-statusline`), refreshes on a timer
because Claude Code's own updates go quiet exactly while it is thinking, and is
strictly read-only — a running pane owns the deck, and a status line that wrote to
it would fight that pane's lock.

**The pane** is where you actually answer: multiple choice, typing, skipping,
memory hooks. That has to be a real interactive process, which means its own pane.

Use either, or both. The status line teaches while you work; the pane is where the
spaced repetition happens.

## How it decides when to quiz you

The pane only asks questions while your agent is actually working. It learns that
from the integrations `init` sets up:

| Signal | Source | Pane |
|---|---|---|
| `UserPromptSubmit`, `PreToolUse` | Claude Code hook | starts quizzing |
| `Stop`, `SubagentStop`, `SessionEnd` | Claude Code hook | stands down |
| `Notification` | Claude Code hook | stands down |
| a user turn appearing in the rollout transcript | Codex | starts quizzing |
| `agent-turn-complete` | Codex `notify` | stands down |

`Notification` is deliberately on the stand-down side: Claude fires it when it wants
a permission decision, and that is exactly when you should be looking at Claude
rather than at a vocabulary card.

Codex has no "turn started" hook, so claudelingo tails the newest rollout transcript
under `~/.codex/sessions` for that edge. The scan is cached on directory mtimes, so a
long Codex history costs nothing to sit next to — idle cost is flat rather than
growing with the number of transcripts you have accumulated. Transcripts that already exist when the pane
opens are skipped to their end, so yesterday's session can never set it off; a
transcript that *appears* afterwards is a live session and is read from its first
line, because Codex writes the session header and your first message together. Each
transcript keeps its own read position, so two sessions alternating never replay
turns you have already seen.

If a session is killed mid-turn its `Stop` hook never fires. A `busy` older than
fifteen minutes is treated as idle, so the pane can't get stuck quizzing forever.

Press `p` at any time to practise regardless of what your agent is doing.

## How it teaches

Every word walks the same ramp, and only moves up when you get it right:

1. **New word** — shown, not asked. Term, gloss, gender, and where it sits in the
   frequency list.
2. **Meaning** (boxes 1–2) — the word, four English glosses.
3. **Translate** (boxes 3–4) — the English, four words in the target language.
4. **Spell it** (box 5) — the English, and you type the word. Accents and case are
   forgiven; the spelling is not.

Scheduling is Leitner-style with two tiers: short steps of 1 minute, 10 minutes and
an hour while a word is still `learning`, then 1, 3, 7, 16 and 35 days once it
graduates to `review`. A wrong answer drops the word one box and sends it back
through the short steps — it never wipes your history.

At most 8 words are in flight at once and at most 20 new ones per day, so a long
afternoon of agent-watching builds a real deck instead of a flood you forget.
Skipping (`s`) costs nothing: it defers the word for ten minutes without touching the
box, and works on a word you have not been taught yet. While you are typing an answer,
`Esc` clears it and a second `Esc` skips the card.

## Memory hooks

Press `e` on any card to ask Claude for a memory hook — a cognate, an etymology, or
a vivid image — plus a one-line example sentence. Answers are cached on disk, so a
word is only ever paid for once.

This runs through the `claude` command in print mode, on the Claude Code login you
already have. There is no API key to set up and no second bill. If `claude` is not
on your PATH the pane says so once, on startup, and does not offer `e` at all;
everything else still works. `--no-enrich` turns it off entirely.

## Other languages

```bash
claudelingo pack generate --lang Portuguese --code pt --count 300
claudelingo --lang pt
```

The code matters. It names both the pack and the progress file, so claudelingo
refuses a code that a bundled pack already uses (`--lang Estonian` would otherwise
default to `es` and quietly leave you studying Spanish), and refuses to replace an
existing generated pack unless you pass `--overwrite` — progress is keyed by
position, so replacing a pack in place re-attaches box levels earned on one language
to whatever word now sits at each rank.

The pack is generated through your Claude Code session, validated, and written to
`~/.claudelingo/packs/pt.json`. Packs are plain JSON and hand-editable:

```json
{
  "code": "pt",
  "name": "Português",
  "englishName": "Portuguese",
  "words": [
    ["de", "of, from", "prep"],
    ["casa", "house", "noun", "feminine"]
  ]
}
```

Entries are `[term, gloss, pos, note?]`, ordered most frequent first. Control
characters are stripped on load, because a newline in a gloss would turn the status
line into two lines inside Claude Code's UI and a raw escape would restyle
everything after it. Two further rules the loader enforces: no duplicate terms, and — because a translate card shows only the
gloss — no two words may share a gloss. Where two words genuinely collide, put the
distinction in the gloss itself (`"to be (permanent)"` vs `"to be (state, place)"`).

## Commands

```
claudelingo start [args]         start Claude Code with the pane beside it
claudelingo                      open the companion pane on its own
claudelingo init [--project]     install the Claude Code + Codex integrations
claudelingo uninit [--project]   remove them again
claudelingo hook <event>         report agent state (called by the hooks)
claudelingo notify [json]        Codex notify target
claudelingo status               show the current agent state
claudelingo statusline           the line Claude Code draws (it calls this)
claudelingo stats                show your progress
claudelingo langs                list installed word packs
claudelingo pack generate        build a pack for another language
claudelingo reset --yes          erase progress for the current language
```

Options: `--lang <code>`, `--always-on`, `--ask` / no `--ask`, `--no-enrich`,
`--no-color`, `--width <n>` (20–1000; anything else is ignored with a warning),
`--model <id>`. For `init`: `--no-statusline`, `--no-auto-pane` / `--auto-pane`.

`init` exits non-zero if either integration fails to install, so a pane that will
never wake up is not reported as a success.

## Keys

| Key | |
|---|---|
| `1`–`4` | answer a multiple-choice card |
| type + `Enter` | spell a word out |
| `space` | continue to the next card |
| `s` | skip, without penalty |
| `e` | ask Claude for a memory hook |
| `p` | practise even when the agent is idle |
| `Esc` | clear a typed answer; again to skip the card |
| `q` / `Ctrl-C` | quit |
| `?` | help |

While you are typing an answer, letters go into the input — `q` does not quit
mid-word.

## Where things live

Everything sits under `~/.claudelingo` (override with `CLAUDELINGO_HOME`):

```
settings.json        your language and preferences
status.json          the current agent state, written by the hooks
progress-<lang>.json your deck
progress-<lang>.lock held by the running pane, so a second one cannot clobber it
packs/               generated word packs
cache/               memory hooks already fetched
```

Progress is written after every answer to a temp file that is flushed and renamed, so
quitting — or a crash, or a power cut — never costs you more than the card on screen.

Three rules protect that file.

**A deck that cannot be parsed is moved aside, never overwritten** — you get a
`progress-es.json.corrupt-<timestamp>` copy and the pane tells you where it went.

**A deck that cannot be read is left exactly where it is.** The distinction is not
which error came back but whether the *read* failed or the *content* did — a
permission error, a full file-descriptor table, or a stale handle on a networked home
says nothing about what is in the file. In that case the pane runs read-only and saves
nothing rather than replacing a deck that is almost certainly fine; fix the problem and
restart to resume saving. Read-only commands like `stats` never move a deck aside at all.

`claudelingo reset` takes the same lock the pane does, so it cannot report success
while an open pane is about to write its deck straight back over the top.

**Only one pane at a time may study a given language.** Two panes each hold the whole
deck in memory, so the second to save would erase the first's work. The lock is written
with its owner's pid already inside it and then linked into place, so it can never
exist naming nobody — a lock that does is refused rather than reclaimed, because
guessing wrong there deletes a live pane's lock. Run a second pane on a different
`--lang` instead. A lock left behind by a crashed pane is reclaimed automatically, and
the refusal message names the lock file in case a recycled pid ever makes it look
occupied. If the lock cannot be taken at all, the pane says so rather than quietly
dropping the guarantee.

Anything that goes wrong is shown in red and stays on screen until it is actually
fixed — a failing save, a Codex watcher that has gone blind, an unreadable
`status.json`, a missing credential, a lock that could not be taken. Each is tracked
separately, so one clearing never hides another, and each clears itself when its own
condition resolves. The pane keeps running rather than crashing out and leaving your
terminal in raw mode. If stdout is not a terminal there is no panel to draw on, so
startup problems go to stderr instead of vanishing.

## Development

```bash
npm install
npm run build
npm test           # unit + end-to-end
npm run test:unit
npm run test:e2e
npm run typecheck
```

The end-to-end tests spawn the real binary and drive it over pipes, firing genuine
hook events, appending to a genuine Codex transcript, revoking write permission on the
home directory, and serving memory hooks from a local stub HTTP server — then assert on
the frames a user would see. `CLAUDELINGO_FORCE_RENDER=1` makes the pane paint without a
TTY and `CLAUDELINGO_SEED` fixes the shuffle, which is what makes those assertions
stable.

Panel width is measured in terminal **columns**, not code points, so a generated CJK
pack cannot tear the border. The width tables are generated from the Unicode
character database rather than hand-listed, and checked against it. `test/unit/width.test.ts` checks that against an
independent expected-column table rather than the renderer's own measure — otherwise
the assertion cannot fail.

That principle is applied throughout: several behaviours here are pinned by tests
written specifically so that deleting the behaviour makes them fail. If you change
something load-bearing, break it on purpose first and check the suite notices.

## Licence

MIT
