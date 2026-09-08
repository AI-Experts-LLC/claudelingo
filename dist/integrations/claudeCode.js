import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * The hooks claudelingo installs, and what each one means for the pane.
 *
 * `Notification` maps to idle on purpose: Claude Code fires it when it wants a
 * permission decision, and that is precisely when the human should be looking at
 * Claude rather than at a vocabulary card.
 */
export const HOOK_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "SessionEnd",
    "Notification",
];
/**
 * `SessionStart` does not report agent state — it opens the pane.
 *
 * It must run with `async: true`: hooks block the session by default, and opening
 * a tmux pane is not something the user should wait on before they can type.
 */
const PANE_EVENT = "SessionStart";
const MARKER = "claudelingo";
/**
 * Seconds between status-line redraws.
 *
 * Claude Code's own updates are event-driven and go quiet exactly when the agent
 * is thinking — which is when the line is supposed to be teaching. A timer keeps
 * the word rotating and the answer revealing through a long turn.
 */
const STATUS_REFRESH_SECONDS = 3;
export class StatusLineTaken extends Error {
}
export function settingsPath(scope = "user", cwd = process.cwd()) {
    return scope === "user"
        ? path.join(os.homedir(), ".claude", "settings.json")
        : path.join(cwd, ".claude", "settings.json");
}
function commandFor(event, bin) {
    return event === PANE_EVENT ? `${bin} session-start` : `${bin} hook ${event} --source claude`;
}
function isOurs(command) {
    return command.includes(MARKER) && / hook | session-start/.test(command);
}
/**
 * Merge our hooks into an existing settings file without disturbing anything else.
 *
 * Re-running is safe: our own entries are replaced, everyone else's are preserved.
 */
export function withHooks(settings, bin) {
    const hooks = { ...(settings.hooks ?? {}) };
    for (const event of HOOK_EVENTS) {
        const existing = hooks[event] ?? [];
        const cleaned = existing
            .map((matcher) => ({
            ...matcher,
            hooks: (matcher.hooks ?? []).filter((hook) => !isOurs(hook.command ?? "")),
        }))
            .filter((matcher) => matcher.hooks.length > 0);
        const entry = event === PANE_EVENT
            ? { type: "command", command: commandFor(event, bin), async: true }
            : { type: "command", command: commandFor(event, bin) };
        hooks[event] = [...cleaned, { hooks: [entry] }];
    }
    return { ...settings, hooks };
}
export function removeHooks(settings) {
    const hooks = {};
    for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
        const cleaned = matchers
            .map((matcher) => ({
            ...matcher,
            hooks: (matcher.hooks ?? []).filter((hook) => !isOurs(hook.command ?? "")),
        }))
            .filter((matcher) => matcher.hooks.length > 0);
        if (cleaned.length)
            hooks[event] = cleaned;
    }
    const next = { ...settings };
    if (Object.keys(hooks).length)
        next.hooks = hooks;
    else
        delete next.hooks;
    return next;
}
/**
 * Point Claude Code's status line at us.
 *
 * There is exactly one status-line slot, so someone else's is never overwritten —
 * that would silently replace whatever they had configured, and unlike the hooks
 * there is nowhere for both to live.
 */
