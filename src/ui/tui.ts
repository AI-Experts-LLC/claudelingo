import { writeJsonAtomic } from "../config.js";
import type { AgentState, Pack, Progress, Settings, Word } from "../types.js";
import { effectiveState, readStatus, watchStatus } from "../agentState.js";
import { ansi, keys as CTRL } from "./ansi.js";
import { type AppState, type Effect, type Event, type Key, createState, reduce } from "./app.js";
import { COLOR, PLAIN, type Theme, renderFrame } from "./render.js";

export interface RunOptions {
  pack: Pack;
  progress: Progress;
  settings: Settings;
  progressFile: string;
  statusFile: string;
  /** Ask Claude for a memory hook. Injected so tests run without network. */
  enrich?: (word: Word) => Promise<string>;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  color?: boolean;
  width?: number;
  tickMs?: number;
  /** Render plain frames even without a TTY. Used by the end-to-end tests. */
  forceRender?: boolean;
}

/** Translate one chunk of raw stdin into the key events the reducer understands. */
export function parseKeys(chunk: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i] as string;
    if (ch === CTRL.ctrlC) {
      out.push({ name: "ctrl-c" });
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && chunk[i + 1] === "\n") i++; // CRLF is one Enter
      out.push({ name: "enter" });
    } else if (ch === CTRL.del || ch === CTRL.backspace) {
      out.push({ name: "backspace" });
    } else if (ch === CTRL.esc) {
      // Swallow the rest of an escape sequence (arrows, function keys).
      if (chunk[i + 1] === "[" || chunk[i + 1] === "O") {
        i += 2;
        while (i < chunk.length && !/[A-Za-z~]/.test(chunk[i] as string)) i++;
      } else {
        out.push({ name: "escape" });
      }
    } else if (ch === " ") {
      out.push({ name: "space" });
    } else if (ch >= " " && ch !== CTRL.del) {
      out.push({ ch });
    }
  }
  return out;
}

export interface Runner {
  /** Resolves when the user quits or stdin ends. */
  done: Promise<void>;
  stop(): void;
}

export function run(options: RunOptions): Runner {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const isTty = Boolean((stdout as NodeJS.WriteStream).isTTY);
  const useColor = options.color ?? (isTty && !process.env.NO_COLOR);
  const theme: Theme = useColor ? COLOR : PLAIN;
  const tickMs = options.tickMs ?? 1000;

  const width = () =>
    options.width ??
    (stdout as NodeJS.WriteStream).columns ??
    (Number(process.env.COLUMNS) || 64);

  const agentNow = (): AgentState =>
    effectiveState(readStatus(options.statusFile), Date.now(), options.settings.staleBusyMs);

  const initialAgent = agentNow();

  let state: AppState = createState(
    options.pack,
    options.progress,
    options.settings,
    initialAgent,
    Date.now(),
  );

  // An agent already working when the pane opens should get a card straight away.
  if (initialAgent === "busy" || options.settings.alwaysOn) {
    state = reduce(state, { type: "tick", now: Date.now() }, options.pack).state;
  }

  let lastFrame = "";
  let stopped = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const paint = (force = false) => {
    if (stopped) return;
    const frame = renderFrame(state, options.pack, width(), theme).join("\n");
    if (!force && frame === lastFrame) return;
    lastFrame = frame;
    if (isTty) stdout.write(`${ansi.clearScreen}${frame}\n`);
    else if (options.forceRender) stdout.write(`${frame}\n`);
  };

  const applyEffects = (effects: Effect[]) => {
    for (const effect of effects) {
      if (effect.type === "save") {
        writeJsonAtomic(options.progressFile, effect.progress);
      } else if (effect.type === "quit") {
        stop();
      } else if (effect.type === "enrich" && options.enrich) {
        const word = effect.word;
        options
          .enrich(word)
          .then((text) => dispatch({ type: "enriched", wordId: word.id, text }))
          .catch((error: Error) =>
            dispatch({ type: "enriched", wordId: word.id, text: `(no hook: ${error.message})` }),
          );
      }
    }
  };

  const dispatch = (event: Event) => {
    if (stopped) return;
    const step = reduce(state, event, options.pack);
    state = step.state;
    applyEffects(step.effects);
    paint();
  };

  if (isTty) stdout.write(ansi.hideCursor);
  paint(true);

  // Wired only after the first paint: watchStatus runs a synchronous initial check,
  // which would otherwise emit the opening frame twice.
  const watcher = watchStatus(() => dispatch({ type: "agent", state: agentNow() }), {
    file: options.statusFile,
  });

  const ticker = setInterval(() => {
    // Re-derive on every tick so a `busy` never closed out by a Stop hook still
    // ages into idle on its own.
    const agent = agentNow();
    if (agent !== state.agent) dispatch({ type: "agent", state: agent });
    dispatch({ type: "tick", now: Date.now() });
  }, tickMs);
  if (typeof ticker.unref === "function") ticker.unref();

  const onData = (chunk: Buffer | string) => {
    for (const key of parseKeys(chunk.toString())) dispatch({ type: "key", key });
  };

  const tty = stdin as NodeJS.ReadStream;
  if (typeof tty.setRawMode === "function" && tty.isTTY) tty.setRawMode(true);
  if (typeof tty.setEncoding === "function") tty.setEncoding("utf8");
  const onEnd = () => stop();
  stdin.on("data", onData);
  stdin.on("end", onEnd);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(ticker);
    watcher.stop();
    stdin.off("data", onData);
    stdin.off("end", onEnd);
    if (typeof tty.setRawMode === "function" && tty.isTTY) tty.setRawMode(false);
    if (typeof tty.pause === "function") tty.pause();
    // Reading stdin refs its handle; without this the process stays alive after
    // the user quits, even though there is nothing left to do.
    tty.unref?.();
    if (isTty) stdout.write(`${ansi.showCursor}\n`);
    resolveDone();
  }

  return { done, stop };
}
