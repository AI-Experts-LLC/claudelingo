import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const DEFAULT_SETTINGS = {
    lang: "es",
    maxLearning: 8,
    newPerDay: 20,
    staleBusyMs: 15 * 60 * 1000,
    alwaysOn: false,
    enrich: true,
    model: "claude-fable-5-1",
    autoPane: true,
    askFirst: false,
    onboarded: false,
};
/**
 * Root for all state. `CLAUDELINGO_HOME` exists so tests (and anyone running two
 * languages side by side) get a clean, isolated directory.
 */
export function home() {
    return process.env.CLAUDELINGO_HOME || path.join(os.homedir(), ".claudelingo");
}
export const paths = {
    home,
    settings: () => path.join(home(), "settings.json"),
    status: () => path.join(home(), "status.json"),
    progress: (lang) => path.join(home(), `progress-${lang}.json`),
    lock: (lang) => path.join(home(), `progress-${lang}.lock`),
    pending: (lang) => path.join(home(), `pending-${lang}.json`),
    cache: () => path.join(home(), "cache"),
    packs: () => path.join(home(), "packs"),
};
export function ensureHome() {
    const dir = home();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
/**
 * Write via a temp file, flushed and renamed, so a crash mid-write can never leave a
 * half-written or zero-length file behind. The temp file is cleaned up on failure so
 * a full disk does not litter the directory with orphans.
 */
export function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    let fd = null;
    try {
        fd = fs.openSync(tmp, "w");
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        // Without the flush the rename can reach disk before the bytes do, which is
        // exactly how a power cut produces an empty file where state used to be.
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, file);
    }
    catch (error) {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            }
            catch {
                // Already closed or never opened cleanly; the throw below is what matters.
            }
        }
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // Best effort — never mask the original write failure with a cleanup failure.
        }
        throw error;
    }
}
export function readJsonFile(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return { ok: false, reason: "missing" };
        return { ok: false, reason: "unreadable", error: error };
    }
    try {
        return { ok: true, value: JSON.parse(raw) };
    }
    catch (error) {
        // Read fine, parsed badly: genuinely bad content.
        return { ok: false, reason: "invalid", error: error };
    }
}
/**
 * Move a file that could not be read out of the way, returning its new path.
 *
 * Nothing is ever deleted: if the data turns out to be salvageable the user still
 * has it, and the caller can tell them exactly where it went.
 */
export function quarantine(file) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${file}.corrupt-${stamp}`;
    try {
        fs.renameSync(file, target);
        return target;
    }
    catch {
        return null;
    }
}
export function loadSettings() {
    const result = readJsonFile(paths.settings());
    if (result.ok)
        return { settings: { ...DEFAULT_SETTINGS, ...result.value } };
    if (result.reason === "missing")
        return { settings: { ...DEFAULT_SETTINGS } };
    const what = result.reason === "invalid" ? "is not valid JSON" : "could not be read";
    return {
        settings: { ...DEFAULT_SETTINGS },
        problem: `${paths.settings()} ${what} (${result.error?.message ?? "unknown error"}); ` +
            "using defaults and leaving it alone.",
    };
}
export function saveSettings(settings) {
    writeJsonAtomic(paths.settings(), settings);
}
//# sourceMappingURL=config.js.map