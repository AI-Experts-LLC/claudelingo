import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const stream = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    beta = { messages: { create, stream } };
  },
}));

import { DEFAULT_MODEL, EnrichError, generatePack, memoryHook } from "../../src/enrich.js";
import { loadPack } from "../../src/packs/index.js";
import { tempHome } from "../helpers.js";

let home: string;

beforeEach(() => {
  home = tempHome();
  process.env.CLAUDELINGO_HOME = home;
  create.mockReset();
  stream.mockReset();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CLAUDELINGO_HOME;
});

const textReply = (text: string) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
});

describe("memory hooks", () => {
  const pack = loadPack("es");
  const word = pack.words[0]!;

  it("asks Claude Fable 5.1 by default", async () => {
    create.mockResolvedValue(textReply("el = the, as in El Niño"));
    await memoryHook(word, pack);
    expect(DEFAULT_MODEL).toBe("claude-fable-5-1");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: "claude-fable-5-1" });
  });

  it("omits the thinking parameter, which Fable 5.1 rejects", async () => {
    create.mockResolvedValue(textReply("hook"));
    await memoryHook(word, pack);
    // Assert the call happened first: `not.toHaveProperty` on undefined passes
    // vacuously, so without this the test proves nothing if nothing was called.
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toBeDefined();
    expect(params).not.toHaveProperty("thinking");
  });

  it("reports a timeout as a timeout, not as a bare abort", async () => {
    // The SDK surfaces every abort as "Request was aborted", which tells the
    // user nothing about why the hook never arrived.
    create.mockImplementation(
      (_params: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")));
        }),
    );
    await expect(memoryHook(word, pack, { timeoutMs: 30 })).rejects.toThrow(/no reply within/);
  });

  it("opts into a server-side fallback so a refusal is rescued in-call", async () => {
    create.mockResolvedValue(textReply("hook"));
    await memoryHook(word, pack);
    const params = create.mock.calls[0]?.[0];
    expect(params.betas).toContain("server-side-fallback-2026-06-01");
    expect(params.fallbacks?.[0]?.model).toBeTruthy();
  });

  it("keeps the request cheap with low effort", async () => {
    create.mockResolvedValue(textReply("hook"));
    await memoryHook(word, pack);
    expect(create.mock.calls[0]?.[0].output_config).toMatchObject({ effort: "low" });
  });

  it("passes the word, its part of speech and its gloss", async () => {
    create.mockResolvedValue(textReply("hook"));
    await memoryHook(word, pack);
    const content = create.mock.calls[0]?.[0].messages[0].content as string;
    expect(content).toContain(word.term);
    expect(content).toContain(word.gloss);
    expect(content).toContain("Spanish");
  });

  it("honours an explicit model override", async () => {
    create.mockResolvedValue(textReply("hook"));
    await memoryHook(word, pack, { model: "claude-opus-5" });
    expect(create.mock.calls[0]?.[0].model).toBe("claude-opus-5");
  });

  it("caches on disk so the same word is never paid for twice", async () => {
    create.mockResolvedValue(textReply("el = the, as in El Niño"));
    const first = await memoryHook(word, pack);
    const second = await memoryHook(word, pack);
    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refusal rather than showing an empty hook", async () => {
    create.mockResolvedValue({ content: [], stop_reason: "refusal" });
    await expect(memoryHook(word, pack)).rejects.toBeInstanceOf(EnrichError);
  });

  it("rejects an empty reply", async () => {
    create.mockResolvedValue(textReply("   "));
    await expect(memoryHook(word, pack)).rejects.toThrow(/empty/);
  });

  it("lets a transport error through to the caller", async () => {
    create.mockRejectedValue(new Error("network down"));
    await expect(memoryHook(word, pack)).rejects.toThrow("network down");
  });
});

describe("pack generation", () => {
  function mockStream(payload: unknown, stopReason = "end_turn") {
    stream.mockReturnValue({
      finalMessage: async () => ({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        stop_reason: stopReason,
      }),
    });
  }

  it("requests structured JSON from Fable 5.1 and streams it", async () => {
    mockStream({
      code: "pt", name: "Português", englishName: "Portuguese",
      words: [{ term: "de", gloss: "of", pos: "prep" }],
    });
    await generatePack("Portuguese", "pt", 1);
    const params = stream.mock.calls[0]?.[0];
    expect(params.model).toBe("claude-fable-5-1");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params).not.toHaveProperty("thinking");
  });

  it("converts the reply into the compact pack format", async () => {
    mockStream({
      code: "pt", name: "Português", englishName: "Portuguese",
      words: [
        { term: "de", gloss: "of", pos: "prep" },
        { term: "casa", gloss: "house", pos: "noun", note: "feminine" },
      ],
    });
    const pack = await generatePack("Portuguese", "pt", 2);
    expect(pack.words).toEqual([
      ["de", "of", "prep"],
      ["casa", "house", "noun", "feminine"],
    ]);
  });

  it("drops duplicates and incomplete entries the model may emit", async () => {
    mockStream({
      code: "pt", name: "P", englishName: "Portuguese",
      words: [
        { term: "de", gloss: "of", pos: "prep" },
        { term: "de", gloss: "from", pos: "prep" },
        { term: "", gloss: "nothing", pos: "noun" },
        { term: "casa", gloss: "", pos: "noun" },
      ],
    });
    const pack = await generatePack("Portuguese", "pt", 4);
    expect(pack.words).toEqual([["de", "of", "prep"]]);
  });

  it("fails loudly on a refusal, malformed JSON, or an empty list", async () => {
    mockStream({ words: [] }, "refusal");
    await expect(generatePack("X", "xx", 1)).rejects.toThrow(/declined/);

    stream.mockReturnValue({
      finalMessage: async () => ({
        content: [{ type: "text", text: "not json" }],
        stop_reason: "end_turn",
      }),
    });
    await expect(generatePack("X", "xx", 1)).rejects.toThrow(/valid JSON/);

    mockStream({ code: "xx", name: "X", englishName: "X", words: [] });
    await expect(generatePack("X", "xx", 1)).rejects.toThrow(/no words/);
  });
});
