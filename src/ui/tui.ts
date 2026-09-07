import { writeJsonAtomic } from "../config.js";
import type { AgentState, Pack, Progress, Settings, Word } from "../types.js";
import { effectiveState, readStatus, watchStatus } from "../agentState.js";
import { ansi, keys as CTRL } from "./ansi.js";
import {
  type AppState,
  type Effect,
  type Event,
  type Key,
  type ProblemKey,
  createState,
  reduce,
} from "./app.js";
import { COLOR, PLAIN, type Theme, renderFrame } from "./render.js";

export interface RunOptions {
  pack: Pack;
  progress: Progress;
  settings: Settings;
  progressFile: string;
  statusFile: string;
  /** Ask Claude for a memory hook. Injected so tests run without network. */
  enrich?: (word: Word) => Promise<string>;
  /** Shown in the pane straight away, e.g. an unreadable progress file. */
  initialProblems?: Partial<Record<ProblemKey, string>>;
  /** Suppress saving entirely — set when a deck we could not read is still on disk. */
  readOnly?: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  color?: boolean;
  width?: number;
  tickMs?: number;
  /** Render plain frames even without a TTY. Used by the end-to-end tests. */
  forceRender?: boolean;
  /** Tail Codex transcripts for the turn-start edge Codex has no hook for. */
  watchCodex?: (
    onState: (state: AgentState) => void,
    /** null when the watcher recovers, so the banner can be cleared. */
    onError: (message: string | null) => void,
  ) => { stop(): void };
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
  if (options.initialProblems) {
    state = { ...state, problems: { ...state.problems, ...options.initialProblems } };
    // The panel is the only place problems are shown, and it is not drawn at all
    // when stdout is not a terminal. Without this, piping the pane anywhere makes
    // a quarantined deck or a failed install completely invisible.
    if (!isTty && !options.forceRender) {
      for (const message of Object.values(options.initialProblems)) {
        if (message) process.stderr.write(`claudelingo: ${message}\n`);
      }
    }
  }

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
    try {
      if (isTty) stdout.write(`${ansi.clearScreen}${frame}\n`);
      else if (options.forceRender) stdout.write(`${frame}\n`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPIPE") {
        // The reader went away (`claudelingo | head`). Leave quietly rather than
        // dumping a stack trace over the user's terminal.
        stop();
        return;
      }
      // Anything else is unexpected and the user deserves to know why the pane
      // stopped rather than watching it vanish.
      try {
        process.stderr.write(`claudelingo: cannot draw the pane: ${(error as Error).message}\n`);
      } catch {
        // stderr is gone too; there is nowhere left to report.
      }
      stop();
    }
  };

  const applyEffects = (effects: Effect[]) => {
    for (const effect of effects) {
      if (effect.type === "save") {
        // A deck we could not read is still on disk; writing would destroy it.
        if (options.readOnly) continue;
        try {
          writeJsonAtomic(options.progressFile, effect.progress);
          setProblem("save", null);
        } catch (error) {
          // A read-only home or a full disk must not kill the pane mid-session and
          // leave the terminal in raw mode. Say so, keep going, keep retrying.
          setProblem("save", `progress is not saving: ${(error as Error).message}`);
        }
      } else if (effect.type === "quit") {
        stop();
      } else if (effect.type === "enrich") {
        const word = effect.word;
        if (!options.enrich) {
          // Nothing to call. Clear the spinner rather than leaving "asking
          // Claude…" on screen against a request that will never happen.
          dispatch({
            type: "enrichFailed",
            wordId: word.id,
            message: "memory hooks are not available",
          });
          continue;
        }
        options
          .enrich(word)
          .then((text) => dispatch({ type: "enriched", wordId: word.id, text }))
          .catch((error: Error) =>
            dispatch({ type: "enrichFailed", wordId: word.id, message: error.message }),
          );
      }
    }
  };

  /** Set or clear one problem without disturbing the others. */
  const setProblem = (key: ProblemKey, message: string | null) => {
    const problems = { ...state.problems };
    if (message === null) delete problems[key];
    else problems[key] = message;
    state = { ...state, problems };
  };

  const dispatch = (event: Event) => {
    if (stopped) return;
    const step = reduce(state, event, options.pack);
    state = step.state;
    applyEffects(step.effects);
    paint();
  };

  // Started before the first paint: the transcript tailer snapshots which Codex
  // sessions already existed, and anything written after that snapshot counts as a
  // live turn. Snapshotting after the pane is visible would silently miss a turn
  // that began in between. It never paints on its own, so it cannot double up the
  // opening frame.
  const codexWatcher = options.watchCodex?.(
    (agent) => {
      const current = readStatus(options.statusFile);
      if (current?.state === agent) return;
      try {
        writeJsonAtomic(options.statusFile, {
          state: agent,
          source: "codex",
          event: "rollout",
          ts: Date.now(),
        });
        dispatch({ type: "problem", key: "status", message: null });
      } catch (error) {
        // Nothing else can see this failure: the transcript watcher only reports
        // problems reading transcripts, and without a status write the pane will
        // never notice a Codex turn.
        dispatch({
          type: "problem",
          key: "status",
          message: `cannot record agent state: ${(error as Error).message}`,
        });
      }
    },
    (message) =>
      dispatch({
        type: "problem",
        key: "codex",
        // "stopped" would be a lie: it keeps polling. It just cannot see anything.
        message: message === null ? null : `Codex turns not detected: ${message}`,
      }),
  );

  if (isTty) stdout.write(ansi.hideCursor);
  paint(true);

  // Wired only after the first paint: watchStatus runs a synchronous initial check,
  // which would otherwise emit the opening frame twice.
  const watcher = watchStatus(() => dispatch({ type: "agent", state: agentNow() }), {
    file: options.statusFile,
    onError: (message) => dispatch({ type: "problem", key: "status", message }),
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
    codexWatcher?.stop();
    stdin.off("data", onData);
    stdin.off("end", onEnd);
    if (typeof tty.setRawMode === "function" && tty.isTTY) tty.setRawMode(false);
    if (typeof tty.pause === "function") tty.pause();
    // Reading stdin refs its handle; without this the process stays alive after
    // the user quits, even though there is nothing left to do.
    tty.unref?.();
    if (isTty) {
      try {
        stdout.write(`${ansi.showCursor}\n`);
      } catch {
        // Nothing to do if the terminal is already gone.
      }
    }
    resolveDone();
  }

  return { done, stop };
}
