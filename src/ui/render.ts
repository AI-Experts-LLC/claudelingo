import { MAX_BOX, cardKindForBox } from "../srs.js";
import type { Pack } from "../types.js";
import { ANSI_PATTERN, ansi } from "./ansi.js";
import { sliceToWidth, stringWidth } from "./width.js";
import { type AppState, isActive, summary } from "./app.js";

export interface Theme {
  reset: string;
  dim: string;
  bold: string;
  green: string;
  red: string;
  cyan: string;
  yellow: string;
}

export const COLOR: Theme = {
  reset: ansi.reset,
  dim: ansi.dim,
  bold: ansi.bold,
  green: ansi.green,
  red: ansi.red,
  cyan: ansi.cyan,
  yellow: ansi.yellow,
};

/** Used by tests and by `--no-color`, so frames can be asserted as plain text. */
export const PLAIN: Theme = {
  reset: "",
  dim: "",
  bold: "",
  green: "",
  red: "",
  cyan: "",
  yellow: "",
};

/** Terminal columns a rendered string occupies, ignoring colour sequences. */
export function visibleWidth(text: string): number {
  return stringWidth(text.replace(ANSI_PATTERN, ""));
}

function padTo(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** Hard-wrap on word boundaries; a token longer than the line is split. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
      while (visibleWidth(line) > width) {
        const head = sliceToWidth(line, width);
        lines.push(head.text);
        line = line.slice(head.text.length);
      }
    }
    lines.push(line);
  }
  return lines;
}

function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "";
  const plain = text.replace(ANSI_PATTERN, "");
  const cut = sliceToWidth(plain, width - 1);
  // A wide glyph may leave a column short of the ellipsis; pad it back.
  return `${cut.text}${" ".repeat(width - 1 - cut.width)}…`;
}

/** Draw the panel border around already-composed content lines. */
export function box(
  content: string[],
  options: { width: number; title: string; footer: string; theme: Theme },
): string[] {
  const { width, title, footer, theme } = options;
  const inner = Math.max(10, width - 2);
  const dim = (s: string) => `${theme.dim}${s}${theme.reset}`;

  const capLine = (label: string) => {
    const text = truncate(label, Math.max(1, inner - 4));
    const used = visibleWidth(text) + 3; // leading "- " plus a trailing space
    const fill = Math.max(0, inner - used);
    return `${dim("─ ")}${text}${dim(` ${"─".repeat(fill)}`)}`;
  };

  const lines: string[] = [];
  lines.push(`${dim("┌")}${capLine(title)}${dim("┐")}`);
  for (const line of content) {
    lines.push(`${dim("│")}${padTo(truncate(line, inner), inner)}${dim("│")}`);
  }
  lines.push(`${dim("└")}${capLine(footer)}${dim("┘")}`);
  return lines;
}

function relative(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const KIND_LABEL: Record<string, string> = {
  recognize: "meaning",
  reverse: "translate",
  recall: "spell it",
  teach: "new word",
};

const DOT = " · ";

/**
 * Stats, most important first. Narrow panes drop entries off the end rather than
 * letting the line get truncated mid-word by the border.
 */
function statusLine(state: AppState, pack: Pack, theme: Theme, width: number): string {
  const s = summary(pack, state);
  const parts = [
    `streak ${s.streak}`,
    `learned ${s.learned}/${s.total}`,
    `due ${s.due}`,
    `mastered ${s.mastered}`,
  ];
  if (s.accuracy > 0) parts.push(`${Math.round(s.accuracy * 100)}% right`);
  while (parts.length > 1 && parts.join(DOT).length > width) parts.pop();
  return `${theme.dim}${parts.join(DOT)}${theme.reset}`;
}

function progressBar(fraction: number, width: number, theme: Theme): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  const empty = Math.max(0, width - filled);
  return `${theme.cyan}${"█".repeat(filled)}${theme.reset}${theme.dim}${"░".repeat(empty)}${theme.reset}`;
}

const HELP = [
  "1-4      answer a multiple-choice card",
  "type     spell the word, then Enter",
  "space    continue / next card",
  "s        skip this word, no penalty",
  "e        ask Claude for a memory hook",
  "p        practise even when the agent is idle",
  "q        quit      ?  this help",
];

