import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
  readProgress,
  requireBuild,
} from "./harness.js";

let env: Env;
const panes: Pane[] = [];

beforeAll(requireBuild);
afterEach(() => {
  for (const p of panes.splice(0)) p.kill();
  if (env) {
    try {
      fs.chmodSync(env.home, 0o700);
    } catch {
      // Already writable.
    }
    env.cleanup();
  }
});

function open(args: string[], e: Env, extra: Record<string, string> = {}): Pane {
  const pane = new Pane(args, e, extra);
  panes.push(pane);
  return pane;
}

const BASE = ["--lang", "es", "--width", "62", "--no-color", "--no-enrich"];

function fresh(): Env {
  env = makeEnv();
  return env;
}

describe("a deck it cannot read", () => {
  it("sets the file aside instead of overwriting a real learning history", async () => {
    const e = fresh();
    const file = progressFile(e, "es");
    // What a truncated write or an interrupted sync leaves behind.
    fs.writeFileSync(file, '{"version":1,"lang":"es","items":{"es:1":{"id":"es:1","se');
    await cli(["hook", "UserPromptSubmit"], e);

    const pane = open(BASE, e);
    // The content was read fine and is genuinely bad — that is the one case where
    // setting the file aside is justified.
    await pane.waitForProse("is not valid JSON");
    expect(pane.flatFrame).toContain("kept a copy at");

    // The original bytes must still exist somewhere.
    const salvaged = fs.readdirSync(e.home).filter((f) => f.includes("corrupt-"));
    expect(salvaged).toHaveLength(1);
    expect(fs.readFileSync(path.join(e.home, salvaged[0] as string), "utf8")).toContain('"es:1"');

    // And only now may it start a fresh deck.
    await pane.waitForText("#1 most common word");
    pane.send(" ");
    await pane.waitForText("#2 most common word");
    expect(Object.keys((readProgress(e, "es") as { items: object }).items)).toEqual(["es:1"]);
  });

  it("sets aside a deck from a future version rather than discarding it", async () => {
    const e = fresh();
    fs.writeFileSync(progressFile(e, "es"), JSON.stringify({ version: 2, lang: "es", items: {} }));
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(BASE, e);
    await pane.waitForProse("not a version 1 deck");
    expect(fs.readdirSync(e.home).some((f) => f.includes("corrupt-"))).toBe(true);
  });

  it("does not touch a deck it read perfectly well", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(BASE, e);
    await pane.waitForText("#1 most common word");
    pane.send(" ");
    await pane.waitForText("#2 most common word");
    expect(pane.flatFrame).not.toContain("could not be read");
    expect(fs.readdirSync(e.home).some((f) => f.includes("corrupt-"))).toBe(false);
  });
});

describe("a home it cannot write", () => {
  it("says so and keeps running instead of crashing out of raw mode", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(BASE, e);
    await pane.waitForText("#1 most common word");

    fs.chmodSync(e.home, 0o500);
    try {
      pane.send(" ");
      await pane.waitForProse("progress is not saving");
      // Still alive, still rendering, still usable.
      expect(pane.lastFrame).toContain("claudelingo");
      pane.send(" ");
      await pane.waitForText("#3 most common word");
    } finally {
      fs.chmodSync(e.home, 0o700);
    }

    // And it exits cleanly rather than dying with a stack trace.
    pane.send("q");
    expect(await pane.exited).toBe(0);
    expect(pane.stderr).not.toContain("EACCES");
  });

  it("clears the warning once writing works again", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(BASE, e);
    await pane.waitForText("#1 most common word");

    fs.chmodSync(e.home, 0o500);
    pane.send(" ");
    await pane.waitForProse("progress is not saving");
    fs.chmodSync(e.home, 0o700);

    pane.send(" ");
    await pane.until(() => !pane.flatFrame.includes("progress is not saving"));
  });
});

