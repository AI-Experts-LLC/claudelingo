import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, EnrichError, ask, generatePack, hasClaude, memoryHook } from "../../src/enrich.js";
import { loadPack } from "../../src/packs/index.js";
import { tempHome } from "../helpers.js";

let home: string;

beforeEach(() => {
  home = tempHome();
  process.env.CLAUDELINGO_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CLAUDELINGO_HOME;
});

/** Stand in for `claude -p`, recording the argv it was given. */
function fakeClaude(replies: Array<Record<string, unknown> | string>) {
  const calls: string[][] = [];
  let index = 0;
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (typeof reply === "string") return { code: 0, stdout: reply, stderr: "" };
    return { code: 0, stdout: JSON.stringify(reply), stderr: "" };
  });
  return { run, calls, last: () => calls.at(-1) as string[] };
}

const ok = (result: string) => ({ type: "result", subtype: "success", is_error: false, result });

describe("asking through Claude Code", () => {
  it("runs the claude CLI in print mode, so no separate credential is involved", async () => {
    const claude = fakeClaude([ok("hello")]);
    await ask("a question", { run: claude.run });
    const args = claude.last();
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args.at(-1)).toBe("a question");
  });

  it("keeps it to a single completion rather than an agent loop", async () => {
    // This is a text request; a tool loop would be slow and could touch files.
    const claude = fakeClaude([ok("hello")]);
    await ask("q", { run: claude.run });
    const args = claude.last();
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
  });

  it("asks for the configured model by default", async () => {
    const claude = fakeClaude([ok("hello")]);
    await ask("q", { run: claude.run });
    expect(claude.last()[claude.last().indexOf("--model") + 1]).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("claude-fable-5-1");
  });

  it("falls back to the session's own model when that one is unavailable", async () => {
    // Claude Code exits 0 and returns prose when it does not know a model, so the
    // exit code alone cannot be trusted.
    const claude = fakeClaude([
      { type: "result", subtype: "error", is_error: true, result: "There's an issue with the selected model" },
      ok("hello"),
    ]);
    const text = await ask("q", { run: claude.run });
    expect(text).toBe("hello");
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[0]).toContain("--model");
    expect(claude.calls[1]).not.toContain("--model");
  });

  it("passes the persona as a system prompt rather than burying it in the question", async () => {
    const claude = fakeClaude([ok("hello")]);
    await ask("q", { run: claude.run, system: "be terse" });
    expect(claude.last()[claude.last().indexOf("--append-system-prompt") + 1]).toBe("be terse");
  });

  it("treats non-JSON output as a failure", async () => {
    const claude = fakeClaude(["not json at all"]);
    await expect(ask("q", { run: claude.run })).rejects.toBeInstanceOf(EnrichError);
  });

  it("treats an error result as a failure even though claude exits 0", async () => {
    const claude = fakeClaude([
      { type: "result", subtype: "error_max_turns", is_error: true, result: "ran out of turns" },
      { type: "result", subtype: "error_max_turns", is_error: true, result: "ran out of turns" },
    ]);
    await expect(ask("q", { run: claude.run })).rejects.toThrow(/ran out of turns/);
  });

  it("rejects an empty reply", async () => {
    const claude = fakeClaude([ok("   ")]);
    await expect(ask("q", { run: claude.run })).rejects.toThrow(/empty/);
  });
});

describe("memory hooks", () => {
  const pack = loadPack("es");
  const word = pack.words[0]!;

  it("asks about the word and caches the answer", async () => {
    const claude = fakeClaude([ok("el is the, as in El Nino")]);
    const first = await memoryHook(word, pack, { run: claude.run });
    const second = await memoryHook(word, pack, { run: claude.run });
    expect(second).toBe(first);
    expect(claude.calls).toHaveLength(1);
    expect(claude.last().at(-1)).toContain(word.term);
    expect(claude.last().at(-1)).toContain("Spanish");
  });

  it("treats an empty cached file as a miss", async () => {
    const dir = path.join(home, "cache");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `hook-es-${Buffer.from(word.term).toString("base64url")}.txt`),
      "",
    );
    const claude = fakeClaude([ok("a real hook")]);
    expect(await memoryHook(word, pack, { run: claude.run })).toBe("a real hook");
  });

  it("writes the cache atomically, leaving no temp file", async () => {
    const claude = fakeClaude([ok("a hook")]);
    await memoryHook(word, pack, { run: claude.run });
    const cached = fs.readdirSync(path.join(home, "cache"));
    expect(cached.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(cached).toHaveLength(1);
  });
});

