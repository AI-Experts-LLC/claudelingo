---
name: lingo
description: Run a short vocabulary quiz with the user, in the conversation. Use when the user types /lingo, or asks to practise, revise, be quizzed, or do some flashcards in their language. Also use when they ask how their vocabulary practice is going.
---

# A quiz, in the chat

The user is learning a language with claudelingo. This runs a few cards without
them leaving the conversation.

The commands below own the schedule and the grading. Your job is to ask the
question and pass back what the user picked — nothing more. **You are not told
which answer is correct**, deliberately: it keeps the answer out of the
transcript before they have replied, and keeps the spaced-repetition schedule the
single source of truth.

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
- A different language: pass `--lang <code>` to any of these; `claudelingo langs`
  lists what is installed.

## Keep it short

This runs while they are in the middle of something else. One line per card, no
preamble, no summaries of what you are about to do. Stop as soon as they say so,
and never start a round they did not ask for.