describe("two panes on one deck", () => {
  it("refuses the second rather than letting it erase the first's work", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);

    const first = open(BASE, e);
    await first.waitForText("#1 most common word");
    first.send(" ");
    await first.waitForText("#2 most common word");

    const second = await cli(["--lang", "es", "--no-color"], e);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already studying Spanish");

    // The first pane's work is intact.
    first.send(" ");
    await first.waitForText("#3 most common word");
    expect(Object.keys((readProgress(e, "es") as { items: object }).items)).toEqual([
      "es:1",
      "es:2",
    ]);
  });

  it("allows a second pane on a different language", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const spanish = open(BASE, e);
    await spanish.waitForText("#1 most common word");

    const french = open(["--lang", "fr", "--width", "62", "--no-color", "--no-enrich"], e);
    await french.waitForText("#1 most common word");
    expect(french.lastFrame).toContain("French");
  });

  it("takes over a lock left behind by a killed pane", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const first = open(BASE, e);
    await first.waitForText("#1 most common word");
    first.kill();
    await first.exited;

    const second = open(BASE, e);
    await second.waitForText("#1 most common word");
  });
});

describe("an agent that never came back", () => {
  it("ages a busy left mid-session into idle", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    fs.writeFileSync(
      path.join(e.home, "settings.json"),
      JSON.stringify({ lang: "es", staleBusyMs: 1500, onboarded: true }),
    );

    const pane = open(BASE, e);
    await pane.waitForText("#1 most common word");
    expect(pane.lastFrame).toContain("agent working");

    // No Stop hook ever arrives — the session was killed. The pane must stand
    // down on its own rather than quizzing forever.
    await pane.waitForLastFrame("Standing by", 12_000);
    expect(pane.lastFrame).toContain("agent idle");
  });
});

describe("memory hooks through the user's own Claude Code", () => {
  /** A stand-in `claude` binary, so nothing here spends the user's real quota. */
  function stubClaude(e: Env, script: string): string {
    const bin = path.join(e.home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const file = path.join(bin, "claude");
    fs.writeFileSync(file, script);
    fs.chmodSync(file, 0o755);
    return bin;
  }

  const success = (text: string) =>
    `#!/bin/sh\nprintf '%s' '${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
    }).replace(/'/g, "'\\''")}'\n`;

  it("fetches a hook with no API key anywhere in sight", async () => {
    const e = fresh();
    const bin = stubClaude(e, success("el is the, as in El Nino"));
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(["--lang", "es", "--width", "62", "--no-color"], e, {
      PATH: `${bin}:${process.env.PATH}`,
      // Deliberately empty: this path must not depend on either of them.
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    await pane.waitForText("#1 most common word");
    pane.send("e");
    await pane.waitForProse("El Nino");
    expect(fs.readdirSync(path.join(e.home, "cache"))).toHaveLength(1);
  });

  it("shows a failure as an error, and lets the user try again", async () => {
    const e = fresh();
    const counter = path.join(e.home, "calls");
    const bin = stubClaude(
      e,
      `#!/bin/sh\necho x >> ${counter}\nprintf 'not json at all'\n`,
    );
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(["--lang", "es", "--width", "62", "--no-color"], e, {
      PATH: `${bin}:${process.env.PATH}`,
    });
    await pane.waitForText("#1 most common word");

    pane.send("e");
    await pane.waitForProse("no hook:");
    expect(fs.existsSync(path.join(e.home, "cache"))).toBe(false);

    pane.send("e");
    // A retry means a second invocation; the card must not be poisoned.
    await pane.until(
      () => fs.existsSync(counter) && fs.readFileSync(counter, "utf8").trim().split("\n").length >= 2,
      15_000,
    );
  }, 30_000);

  it("says once, up front, when Claude Code is not on the PATH", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    // A PATH with no `claude` at all — the only thing this feature needs.
    const pane = open(["--lang", "es", "--width", "62", "--no-color"], e, {
      PATH: path.join(e.home, "empty-bin"),
    });
    await pane.waitForProse("not on this PATH");

    const framesBefore = pane.frames.length;
    pane.send("e");
    await pane.settle(2000);
    expect(pane.flatFrame).not.toContain("no hook:");
    expect(pane.flatFrame).not.toContain("asking Claude");
    expect(pane.frames.length).toBe(framesBefore);
  });
});

describe("argument hygiene", () => {
  it("ignores a nonsense --width instead of rendering a broken panel", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(["--lang", "es", "--width", "abc", "--no-color", "--no-enrich"], e, {
      COLUMNS: "70",
    });
    await pane.waitForText("#1 most common word");
    const lines = pane.lastFrame.split("\n");
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBeGreaterThan(20);
    expect(pane.stderr).toContain("ignoring --width");
  });
});

describe("two panes launched at the same instant", () => {
  /**
   * The sequential case is easy; this is the one that matters. A read-then-write
   * lock lets both processes see "no lock" before either writes one, and both
   * start on the same deck — which is exactly the silent erasure the lock exists
   * to prevent.
   */
  it("still lets exactly one pane win", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const e = makeEnv();
      try {
        await cli(["hook", "UserPromptSubmit"], e);
        // Launched together, with no await in between.
        const a = new Pane(BASE, e);
        const b = new Pane(BASE, e);
        panes.push(a, b);

        const started: Pane[] = [];
        const refused: Pane[] = [];
        for (const pane of [a, b]) {
          try {
            await pane.waitForText("most common word", 6000);
            started.push(pane);
          } catch {
            refused.push(pane);
          }
        }

        expect(started, `attempt ${attempt + 1}: expected exactly one pane to start`).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(await refused[0]!.exited).toBe(1);
        expect(refused[0]!.stderr).toContain("already studying Spanish");
      } finally {
        for (const p of panes.splice(0)) p.kill();
        e.cleanup();
      }
    }
  });
});

