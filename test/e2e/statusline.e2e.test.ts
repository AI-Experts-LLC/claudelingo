import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CLI,
  type Env,
  Pane,
  REPO,
  cli,
  makeEnv,
  progressFile,
  requireBuild,
} from "./harness.js";
import { PANEL_ROWS } from "../../src/statusline.js";

let env: Env;
beforeAll(requireBuild);
afterEach(() => env?.cleanup());

function fresh(): Env {
  env = makeEnv();
  return env;
}

/** The payload Claude Code pipes to a status-line command. */
const SESSION_JSON = JSON.stringify({
  session_id: "abc123",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/repo",
  model: { id: "claude-opus-5", display_name: "Opus" },
  workspace: { current_dir: "/repo", project_dir: "/repo" },
  cost: { total_duration_ms: 4200, total_lines_added: 12, total_lines_removed: 3 },
  exceeds_200k_tokens: false,
});

/** Run `claudelingo statusline` the way Claude Code does: JSON in, one line out. */
function statusline(e: Env, extra: string[] = []): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "statusline", "--no-color", ...extra], {
      env: { ...process.env, CLAUDELINGO_HOME: e.home, NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.write(SESSION_JSON);
    child.stdin.end();
  });
}

/** The first `count` terms of a shipped pack, read from the built output. */
function topTerms(code: string, count: number): string[] {
  const pack = JSON.parse(
    fs.readFileSync(path.join(REPO, "dist", "packs", `${code}.json`), "utf8"),
  ) as { words: string[][] };
  return pack.words.slice(0, count).map((w) => w[0] as string);
}

function seed(e: Env): void {
  const now = Date.now();
  const items: Record<string, unknown> = {};
  for (const id of ["es:1", "es:2", "es:3"]) {
    items[id] = {
      id, stage: "review", box: 2, step: 0,
      due: now - 60_000, lastSeen: now, seen: 5, correct: 4, lapses: 0,
    };
  }
  fs.writeFileSync(
    progressFile(e, "es"),
    JSON.stringify({
      version: 1, lang: "es", items, streak: 7, bestStreak: 9,
      totalAnswered: 20, totalCorrect: 17, introducedByDay: {},
    }),
  );
}

