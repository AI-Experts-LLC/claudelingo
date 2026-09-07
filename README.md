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

```bash
npm install -g claudelingo
claudelingo init
```

`init` writes hooks into `~/.claude/settings.json` and a `notify` entry into
`~/.codex/config.toml`. It merges into whatever is already there, backs the Codex
config up first, and is safe to run twice; `claudelingo uninit` takes it all back
out and leaves everyone else's entries alone.

Codex allows only one `notify` program. If you already have one, `init` says so and
changes nothing rather than silently disabling your tooling. It exits non-zero if
either integration fails to install — a pane that never wakes up is otherwise very
hard to diagnose.

Then open the pane in a second terminal, or a split pane next to your agent:

```bash
claudelingo --lang es
```

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
under `~/.codex/sessions` for that edge. Transcripts that already exist when the pane
opens are skipped to their end, so yesterday's session can never set it off; a
transcript that *appears* afterwards is a live session and is read from its first
line, because Codex writes the session header and your first message together.

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
word is only ever paid for once. This uses **Claude Fable 5.1** (`claude-fable-5-1`)
at low effort, with a server-side fallback so a policy refusal is rescued inside the
same call rather than surfacing as a blank.

It needs a credential — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an
`ant auth login` profile. Without one the pane says so once, on startup, instead of
producing an auth error on every card; everything else still works. Run with
`--no-enrich` to turn the prompt off entirely.

## Other languages

```bash
claudelingo pack generate --lang Portuguese --code pt --count 300
claudelingo --lang pt
```

The pack is generated by the same model under a JSON schema, validated, and written
to `~/.claudelingo/packs/pt.json`. Packs are plain JSON and hand-editable:

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

Entries are `[term, gloss, pos, note?]`, ordered most frequent first. Two rules the
loader enforces: no duplicate terms, and — because a translate card shows only the
gloss — no two words may share a gloss. Where two words genuinely collide, put the
distinction in the gloss itself (`"to be (permanent)"` vs `"to be (state, place)"`).

## Commands

```
claudelingo                      open the companion pane
claudelingo init [--project]     install the Claude Code + Codex integrations
claudelingo uninit [--project]   remove them again
claudelingo hook <event>         report agent state (called by the hooks)
claudelingo notify [json]        Codex notify target
claudelingo status               show the current agent state
claudelingo stats                show your progress
claudelingo langs                list installed word packs
claudelingo pack generate        build a pack for another language
claudelingo reset --yes          erase progress for the current language
```

Options: `--lang <code>`, `--always-on`, `--no-enrich`, `--no-color`,
`--width <n>`, `--model <id>`.

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

Two rules protect that file. A deck that cannot be parsed is **moved aside**, never
overwritten: you get a `progress-es.json.corrupt-<timestamp>` copy and the pane tells
you where it went. And only one pane at a time may study a given language, because two
would each hold the whole deck in memory and the second to save would erase the first's
work — run a second pane on a different `--lang` instead.

If the pane cannot write at all (read-only home, full disk) it says so in red and keeps
running rather than crashing out and leaving your terminal in raw mode.

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
pack cannot tear the border. `test/unit/width.test.ts` checks that against an
independent expected-column table rather than the renderer's own measure — otherwise
the assertion cannot fail.

## Licence

MIT
