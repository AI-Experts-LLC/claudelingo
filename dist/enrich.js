import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { canCloze } from "./cloze.js";
import { paths } from "./config.js";
/**
 * Everything that needs a model goes through the `claude` CLI in print mode.
 *
 * That matters for one reason above all: it runs on the Claude Code login the user
 * already has, and counts against the usage they are already paying for. Calling
 * the Anthropic API directly would mean a second credential and a separate bill for
 * something that only ever runs while Claude Code is open.
 *
 * It also means claudelingo ships with no API SDK and no key handling at all.
 */
/** Preferred model. Claude Code falls back to the session's own if it cannot use it. */
export const DEFAULT_MODEL = "claude-fable-5-1";
/** A memory hook is two short lines; a pack is a few hundred entries. */
const HOOK_TIMEOUT_MS = 90_000;
const PACK_TIMEOUT_MS = 10 * 60_000;
export class EnrichError extends Error {
}
/**
 * Most a reply may occupy in memory.
 *
 * A hook is two lines and a pack a few hundred kilobytes; anything past this is a
 * runaway, and accumulating it unbounded lets a misbehaving child abort the
 * process with a V8 heap failure that no `catch` can see.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
function runClaude(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        // `detached` puts the child in its own process group so the whole tree can be
        // signalled. Killing only the direct child leaves grandchildren holding the
        // stdio pipes open, so `close` never fires and this process cannot exit —
        // and Claude Code does spawn subprocesses.
        const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const stop = () => {
            try {
                process.kill(-child.pid, "SIGKILL");
            }
            catch {
                // Already gone, or never started.
            }
            // Streams a grandchild may still hold; without this the loop stays alive.
            child.stdout?.destroy();
            child.stderr?.destroy();
        };
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            stop();
            finish(() => reject(new EnrichError(`no reply within ${Math.round(timeoutMs / 1000)}s`)));
        }, timeoutMs);
        const collect = (into) => (chunk) => {
            if (into === "out")
                stdout += chunk.toString();
            else
                stderr += chunk.toString();
            if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
                stop();
                finish(() => reject(new EnrichError("the reply was too large to read")));
            }
        };
        child.stdout.on("data", collect("out"));
        child.stderr.on("data", collect("err"));
        child.on("error", (error) => {
            finish(() => reject(error.code === "ENOENT"
                ? new EnrichError("the `claude` command is not on your PATH")
                : new EnrichError(error.message)));
        });
        child.on("close", (code) => finish(() => resolve({ code: code ?? 0, stdout, stderr })));
    });
}
/**
 * Ask Claude Code one question and return its text.
 *
 * `--max-turns 1` keeps it to a single completion: this is a text request, and a
 * tool loop would be slow, surprising, and able to touch the user's files.
 */
export async function ask(prompt, options = {}) {
    const run = options.run ?? runClaude;
    const timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS;
    const base = ["-p", "--output-format", "json", "--max-turns", "1"];
    if (options.system)
        base.push("--append-system-prompt", options.system);
    const deadline = Date.now() + timeoutMs;
    const attempt = async (model) => {
        const args = model ? [...base, "--model", model, prompt] : [...base, prompt];
        // One budget across both attempts, so a retry cannot double the wait.
        const remaining = Math.max(1000, deadline - Date.now());
        const { code, stdout, stderr } = await run(args, remaining);
        let parsed;
        try {
            parsed = JSON.parse(stdout);
        }
        catch {
            // A model Claude Code does not recognise produces prose on stdout and still
            // exits 0, so the exit code alone cannot be trusted.
            throw new EnrichError((stderr || stdout || `claude exited ${code} with no output`).trim().split("\n")[0]);
        }
        if (parsed.is_error || parsed.subtype !== "success") {
            throw new EnrichError((parsed.result || parsed.subtype || "claude reported an error").trim());
        }
        const text = (parsed.result ?? "").trim();
        if (!text)
            throw new EnrichError("empty response");
        return text;
    };
    const model = options.model ?? DEFAULT_MODEL;
    try {
        return await attempt(model);
    }
    catch (error) {
        // The preferred model may not exist in this Claude Code build. The session's
        // own model is a better answer than no answer — but only retry for that, not
        // for any failure whose text happens to mention a model.
        const unavailable = error instanceof EnrichError &&
            /(issue with the selected model|model catalog|unrecognized_model|unknown model|does not exist)/i.test(error.message);
        if (unavailable)
            return attempt();
        throw error;
    }
}
/**
 * Read a cached hook, treating an empty or unreadable file as a cache miss.
 *
 * Returning "" would hand the UI a hook that renders as nothing at all: no text,
 * no spinner, no error, and a key that silently does nothing every time it is
 * pressed. A miss simply costs one request.
 */
function readCache(file) {
    try {
        const text = fs.readFileSync(file, "utf8").trim();
        return text.length > 0 ? text : null;
    }
    catch {
        return null;
    }
}
/** Best effort: an unwritable cache costs a repeat request, nothing more. */
function writeCache(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(paths.cache(), { recursive: true });
        // Written and renamed, so an interrupted write cannot leave a truncated file
        // that would then be served as a cache hit forever.
        fs.writeFileSync(tmp, `${text}\n`, "utf8");
        fs.renameSync(tmp, file);
    }
    catch {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // Nothing further to do.
        }
    }
}
/**
 * A hook we already have, or null. Never fetches.
 *
 * The panel is read-only and runs every couple of seconds; reaching the model
 * from there would spend the user's quota on a decoration, once per tick.
 */