describe("pack generation", () => {
  const body = {
    code: "pt", name: "Português", englishName: "Portuguese",
    words: [
      { term: "de", gloss: "of", pos: "prep" },
      { term: "casa", gloss: "house", pos: "noun", note: "feminine" },
      { term: "de", gloss: "duplicate", pos: "prep" },
    ],
  };

  it("converts the reply into the compact pack format", async () => {
    const claude = fakeClaude([ok(JSON.stringify(body))]);
    const pack = await generatePack("Portuguese", "pt", 3, { run: claude.run });
    expect(pack.words).toEqual([
      ["de", "of", "prep"],
      ["casa", "house", "noun", "feminine"],
    ]);
  });

  it("copes with a model that fences its JSON anyway", async () => {
    const claude = fakeClaude([ok(`\`\`\`json\n${JSON.stringify(body)}\n\`\`\``)]);
    const pack = await generatePack("Portuguese", "pt", 3, { run: claude.run });
    expect(pack.englishName).toBe("Portuguese");
  });

  it("continues from words already gathered instead of paying for them twice", async () => {
    const fake = fakeClaude([ok('{"words":[{"term":"tres","gloss":"three","pos":"num"}]}')]);
    const pack = await generatePack("X", "xx", 3, {
      run: fake.run,
      existing: [
        ["uno", "one", "num"],
        ["dos", "two", "num"],
      ],
    });
    expect(pack.words.map((w) => w[0])).toEqual(["uno", "dos", "tres"]);
    // …and it does not ask for the words it already has.
    expect(fake.calls[0]!.at(-1)).toContain("uno, dos");
  });

  it("stops asking once a language has no more words to give", async () => {
    // Every reply the same two words: without a barren counter this asks for
    // ever, burning quota on a language that has run dry.
    const fake = fakeClaude([ok('{"words":[{"term":"uno","gloss":"one","pos":"num"}]}')]);
    const pack = await generatePack("X", "xx", 500, { run: fake.run });
    expect(pack.words).toHaveLength(1);
    // One productive call, then three that add nothing, and it stops.
    expect(fake.calls.length).toBeLessThanOrEqual(5);
  });

  it("fails loudly when it never got a single word", async () => {
    // A later chunk failing keeps what came before it — see the e2e test — but a
    // run that gathered nothing has nothing to keep, and must say so.
    await expect(
      generatePack("X", "xx", 1, { run: fakeClaude([ok("not json"), ok("still not json")]).run }),
    ).rejects.toThrow(/no words/);
    await expect(
      generatePack("X", "xx", 1, { run: fakeClaude([ok('{"words":[]}')]).run }),
    ).rejects.toThrow(/no words/);
  });

  it("retries a chunk once, smaller, before giving up on it", async () => {
    // A reply that will not parse is usually a truncation, so the retry asks for
    // less. Without it, one flaky chunk ends the run where it stands.
    const fake = fakeClaude([
      ok("not json"),
      ok('{"words":[{"term":"uno","gloss":"one","pos":"num"}]}'),
    ]);
    // 300 asked for, so the first attempt is a full 100 and the retry is 50 —
    // sizes that tell a retry apart from simply moving on to the next chunk,
    // which would ask for another 100.
    const pack = await generatePack("X", "xx", 300, { run: fake.run });
    expect(pack.words.map((w) => w[0])).toEqual(["uno"]);
    expect(fake.calls[0]!.at(-1)).toContain("Exactly 100 entries");
    expect(fake.calls[1]!.at(-1)).toContain("Exactly 50 entries");
    // …and it retried the same band rather than skipping it.
    expect(fake.calls[1]!.at(-1)).toContain("ranked 1 to 50");
  });
});

describe("availability", () => {
  it("depends on the claude command, not on a credential", () => {
    expect(hasClaude(() => true)).toBe(true);
    expect(hasClaude(() => false)).toBe(false);
  });
});