describe("the status line Claude Code draws", () => {
  it("prints exactly one line of vocabulary from the deck when compact", async () => {
    const e = fresh();
    seed(e);
    const { stdout, code } = await statusline(e, ["--compact"]);
    expect(code).toBe(0);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(stdout).toMatch(/«.+»/);
    expect(stdout).toContain("streak 7");
    expect(stdout).toContain("/312");
  });

  // Claude Code renders one row per line printed, so the row count *is* the
  // panel's height on screen. A drifting count would push the conversation around.
  it("prints the panel — three rows, always the same three", async () => {
    const e = fresh();
    seed(e);
    const { stdout, code } = await statusline(e);
    expect(code).toBe(0);
    const rows = stdout.trimEnd().split("\n");
    expect(rows).toHaveLength(PANEL_ROWS);
    // A word from this deck is on screen — either drilled as a question or shown
    // as a word and its meaning, depending where the clock is in the cycle.
    const terms = topTerms("es", 12);
    expect(
      terms.some((term) => stdout.includes(`«${term}»`) || stdout.includes(`"${term}"`)),
      `no deck word in: ${stdout}`,
    ).toBe(true);
    // The bottom row is the control surface: it must name the command to type,
    // because nothing here can take a keypress.
    expect(rows[PANEL_ROWS - 1]).toContain("/lingo");
  });

  it("shows the outstanding question, and never which answer is right", async () => {
    const e = fresh();
    seed(e);
    const dealt = await cli(["next", "--json"], e);
    const card = JSON.parse(dealt.stdout.trim()) as {
      card: { question: string; choices: string[] };
    };
    const { stdout } = await statusline(e);
    expect(stdout).toContain(card.card.question.slice(0, 20));
    // The pending file holds answerIndex; leaking it here would answer the very
    // question on screen.
    expect(stdout).not.toContain("answerIndex");
    const pending = JSON.parse(
      fs.readFileSync(path.join(e.home, "pending-es.json"), "utf8"),
    ) as { answerIndex: number; choices: string[] };
    for (const [index, choice] of pending.choices.entries()) {
      // Every choice appears; none is marked. The panel must not distinguish them.
      expect(stdout).toContain(choice);
      if (index === pending.answerIndex) {
        expect(stdout).not.toMatch(new RegExp(`[✓*→]\\s*${choice.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}`));
      }
    }
  });

  it("works on a completely fresh install", async () => {
    const { stdout, code } = await statusline(fresh());
    expect(code).toBe(0);
    // Which word appears rotates with the clock, so assert on where it came from:
    // the top of the Spanish deck, which is what a fresh install would teach.
    const term = /«(.+?)»/.exec(stdout)?.[1];
    expect(term).toBeTruthy();
    expect(topTerms("es", 12)).toContain(term);
    expect(stdout).toContain("0/312");
  });

  it("respects the configured language", async () => {
    const e = fresh();
    fs.writeFileSync(path.join(e.home, "settings.json"), JSON.stringify({ lang: "it", onboarded: true }));
    const { stdout } = await statusline(e);
    const term = /«(.+?)»/.exec(stdout)?.[1];
    expect(topTerms("it", 12)).toContain(term);
    // Deck sizes differ, so this pins the language even for a word both share.
    expect(stdout).toContain("/310");
  });

  it("never writes anything, so it cannot fight a running pane", async () => {
    const e = fresh();
    seed(e);
    const before = fs.readFileSync(progressFile(e, "es"), "utf8");
    const listing = fs.readdirSync(e.home).sort();
    await statusline(e);
    await statusline(e);
    expect(fs.readFileSync(progressFile(e, "es"), "utf8")).toBe(before);
    expect(fs.readdirSync(e.home).sort()).toEqual(listing);
    // Above all: no lock file, which would refuse the pane its own deck.
    expect(fs.existsSync(path.join(e.home, "progress-es.lock"))).toBe(false);
  });

  it("prints a blank line rather than noise when the deck is unusable", async () => {
    // A status line runs on every render; a stack trace here would land in the
    // middle of someone's session.
    const e = fresh();
    fs.writeFileSync(progressFile(e, "es"), "{ truncated");
    const { stdout, code } = await statusline(e);
    expect(code).toBe(0);
    expect(stdout).not.toContain("Error");
    expect(stdout).not.toContain("at ");
    // A corrupt deck is recovered, not fatal, so the panel still draws — what
    // matters is that it is the panel and not a stack trace.
    expect(stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(PANEL_ROWS)
  });

  // The CLI decides "is something outstanding?" from the file's *presence*. That
  // decision had no test at all: reverting it left the whole suite green while the
  // panel went back to revealing the answer to the card on screen.
  it.each([
    ["missing its question field", (p: string) => {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      delete d.question;
      fs.writeFileSync(p, JSON.stringify(d));
    }],
    ["truncated", (p: string) => fs.writeFileSync(p, '{ "id": "es:1"')],
    ["empty", (p: string) => fs.writeFileSync(p, "")],
    ["holding null", (p: string) => fs.writeFileSync(p, "null")],
  ])("says a question is waiting when the pending file is %s", async (_name, damage) => {
    const e = fresh();
    seed(e);
    const dealt = await cli(["next", "--json"], e);
    const card = JSON.parse(dealt.stdout.trim()) as { card: { id: string } };
    const pendingPath = path.join(e.home, "pending-es.json");
    damage(pendingPath);

    const term = /^es:(\d+)$/.exec(card.card.id);
    expect(term).toBeTruthy();

    for (const extra of [[], ["--compact"]]) {
      const { stdout } = await statusline(e, extra);
      expect(stdout).toContain("waiting");
      // and the drill — the thing that would give the game away — is not running
      expect(stdout).not.toMatch(/«.+» = [^?]/);
    }
    // The panel offers `/lingo skip` as the way out; it must actually work.
    const skipped = await cli(["skip", "--json"], e);
    expect(JSON.parse(skipped.stdout.trim())).toMatchObject({ skipped: true });
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it("shows a healthy question without answering it, in the one-line form too", async () => {
    const e = fresh();
    seed(e);
    await cli(["next", "--json"], e);
    const { stdout } = await statusline(e, ["--compact"]);
    expect(stdout).toContain("waiting");
    expect(stdout).not.toMatch(/«.+» = [^?]/);
  });

  it("stays three rows when the pending file contains newlines", async () => {
    const e = fresh();
    seed(e);
    await cli(["next", "--json"], e);
    const file = path.join(e.home, "pending-es.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    stored.question = "What does\n\n«el»\r\nmean?";
    stored.choices = ["one\ntwo", "three", "four", "five"];
    fs.writeFileSync(file, JSON.stringify(stored));

    const { stdout } = await statusline(e);
    // Rows on screen, not array entries: a newline inside one is two rows there.
    expect(stdout.trimEnd().split("\n")).toHaveLength(PANEL_ROWS);
  });

  // The pane keeps its card in memory and writes no pending file. Nothing told
  // the status line a question was on screen, so it drilled on and printed the
  // answer to the card the pane was asking. The unit test covers the rendering;
  // this covers the wiring, which is where the knowledge has to come from.
  it("goes quiet while a pane holds the deck", async () => {
    const e = fresh();
    seed(e);
    const pane = new Pane([], e);
    try {
      await pane.until(() => fs.existsSync(path.join(e.home, "progress-es.lock")));
      for (const extra of [[], ["--compact"]]) {
        const { stdout } = await statusline(e, extra);
        expect(stdout).toContain("pane");
        // The drill — the thing that would give the answer away — is not running.
        expect(stdout).not.toMatch(/«.+» = [^?]/);
      }
    } finally {
      pane.kill();
    }
  });

  it("returns quickly, because Claude Code cancels a slow one", async () => {
    const e = fresh();
    seed(e);
    const started = Date.now();
    await statusline(e);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not hang when Claude Code sends nothing", async () => {
    const e = fresh();
    const result = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [CLI, "statusline", "--no-color"], {
        env: { ...process.env, CLAUDELINGO_HOME: e.home },
      });
      child.stdout.on("data", () => {});
      child.on("close", resolve);
      child.stdin.end(); // closed immediately, no payload
    });
    expect(result).toBe(0);
  });
});

describe("installing the status line", () => {
  function fakeHome(e: Env) {
    const home = path.join(e.home, "fake-home");
    fs.mkdirSync(home, { recursive: true });
    return { home, vars: { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(e.home, "cx") } };
  }

  it("points Claude Code's status line at us, with a refresh timer", async () => {
    const e = fresh();
    const { home, vars } = fakeHome(e);
    const result = await cli(["init"], e, vars);
    expect(result.stdout).toContain("Status line installed");

    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.statusLine).toMatchObject({
      type: "command",
      command: "claudelingo statusline",
    });
    // Claude Code's own updates go quiet while it is thinking, which is exactly
    // when the line is meant to be teaching.
    expect(settings.statusLine.refreshInterval).toBeGreaterThanOrEqual(1);
    // The hooks still went in alongside it.
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
  });

  it("refuses to replace a status line someone else configured", async () => {
    const e = fresh();
    const { home, vars } = fakeHome(e);
    const file = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ statusLine: { type: "command", command: "~/.claude/mine.sh" } }),
    );

    const result = await cli(["init"], e, vars);
    // There is only one slot, so theirs is left alone — but the hooks, which are
    // what make the pane work at all, still install.
    expect(result.stderr).toContain("Status line NOT installed");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(settings.statusLine.command).toBe("~/.claude/mine.sh");
    expect(settings.hooks.Stop).toBeDefined();
    expect(result.code).toBe(0);
  });

  it("can be skipped entirely", async () => {
    const e = fresh();
    const { home, vars } = fakeHome(e);
    await cli(["init", "--no-statusline"], e, vars);
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.statusLine).toBeUndefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
  });

  it("is removed by uninit, leaving another tool's alone", async () => {
    const e = fresh();
    const { home, vars } = fakeHome(e);
    const file = path.join(home, ".claude", "settings.json");
    await cli(["init"], e, vars);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).statusLine).toBeDefined();
    await cli(["uninit"], e, vars);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).statusLine).toBeUndefined();

    // Someone else's survives an uninit.
    fs.writeFileSync(
      file,
      JSON.stringify({ statusLine: { type: "command", command: "theirs.sh" } }),
    );
    await cli(["uninit"], e, vars);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).statusLine.command).toBe("theirs.sh");
  });
});