describe("a status file it cannot read", () => {
  it("says the pane is blind rather than looking like a healthy idle pane", async () => {
    const e = fresh();
    // A corrupt status.json is indistinguishable from an idle agent unless the
    // pane says so — and the user would sit there while Claude worked.
    fs.writeFileSync(path.join(e.home, "status.json"), "{ truncated");
    const pane = open(BASE, e);
    await pane.waitForProse("cannot read");
    expect(pane.flatFrame).toContain("cannot see the agent");
  });

  it("clears the warning once a hook rewrites the file", async () => {
    const e = fresh();
    fs.writeFileSync(path.join(e.home, "status.json"), "{ truncated");
    const pane = open(BASE, e);
    await pane.waitForProse("cannot read");

    await cli(["hook", "UserPromptSubmit"], e);
    await pane.until(() => !pane.flatFrame.includes("cannot see the agent"));
    await pane.waitForLastFrame("most common word");
  });
});

describe("a deck it could not read for a transient reason", () => {
  it("leaves the file alone and refuses to save over it", async () => {
    const e = fresh();
    const file = progressFile(e, "es");
    const original = JSON.stringify({
      version: 1,
      lang: "es",
      items: {
        "es:1": {
          id: "es:1", stage: "review", box: 4, step: 0,
          due: Date.now() + 86_400_000, lastSeen: Date.now(), seen: 40, correct: 38, lapses: 1,
        },
      },
      streak: 12, bestStreak: 30, totalAnswered: 400, totalCorrect: 380, introducedByDay: {},
    });
    fs.writeFileSync(file, original);
    // A permission problem says nothing about the contents; treating it as
    // corruption would turn a transient glitch into permanent data loss.
    fs.chmodSync(file, 0o000);
    await cli(["hook", "UserPromptSubmit"], e);

    const pane = open(BASE, e);
    try {
      await pane.waitForProse("Not saving, so your deck is left untouched");
      // Answering must not write over it.
      await pane.waitForLastFrame("most common word");
      pane.send(" ");
      await pane.settle(600);

      fs.chmodSync(file, 0o600);
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(fs.readdirSync(e.home).some((f) => f.includes("corrupt-"))).toBe(false);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it("never moves a deck aside from the read-only stats command", async () => {
    const e = fresh();
    const file = progressFile(e, "es");
    fs.writeFileSync(file, "{ truncated but precious");
    fs.chmodSync(file, 0o000);
    try {
      const result = await cli(["stats", "--lang", "es"], e);
      expect(result.code).toBe(0);
      fs.chmodSync(file, 0o600);
      expect(fs.readFileSync(file, "utf8")).toBe("{ truncated but precious");
      expect(fs.readdirSync(e.home).some((f) => f.includes("corrupt-"))).toBe(false);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it("does not quarantine an unparseable deck from stats either", async () => {
    const e = fresh();
    const file = progressFile(e, "es");
    fs.writeFileSync(file, "{ definitely not json");
    const result = await cli(["stats", "--lang", "es"], e);
    expect(result.code).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("{ definitely not json");
    expect(fs.readdirSync(e.home).some((f) => f.includes("corrupt-"))).toBe(false);
  });
});

describe("an absurd --width", () => {
  it("is rejected instead of throwing out of the renderer", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(["--lang", "es", "--width", "1e9", "--no-color", "--no-enrich"], e);
    await pane.waitForText("most common word");
    const widths = new Set(pane.lastFrame.split("\n").map((l) => [...l].length));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBeLessThanOrEqual(1000);

    // And the lock is released properly on exit, not orphaned by a throw.
    pane.send("q");
    expect(await pane.exited).toBe(0);
    expect(fs.existsSync(path.join(e.home, "progress-es.lock"))).toBe(false);
  });
});

describe("a home with nothing in it yet", () => {
  it("opens clean on a first-ever launch, with no error banner", async () => {
    // Every other test fires a hook first, so a genuinely fresh home is never
    // exercised. Collapsing missing-vs-unreadable would put "cannot read
    // status.json" on screen at every first launch.
    const e = fresh();
    expect(fs.existsSync(path.join(e.home, "status.json"))).toBe(false);

    const pane = open(BASE, e);
    await pane.waitForText("Standing by");
    expect(pane.flatFrame).not.toContain("cannot read");
    expect(pane.flatFrame).not.toContain("could not be read");
    expect(pane.flatFrame).not.toContain("not saving");
    // It writes the status file itself so the hooks have somewhere to land.
    expect(fs.existsSync(path.join(e.home, "status.json"))).toBe(true);

    // And it wakes up normally from there.
    await cli(["hook", "UserPromptSubmit"], e);
    await pane.waitForLastFrame("most common word");
  });

  it("says so when it cannot even record the agent state", async () => {
    const e = fresh();
    fs.chmodSync(e.home, 0o500);
    try {
      const pane = open(BASE, e);
      // Nothing else can surface this: no later write of a different file reveals
      // that the pane is blind to the agent.
      await pane.waitForProse("cannot record agent state");
    } finally {
      fs.chmodSync(e.home, 0o700);
    }
  });
});

describe("problems when nobody is watching the panel", () => {
  it("reports to stderr when stdout is not a terminal", async () => {
    // The panel is the only place problems are shown, and it is not drawn without
    // a TTY — so piping the pane anywhere would hide a quarantined deck entirely.
    const e = fresh();
    fs.writeFileSync(progressFile(e, "es"), "{ truncated");
    await cli(["hook", "UserPromptSubmit"], e);

    const result = await new Promise<{ stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, "--lang", "es", "--no-color", "--no-enrich"], {
        env: { ...process.env, CLAUDELINGO_HOME: e.home, NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.stdout.on("data", () => {});
      setTimeout(() => child.kill("SIGTERM"), 1500);
      child.on("close", () => resolve({ stderr }));
    });
    expect(result.stderr).toContain("is not valid JSON");
    expect(result.stderr).toContain("kept a copy at");
  });
});

describe("the lock under real contention", () => {
  it("never grants two panes at once, hammered across processes", async () => {
    // The failure this guards against is a create-then-write window: a concurrent
    // acquirer reads a lock file that exists but names nobody, calls it stale, and
    // deletes a live pane's lock.
    const e = fresh();
    const lockFile = path.join(e.home, "progress-es.lock");
    const marker = `${lockFile}.holders`;
    fs.writeFileSync(marker, "");

    const script = path.join(e.home, "stress.mjs");
    fs.writeFileSync(
      script,
      `import { acquire } from ${JSON.stringify(path.join(REPO, "dist", "lock.js"))};\n` +
        `import fs from "node:fs";\n` +
        `const [file, marker] = process.argv.slice(2);\n` +
        `let overlaps = 0;\n` +
        `for (let i = 0; i < 800; i++) {\n` +
        `  const r = acquire(file);\n` +
        `  if (!r.ok) continue;\n` +
        `  try {\n` +
        `    fs.appendFileSync(marker, process.pid + "\\n");\n` +
        `    const held = fs.readFileSync(marker, "utf8").trim().split("\\n").filter(Boolean);\n` +
        `    if (held.length > 1) overlaps++;\n` +
        `    fs.writeFileSync(marker, "");\n` +
        `  } catch {}\n` +
        `  r.lock.release();\n` +
        `}\n` +
        `console.log(overlaps);\n`,
    );

    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, [script, lockFile, marker]);
          let out = "";
          child.stdout.on("data", (d) => (out += d.toString()));
          child.on("close", () => resolve(Number(out.trim())));
        }),
      ),
    );
    expect(runs).toEqual([0, 0, 0, 0]);
  }, 60_000);
});