export function renderFrame(state: AppState, pack: Pack, width: number, theme: Theme): string[] {
  const inner = Math.max(10, width - 2);
  const pad = "  ";
  const body = Math.max(8, inner - pad.length * 2);
  const content: string[] = [];
  const push = (line = "") => content.push(line ? pad + line : "");

  if (state.showHelp) {
    push(`${theme.bold}keys${theme.reset}`);
    push();
    for (const line of HELP) push(`${theme.dim}${line}${theme.reset}`);
    push();
    push(`${theme.dim}press any key to go back${theme.reset}`);
  } else {
    switch (state.mode) {
      case "waiting": {
        push();
        push(`${theme.dim}Standing by — you have the floor.${theme.reset}`);
        push();
        push(`${theme.dim}Cards resume the moment Claude or Codex${theme.reset}`);
        push(`${theme.dim}starts working. Press p to practise now.${theme.reset}`);
        push();
        break;
      }

      case "caughtup": {
        const s = summary(pack, state);
        const next = Object.values(state.progress.items)
          .map((i) => i.due)
          .sort((a, b) => a - b)[0];
        push();
        push(`${theme.green}All caught up.${theme.reset}`);
        push();
        push(
          `${theme.dim}${s.learned} of ${s.total} words started, ${s.mastered} mastered.${theme.reset}`,
        );
        if (next !== undefined) {
          push(`${theme.dim}Next review in ${relative(next - state.now)}.${theme.reset}`);
        }
        push();
        break;
      }

      case "teach": {
        const card = state.card;
        if (!card) break;
        push(`${theme.dim}new word${theme.reset}`);
        push();
        push(
          `${theme.bold}${theme.cyan}${card.word.term}${theme.reset}   ${theme.dim}${card.word.pos}${theme.reset}`,
        );
        push(`${theme.bold}${card.word.gloss}${theme.reset}`);
        if (card.word.note) push(`${theme.dim}${card.word.note}${theme.reset}`);
        push();
        push(`${theme.dim}#${card.word.rank} most common word in ${pack.englishName}${theme.reset}`);
        if (state.enrichPending) push(`${theme.dim}asking Claude for a memory hook…${theme.reset}`);
        for (const line of state.enrichment ? wrap(state.enrichment, body) : []) {
          push(`${theme.yellow}${line}${theme.reset}`);
        }
        for (const line of state.enrichError ? wrap(`no hook: ${state.enrichError}`, body) : []) {
          push(`${theme.red}${line}${theme.reset}`);
        }
        push();
        break;
      }

      case "question": {
        const card = state.card;
        if (!card) break;
        const item = state.progress.items[card.word.id];
        const level = item ? `${DOT}box ${item.box}/${MAX_BOX}` : "";
        push(`${theme.dim}${KIND_LABEL[card.kind]}${level}${theme.reset}`);
        push();
        if (card.kind === "recognize") {
          push(`what does ${theme.bold}${theme.cyan}«${card.prompt}»${theme.reset} mean?`);
        } else if (card.kind === "reverse") {
          push(`how do you say ${theme.bold}"${card.prompt}"${theme.reset}?`);
        } else {
          push(`spell the word for ${theme.bold}"${card.prompt}"${theme.reset}`);
        }
        push();
        if (card.choices.length) {
          const widest = Math.max(...card.choices.map((c) => visibleWidth(c)));
          const columns = widest + 7 <= Math.floor(body / 2) ? 2 : 1;
          for (let i = 0; i < card.choices.length; i += columns) {
            const cells: string[] = [];
            for (let c = 0; c < columns && i + c < card.choices.length; c++) {
              const n = i + c;
              cells.push(padTo(`${theme.cyan}${n + 1})${theme.reset} ${card.choices[n]}`, widest + 5));
            }
            push(cells.join(" ").trimEnd());
          }
        } else {
          push(`${theme.cyan}>${theme.reset} ${state.input}${theme.dim}▏${theme.reset}`);
        }
        push();
        break;
      }

      case "feedback": {
        const card = state.card;
        if (!card) break;
        const said = state.lastAnswer
          ? `${theme.dim} — you said "${state.lastAnswer}"${theme.reset}`
          : "";
        push(
          state.lastCorrect
            ? `${theme.green}correct${theme.reset}`
            : `${theme.red}not quite${theme.reset}${said}`,
        );
        push();
        push(
          `${theme.bold}${theme.cyan}${card.word.term}${theme.reset}${DOT}${theme.bold}${card.word.gloss}${theme.reset}`,
        );
        if (card.word.note) push(`${theme.dim}${card.word.note}${theme.reset}`);
        const item = state.progress.items[card.word.id];
        if (item) {
          const nextKind = KIND_LABEL[cardKindForBox(item.box)];
          push(
            `${theme.dim}box ${item.box}/${MAX_BOX}${DOT}back as "${nextKind}" in ${relative(item.due - state.now)}${theme.reset}`,
          );
        }
        if (state.enrichPending) push(`${theme.dim}asking Claude for a memory hook…${theme.reset}`);
        for (const line of state.enrichment ? wrap(state.enrichment, body) : []) {
          push(`${theme.yellow}${line}${theme.reset}`);
        }
        for (const line of state.enrichError ? wrap(`no hook: ${state.enrichError}`, body) : []) {
          push(`${theme.red}${line}${theme.reset}`);
        }
        push();
        break;
      }

      default:
        break;
    }
  }

  if (!state.showHelp) {
    const s = summary(pack, state);
    push(progressBar(s.total ? s.learned / s.total : 0, Math.min(24, body), theme));
    push(statusLine(state, pack, theme, body));
    if (state.message) push(`${theme.dim}${state.message}${theme.reset}`);
    // A problem stays on screen until it is fixed: a pane that has silently
    // stopped saving must not look identical to one that is working.
    for (const line of state.problem ? wrap(state.problem, body) : []) {
      push(`${theme.red}${line}${theme.reset}`);
    }
  }

  const marker =
    state.agent === "busy" ? `${theme.green}●${theme.reset}` : `${theme.dim}○${theme.reset}`;
  const agentLabel = state.agent === "busy" ? "agent working" : "agent idle";
  const practising = state.settings.alwaysOn && state.agent === "idle" ? `${DOT}practice` : "";
  const title =
    `${theme.bold}claudelingo${theme.reset}${DOT}${pack.englishName}   ` +
    `${marker} ${theme.dim}${agentLabel}${practising}${theme.reset}`;

  let footer: string;
  if (state.showHelp) footer = "any key to close";
  else if (!isActive(state)) footer = "p practise / q quit / ? help";
  else if (state.mode === "teach") footer = "space got it / s skip / e hook / q quit";
  else if (state.mode === "feedback") footer = "space next / e hook / q quit";
  else if (state.mode === "question" && state.card?.choices.length)
    footer = "1-4 answer / s skip / q quit";
  else if (state.mode === "question") footer = "type answer / enter submit";
  else footer = "q quit / ? help";

  return box(content, { width, title, footer, theme });
}