export function withStatusLine(settings, bin) {
    const existing = settings.statusLine;
    const ours = `${bin} statusline`;
    if (existing && !existing.command?.includes(`${bin} statusline`)) {
        throw new StatusLineTaken(`a status line is already configured (${existing.command}). Claude Code allows ` +
            "only one, so claudelingo has left it alone. Remove it and re-run " +
            "`claudelingo init` to use claudelingo's instead, or run " +
            "`claudelingo init --no-statusline` to skip this part.");
    }
    return {
        ...settings,
        statusLine: { type: "command", command: ours, refreshInterval: STATUS_REFRESH_SECONDS },
    };
}
export function removeStatusLine(settings, bin) {
    if (!settings.statusLine?.command?.includes(`${bin} statusline`))
        return settings;
    const next = { ...settings };
    delete next.statusLine;
    return next;
}
export function readSettings(file) {
    if (!fs.existsSync(file))
        return {};
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        throw new Error(`${file} is not valid JSON — fix it before installing hooks (${error.message})`);
    }
}
export function writeSettings(file, settings) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.claudelingo.tmp`;
    try {
        const fd = fs.openSync(tmp, "w");
        fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.renameSync(tmp, file);
    }
    catch (error) {
        // Never leave an orphan temp file in the user's config directory, and never
        // let a cleanup failure mask the write failure.
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // Nothing further to do.
        }
        throw error;
    }
}
export function install(file, bin, options = {}) {
    const current = readSettings(file);
    // A plugin install already brings the hooks with it; only the status line has
    // to come from the main config, because Claude Code will not take one from a
    // plugin. `hooks: false` is that case.
    let next = options.hooks === false ? current : withHooks(current, bin);
    const result = {};
    if (options.statusLine !== false) {
        try {
            next = withStatusLine(next, bin);
        }
        catch (error) {
            // The hooks are the load-bearing half; a taken status line must not stop
            // them being installed.
            if (!(error instanceof StatusLineTaken))
                throw error;
            result.statusLineProblem = error.message;
        }
    }
    writeSettings(file, next);
    return result;
}
/** True when the configured status line is the one we installed. */
export function hasOurStatusLine(file, bin) {
    if (!fs.existsSync(file))
        return false;
    try {
        return Boolean(readSettings(file).statusLine?.command?.includes(`${bin} statusline`));
    }
    catch {
        return false;
    }
}
export function uninstall(file, bin) {
    if (!fs.existsSync(file))
        return;
    writeSettings(file, removeStatusLine(removeHooks(readSettings(file)), bin));
}
/* ── The /lingo skill ────────────────────────────────────────────────────────
 *
 * A plugin install carries `skills/` with it and Claude Code finds it there. The
 * standalone installer does not, so `/lingo` came back "Unknown command" for
 * anyone who took that route — the README promised it either way. `init` links it
 * in, unless we are *running as* the plugin, where a second copy under the same
 * name would be ambiguous.
 */
export function skillsDir() {
    return path.join(os.homedir(), ".claude", "skills");
}
/**
 * The package root above a file inside the build.
 *
 * Walked rather than counted: callers live at different depths (`dist/cli.js` and
 * `dist/integrations/claudeCode.js`), and a hardcoded number of `..` silently
 * resolved above the package for one of them — which is exactly how a skill goes
 * missing without anyone noticing.
 */
export function packageRoot(fromFile) {
    let dir = path.dirname(path.resolve(fromFile));
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, "package.json")))
            return dir;
        const up = path.dirname(dir);
        if (up === dir)
            break;
        dir = up;
    }
    return null;
}
/** Where this build keeps its skills, or null when it has none beside it. */
export function bundledSkill(fromFile) {
    const root = packageRoot(fromFile);
    if (!root)
        return null;
    const dir = path.join(root, "skills", "lingo");
    return fs.existsSync(path.join(dir, "SKILL.md")) ? dir : null;
}
/** True when this copy is itself an installed Claude Code plugin. */
export function runningAsPlugin(fromFile) {
    if (process.env.CLAUDE_PLUGIN_ROOT)
        return true;
    const root = packageRoot(fromFile);
    if (!root)
        return false;
    const plugins = path.join(os.homedir(), ".claude", "plugins") + path.sep;
    return path.resolve(root).startsWith(plugins);
}
/**
 * Link `skills/lingo` into the user's skills directory.
 *
 * A directory that is not ours is never touched or overwritten — someone else's
 * `lingo` skill is theirs, and silently replacing it would be the same class of
 * mistake as overwriting a deck.
 */
export function installSkill(fromFile) {
    if (runningAsPlugin(fromFile))
        return { state: "plugin" };
    const source = bundledSkill(fromFile);
    if (!source)
        return { state: "missing" };
    const target = path.join(skillsDir(), "lingo");
    let existing = null;
    try {
        existing = fs.readlinkSync(target);
    }
    catch (error) {
        const code = error.code;
        if (code === "EINVAL")
            return { state: "taken", path: target };
        if (code !== "ENOENT")
            throw error;
    }
    if (existing !== null) {
        if (path.resolve(existing) === path.resolve(source))
            return { state: "already" };
        // Anything else that is still there belongs to someone: a different skill, or
        // another copy of this one that is on disk and working. Only a link whose
        // target has gone is safe to replace — matching on the path text was a guess,
        // and a guess is not good enough to justify deleting.
        if (fs.existsSync(path.resolve(existing)))
            return { state: "taken", path: target };
    }
    fs.mkdirSync(skillsDir(), { recursive: true });
    // Replacing our own stale link, so the target is not someone else's work.
    fs.rmSync(target, { force: true });
    fs.symlinkSync(source, target);
    return { state: "linked", path: target };
}
/**
 * Remove the link, but only when it points at *this* build's skill.
 *
 * Uninstalling must not take someone else's `lingo` with it, and "the path has
 * our name in it" is not proof of ownership.
 */
export function uninstallSkill(fromFile) {
    const source = bundledSkill(fromFile);
    if (!source)
        return false;
    const target = path.join(skillsDir(), "lingo");
    let existing;
    try {
        existing = fs.readlinkSync(target);
    }
    catch {
        return false;
    }
    if (path.resolve(existing) !== path.resolve(source))
        return false;
    fs.rmSync(target, { force: true });
    return true;
}
//# sourceMappingURL=claudeCode.js.map