---
name: lingo
description: Run a vocabulary quiz with the user in the conversation, and act on what the claudelingo panel under their prompt is showing. Use when the user types /lingo (with or without an argument such as a number, ok, skip, stats, or a language code), or asks to practise, revise, be quizzed, or do some flashcards in their language. Also use when they ask how their vocabulary practice is going, or to change the language they are learning.
---

# A quiz, in the chat

The user is learning a language with claudelingo. This runs a few cards without
them leaving the conversation.

The commands below own the schedule and the grading. Your job is to ask the
question and pass back what the user picked — nothing more. **You are not told
which answer is correct**, deliberately: it keeps the answer out of the
transcript before they have replied, and keeps the spaced-repetition schedule the
single source of truth.

## The argument decides what to do

`/lingo` is the whole control surface: the panel under the user's prompt names
these, so they arrive here already typed. Match the argument first, and only fall
through to a new card when there is none.

| They type | Do this |
|---|---|
| `/lingo` | Deal a card — the round below |
| `/lingo quiz me`, `quiz`, `card`, `go` | Deal a card. The panel prints `/lingo quiz me` as its own hint, so this arrives often |
| `/lingo 1`…`/lingo 9` | `claudelingo answer --choice N` — grade the **outstanding** card, do not deal a new one first |
| `/lingo ok` (or `got it`, `next`) | `claudelingo answer --choice 1` — acknowledge a `teach` card |
| `/lingo skip` | `claudelingo skip` |
| `/lingo stats` | `claudelingo stats` |
| `/lingo lang` | `claudelingo lang` — report, and list what is installed |
| `/lingo lang fr`, `/lingo fr` | `claudelingo lang fr` |
| `/lingo off` / `/lingo on` | `claudelingo panel off` / `claudelingo panel on` |
| `/lingo help` | List these, briefly |
| anything else, **and only while a card is outstanding** | Treat it as a typed answer: `claudelingo answer --text "<what they typed>"` |
| anything else, with nothing outstanding | Deal a card |

A bare number always means "grade what is outstanding". Dealing a card first
would throw away the question they are looking at and answer a different one.

The catch-all is the dangerous row: everything above it must be matched first.
Sending `quiz me` to the grader marks the outstanding card wrong, costing a box
level and a streak, and the user asked for the opposite. When in doubt about a
word that is not in this table, deal a card rather than grade one — dealing is
recoverable, grading is not.

After grading, say the one-line outcome and stop. Do not automatically deal the
next card when they answered with an argument — they are in the middle of
something else, and the panel already shows what is next.

## One round

1. Get a card:

   ```bash
   claudelingo next --json
   ```

2. Read the JSON:
   - `error` — say what it says and stop. If it mentions a pane being open, tell
     them to answer in that pane instead.
   - `done` — nothing is due. Say so, mention `stats.learned` of `stats.total`,
     and stop.
   - `card` — ask it.

3. Ask the question with **AskUserQuestion**, using `card.question` as the
   question and `card.choices` as the options, in the order given. Do not reorder
   them, do not add options, and do not hint. If `card.choices` is empty the card
   wants a typed answer: ask it as an open question in your own message instead.

4. Send the result back. For a multiple-choice card, `--choice` is the 1-based
   position of the option they picked:

   ```bash
   claudelingo answer --choice 2
   ```

   For a typed answer:

   ```bash
   claudelingo answer --text "tiempo"
   ```

5. Report the outcome from the reply in one short line: whether it was `correct`,
   the `term` and its `gloss`, and the `note` if there is one. Then offer another
   card unless they said to stop.

A `teach` card has no choices and no right answer — it is an introduction. Show
the word and its meaning, then call `claudelingo answer --choice 1` to mark it
seen and move on.

## Other things they might ask for

- Progress: `claudelingo stats`
- A different language: `claudelingo lang <code>` changes it for good;
  `claudelingo lang` lists what is installed. A one-off card in another language
  is `--lang <code>` on a single command instead.
- The panel under their prompt: `claudelingo panel on|off`.

Every one of these refuses politely while a pane is open, because that pane owns
the deck. Pass the refusal on rather than working around it.

## Keep it short

This runs while they are in the middle of something else. One line per card, no
preamble, no summaries of what you are about to do. Stop as soon as they say so,
and never start a round they did not ask for.