describe("reset and the running pane", () => {
  it("refuses to reset a deck a pane is holding", async () => {
    // Without the lock, reset reports success and the pane's next save writes its
    // whole in-memory deck straight back over the empty file.
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(BASE, e);
    await pane.waitForText("#1 most common word");
    pane.send(" ");
    await pane.waitForText("#2 most common word");

    const result = await cli(["reset", "--lang", "es", "--yes"], e);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("would write its deck back over the reset");

    // The deck is intact and the pane carries on.
    expect(Object.keys((readProgress(e, "es") as { items: object }).items)).toEqual(["es:1"]);
    pane.send(" ");
    await pane.waitForText("#3 most common word");
  });

  it("resets once the pane has closed, and the reset sticks", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(BASE, e);
    await pane.waitForText("#1 most common word");
    pane.send(" ");
    await pane.waitForText("#2 most common word");
    pane.send("q");
    expect(await pane.exited).toBe(0);

    const result = await cli(["reset", "--lang", "es", "--yes"], e);
    expect(result.code).toBe(0);
    expect((readProgress(e, "es") as { items: object }).items).toEqual({});
    // And the lock is not left behind.
    expect(fs.existsSync(path.join(e.home, "progress-es.lock"))).toBe(false);
  });
});

describe("a deck whose items are the wrong shape", () => {
  it("sets it aside instead of splicing garbage into it", async () => {
    // `items: "oops"` is truthy. A truthiness check lets it through, `stats`
    // reports confident nonsense, and the next answer saves {"0":"o","1":"o",...}
    // back over the file.
    const e = fresh();
    const file = progressFile(e, "es");
    const original = JSON.stringify({
      version: 1, lang: "es", items: "oops",
      streak: 0, bestStreak: 0, totalAnswered: 0, totalCorrect: 0, introducedByDay: {},
    });
    fs.writeFileSync(file, original);

    const stats = await cli(["stats", "--lang", "es"], e);
    expect(stats.stdout).toMatch(/words started\s+0 of/);
    expect(stats.stderr).toContain("not a version 1 deck");
    // stats is read-only.
    expect(fs.readFileSync(file, "utf8")).toBe(original);

    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(BASE, e);
    await pane.waitForProse("not a version 1 deck");
    await pane.waitForLastFrame("most common word");
    pane.send(" ");
    await pane.waitForText("#2 most common word");

    const saved = readProgress(e, "es") as { items: Record<string, unknown> };
    expect(Object.keys(saved.items)).toEqual(["es:1"]);
    expect(fs.readdirSync(e.home).some((f) => f.includes("corrupt-"))).toBe(true);
  });

  it("rejects an array of items too", async () => {
    const e = fresh();
    fs.writeFileSync(
      progressFile(e, "es"),
      JSON.stringify({ version: 1, lang: "es", items: [] }),
    );
    const stats = await cli(["stats", "--lang", "es"], e);
    expect(stats.stderr).toContain("not a version 1 deck");
  });
});
