import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Env, Pane, cli, makeEnv, requireBuild } from "./harness.js";

let env: Env;
let pane: Pane | null = null;

beforeAll(requireBuild);
afterEach(() => {
  pane?.kill();
  pane = null;
  env?.cleanup();
});

const BASE = ["--lang", "es", "--width", "58", "--no-color", "--no-enrich"];

/**
 * Codex has no "turn started" hook, so the pane tails the rollout transcript for
 * the busy edge and takes the idle edge from `notify`. This exercises both halves
 * against a transcript written live, the way Codex writes one.
 */
describe("Codex transcript integration", () => {
  it("starts quizzing when a Codex turn begins and stops when it completes", async () => {
    env = makeEnv();
    const codexHome = path.join(env.home, "codex");
    const sessions = path.join(codexHome, "sessions", "2026", "09", "07");
    fs.mkdirSync(sessions, { recursive: true });
    const rollout = path.join(sessions, "rollout-2026-09-07T12-00-00-abc.jsonl");
    fs.writeFileSync(rollout, "");

    await cli(["hook", "Stop"], env);

    pane = new Pane(BASE, env, { CODEX_HOME: codexHome });
    await pane.waitForText("Standing by");

    // Codex records the user's turn beginning.
    fs.appendFileSync(
      rollout,
      `${JSON.stringify({
        timestamp: "2026-09-07T12:00:01Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
      })}\n`,
    );
    await pane.waitForLastFrame("new word");
    expect(pane.lastFrame).toContain("agent working");

    // And then its own reply, which must not be mistaken for a new turn.
    fs.appendFileSync(
      rollout,
      `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant" } })}\n`,
    );

    // Codex finishes and calls the notify program.
    await cli(["notify", JSON.stringify({ type: "agent-turn-complete" })], env);
    await pane.waitForLastFrame("agent idle");
    expect(pane.lastFrame).toContain("agent idle");
  });

  it("ignores a transcript that was already on disk before the pane opened", async () => {
    env = makeEnv();
    const codexHome = path.join(env.home, "codex");
    const sessions = path.join(codexHome, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "rollout-old.jsonl"),
      `${JSON.stringify({ type: "task_started" })}\n`,
    );

    await cli(["hook", "Stop"], env);
    pane = new Pane(BASE, env, { CODEX_HOME: codexHome });
    await pane.waitForText("Standing by");

    // Give the watcher several poll cycles to misfire, if it were going to.
    await new Promise((r) => setTimeout(r, 1200));
    expect(pane.lastFrame).toContain("Standing by");
  });

  it("runs fine when Codex is not installed at all", async () => {
    env = makeEnv();
    await cli(["hook", "UserPromptSubmit"], env);
    pane = new Pane(BASE, env, { CODEX_HOME: path.join(env.home, "no-codex-here") });
    await pane.waitForText("new word");
    pane.send("q");
    expect(await pane.exited).toBe(0);
  });
});