export function cachedHook(lang, term) {
    return readCache(cacheFile(lang, term));
}
function cacheFile(lang, term) {
    const safe = Buffer.from(term).toString("base64url");
    return path.join(paths.cache(), `hook-${lang}-${safe}.txt`);
}
const HOOK_SYSTEM = "You help an English speaker memorise high-frequency vocabulary. " +
    "Reply with at most two short lines of plain text: a memory hook " +
    "(cognate, etymology, or vivid image) and one very short example sentence " +
    "with its English translation. No preamble, no markdown, no bullet points.";
/**
 * A one- or two-line memory hook for a word. Cached on disk, because the hook for
 * "tiempo" never changes.
 */
export async function memoryHook(word, pack, options = {}) {
    const file = cacheFile(pack.code, word.term);
    const cached = readCache(file);
    if (cached)
        return cached;
    const text = await ask(`${pack.englishName} word: "${word.term}" (${word.pos}) = "${word.gloss}".`, { ...options, system: HOOK_SYSTEM });
    writeCache(file, text);
    return text;
}
const PACK_SYSTEM = "You are a corpus linguist building a beginner vocabulary pack. " +
    "Order words by descending corpus frequency, one dictionary form per entry, " +
    "no duplicate terms and no two entries sharing an English gloss. " +
    "`pos` is one of: noun, verb, adj, adv, prep, conj, pron, art, num, interj. " +
    "`gloss` is a short English translation; `note` carries gender or an " +
    "irregularity when it matters. `example` is a short natural sentence that " +
    "*contains the entry's term verbatim*, then ` | `, then its English " +
    "translation — six to twelve words, using only vocabulary at least as common " +
    "as the entry itself. Reply with JSON only — no prose, no code fence.";
/** How many words to ask for in one request. */
const PACK_CHUNK = 100;
/** One request: the words ranked `from`..`from + size - 1`. */
async function packChunk(language, code, from, size, known, options) {
    // The already-taken terms go in the prompt because the model cannot see the
    // earlier chunks: without them the boundaries overlap heavily and a 1000-word
    // pack comes back with 600 distinct words.
    const avoid = known.length
        ? ` Do not repeat any of these, which are already in the pack: ${known.join(", ")}.`
        : "";
    const raw = await ask(`Produce words ranked ${from} to ${from + size - 1} by frequency in ${language}, ` +
        `as JSON of the form {"words":[{"term":"","gloss":"","pos":"","note":"","example":""}]}. ` +
        `Exactly ${size} entries, continuing the frequency order — not the commonest words ` +
        `again.${avoid} Omit "note" when it does not apply.`, { ...options, system: PACK_SYSTEM, timeoutMs: options.timeoutMs ?? PACK_TIMEOUT_MS });
    const body = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        throw new EnrichError(`Claude did not return valid JSON for words ${from}-${from + size - 1}`);
    }
    if (!Array.isArray(parsed.words)) {
        throw new EnrichError(`Claude returned no words for ${from}-${from + size - 1}`);
    }
    return parsed.words;
}
/**
 * Build a frequency pack for a language claudelingo does not ship.
 *
 * Asked in chunks, because one request for a thousand entries with a sentence
 * each is a very long reply: it truncates, and a truncated JSON body is a whole
 * pack lost rather than one chunk. Each chunk is told what the earlier ones
 * produced, or the boundaries overlap and the duplicates eat the count.
 */
export async function generatePack(language, code, count, options = {}) {
    const { onProgress, ...ask } = options;
    const seen = new Set();
    const words = [];
    for (let from = 1; from <= count; from += PACK_CHUNK) {
        const size = Math.min(PACK_CHUNK, count - from + 1);
        // Only the most recent terms: the whole list would grow the prompt without
        // bound, and it is the boundary that overlaps, not the beginning.
        const entries = await packChunk(language, code, from, size, [...seen].slice(-120), ask);
        for (const entry of entries) {
            if (!entry?.term || !entry.gloss || !entry.pos)
                continue;
            // Deduped on the *cleaned* term, which is what the loader compares. On the
            // raw string "casa" and "  casa  " both survive generation, and `savePack`
            // then throws `duplicate term`, losing a run that can take ten minutes.
            const key = entry.term.replace(/\s+/g, " ").trim().toLowerCase();
            if (!key || seen.has(key))
                continue;
            seen.add(key);
            // A sentence that does not contain its own word cannot be clozed, and one
            // without a translation cannot be shown. The loader drops both anyway;
            // writing them to disk would just be junk in a file people read.
            const example = (entry.example ?? "").trim();
            const [text, translation] = example.split("|");
            const usable = !!text && !!translation?.trim() && canCloze(text, entry.term);
            const row = [entry.term, entry.gloss, entry.pos];
            if (usable)
                row.push(entry.note ?? "", example);
            else if (entry.note)
                row.push(entry.note);
            words.push(row);
            if (words.length >= count)
                break;
        }
        onProgress?.(words.length, count);
        if (words.length >= count)
            break;
    }
    if (!words.length)
        throw new EnrichError("Claude returned no words");
    return { code, name: language, englishName: language, words };
}
/**
 * Whether the `claude` command is available.
 *
 * There is no credential to check any more: if Claude Code runs, so does this.
 */
export function hasClaude(runner = probeClaude) {
    return runner();
}
function probeClaude() {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    return dirs.some((dir) => {
        for (const name of ["claude", "claude.cmd", "claude.exe"]) {
            try {
                const candidate = path.join(dir, name);
                fs.accessSync(candidate, fs.constants.X_OK);
                // A *directory* named `claude` is executable-by-permission but is not the
                // command; offering `e` on that basis fails on every press.
                if (fs.statSync(candidate).isFile())
                    return true;
            }
            catch {
                // Keep looking.
            }
        }
        return false;
    });
}
//# sourceMappingURL=enrich.js.map