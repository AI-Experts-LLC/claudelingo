import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Env, Pane, cli, makeEnv, progressFile, readProgress, requireBuild } from "./harness.js";

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
    await pane.waitForProse("could not be read");
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
      JSON.stringify({ lang: "es", staleBusyMs: 1500 }),
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

describe("memory hooks against a real HTTP round trip", () => {
  /** A stand-in for the Anthropic API, so the live path runs without a credential. */
  function stubServer(handler: http.RequestListener): Promise<{ url: string; close(): void }> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => server.close(),
        });
      });
    });
  }

  it("renders a hook fetched over the wire, and caches it", async () => {
    const e = fresh();
    const server = await stubServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-fable-5-1",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "el is the, as in El Nino" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    try {
      await cli(["hook", "UserPromptSubmit"], e);
      const pane = open(["--lang", "es", "--width", "62", "--no-color"], e, {
        ANTHROPIC_API_KEY: "test-key-not-real",
        ANTHROPIC_BASE_URL: server.url,
      });
      await pane.waitForText("#1 most common word");
      pane.send("e");
      await pane.waitForProse("El Nino");

      // Cached, so the same word is never paid for twice.
      const cached = fs.readdirSync(path.join(e.home, "cache"));
      expect(cached).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it("shows a failure as an error, and lets the user try again", async () => {
    const e = fresh();
    let calls = 0;
    const server = await stubServer((req, res) => {
      calls += 1;
      res.socket?.destroy(); // connection refused, mid-request
    });
    try {
      await cli(["hook", "UserPromptSubmit"], e);
      const pane = open(["--lang", "es", "--width", "62", "--no-color"], e, {
        ANTHROPIC_API_KEY: "test-key-not-real",
        ANTHROPIC_BASE_URL: server.url,
      });
      await pane.waitForText("#1 most common word");

      pane.send("e");
      await pane.waitForProse("no hook:");
      // Nothing was cached, and the card is not poisoned.
      expect(fs.existsSync(path.join(e.home, "cache"))).toBe(false);

      pane.send("e");
      await pane.until(() => calls >= 2, 15_000);
    } finally {
      server.close();
    }
  });

  it("says once, up front, when there is no credential at all", async () => {
    const e = fresh();
    await cli(["hook", "UserPromptSubmit"], e);
    const pane = open(["--lang", "es", "--width", "62", "--no-color"], e, {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    await pane.waitForProse("no Anthropic credential");
    // and pressing e does not spray auth errors
    pane.send("e");
    await pane.waitForText("#1 most common word");
    expect(pane.flatFrame).not.toContain("no hook:");
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