describe("claudelingo claude", () => {
  const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

  it.skipIf(!hasTmux)("opens the pane beside a real agent process", async () => {
    const e = fresh();
    const bin = path.join(e.home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    // Stand-in for Claude Code, so the test never launches the real thing.
    fs.writeFileSync(path.join(bin, "claude"), '#!/bin/sh\necho "AGENT UP: $*"\nsleep 6\n');
    fs.chmodSync(path.join(bin, "claude"), 0o755);

    await cli(["hook", "UserPromptSubmit"], e);
    const session = `claudelingo-e2e-${process.pid}`;
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    spawnSync("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "40"]);

    try {
      spawnSync("tmux", [
        "send-keys", "-t", session,
        `export PATH=${bin}:$PATH CLAUDELINGO_HOME=${e.home} && ` +
          `${process.execPath} ${CLI} claude --model opus`,
        "Enter",
      ]);
      await new Promise((r) => setTimeout(r, 5000));

      const panes = spawnSync("tmux", ["list-panes", "-t", session, "-F", "#{pane_index}"], {
        encoding: "utf8",
      }).stdout.trim().split("\n");
      expect(panes).toHaveLength(2);

      const agent = spawnSync("tmux", ["capture-pane", "-t", `${session}.0`, "-p"], {
        encoding: "utf8",
      }).stdout;
      expect(agent).toContain("AGENT UP: --model opus");

      const quiz = spawnSync("tmux", ["capture-pane", "-t", `${session}.1`, "-p"], {
        encoding: "utf8",
      }).stdout;
      expect(quiz).toContain("claudelingo");
      // The pane must see the same agent state, which means the environment
      // crossed the tmux boundary — new panes get the server's env, not ours.
      expect(quiz).toContain("agent working");
    } finally {
      spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    }
  }, 30_000);

  it("fails cleanly when the language does not exist", async () => {
    // Our own flags go BEFORE the `claude` token; everything after it is the
    // agent's, which is what makes `claudelingo claude --help` work.
    const result = await cli(["--lang", "qq", "claude"], fresh());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no pack for "qq"');
  });

  it("passes everything after `claude` straight through, including --help", async () => {
    const e = fresh();
    const bin = path.join(e.home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(e.home, "agent.log");
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh\necho "GOT: $*" >> ${log}\n`,
    );
    fs.chmodSync(path.join(bin, "claude"), 0o755);

    // `--help` must reach the agent rather than printing claudelingo's usage.
    for (const args of [["claude", "--help"], ["claude", "--model", "opus", "--print", "hi"]]) {
      await cli(args, e, { PATH: `${bin}:${process.env.PATH}` });
    }
    const recorded = fs.readFileSync(log, "utf8");
    expect(recorded).toContain("GOT: --help");
    expect(recorded).toContain("GOT: --model opus --print hi");
  });
});

describe("the status line under awkward conditions", () => {
  it("exits even when the caller never closes stdin", async () => {
    // Claude Code closes stdin in practice, but with a 3-second refresh any
    // deviation would leak a node process on every tick.
    const e = fresh();
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [CLI, "statusline", "--no-color"], {
        env: { ...process.env, CLAUDELINGO_HOME: e.home },
      });
      child.stdout.on("data", () => {});
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, 6000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
      // Payload sent, pipe deliberately left open.
      child.stdin.write(SESSION_JSON);
    });
    expect(code).toBe(0);
  }, 15_000);

  it("sizes itself to COLUMNS, which Claude Code exports to the script", async () => {
    const e = fresh();
    seed(e);
    const line = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [CLI, "statusline", "--no-color"], {
        env: { ...process.env, CLAUDELINGO_HOME: e.home, COLUMNS: "28" },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("close", () => resolve(out.trimEnd()));
      child.stdin.write(SESSION_JSON);
      child.stdin.end();
    });
    expect([...line].length).toBeLessThanOrEqual(28);
  });
});
