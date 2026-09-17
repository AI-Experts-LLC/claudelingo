#!/bin/sh
# claudelingo installer.
#
#   curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh
#
# Uninstall:
#
#   curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh -s -- --uninstall
#
# What it does:
#
#   1. Clones claudelingo into ~/.claude/skills/claudelingo, where Claude Code
#      loads it as a plugin. Re-running updates it.
#   2. Turns on function hooks, the early-access Claude Code feature mods run on,
#      by adding CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 to the "env" block of
#      ~/.claude/settings.json. A backup is written first.
#   3. If the older, pre-mod claudelingo is wired into that file (its status
#      line and hooks), removes those entries so you do not get two claudelingos
#      writing two decks. Your old progress is imported on first run.
#
# --uninstall removes the plugin and puts the function-hooks setting back the
# way it found it. It does not put back the old claudelingo entries it removed;
# those are in the settings.json.claudelingo-backup file it wrote.
#
# Pass --no-settings to leave settings.json alone; you then start Claude Code
# with `claude-lingo` instead of `claude`.
#
# Set CLAUDELINGO_REPO / CLAUDELINGO_REF to install from a fork or a branch.

set -eu

REPO="${CLAUDELINGO_REPO:-https://github.com/AI-Experts-LLC/claudelingo}"
REF="${CLAUDELINGO_REF:-main}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DIR="$CLAUDE_DIR/skills/claudelingo"
SETTINGS="$CLAUDE_DIR/settings.json"
STATE="$DIR/.install-state"
BIN="$HOME/.local/bin"
LAUNCHER="$BIN/claude-lingo"
MIN_VERSION="2.1.271"

say() { printf '%s\n' "$*"; }
step() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# `1.2.10` >= `1.2.9`, without relying on `sort -V`, which older macOS lacks.
version_at_least() {
  awk -v have="$1" -v need="$2" 'BEGIN {
    split(have, h, "."); split(need, n, ".")
    for (i = 1; i <= 3; i++) {
      if ((h[i] + 0) > (n[i] + 0)) exit 0
      if ((h[i] + 0) < (n[i] + 0)) exit 1
    }
    exit 0
  }'
}

have_python() {
  command -v python3 >/dev/null 2>&1 && python3 -c 'import json' >/dev/null 2>&1
}

# Every settings.json change goes through here: real JSON in, real JSON out,
# a backup before the first write, and a report of exactly what changed.
edit_settings() {
  python3 - "$SETTINGS" "$1" "$STATE" <<'PY'
import json, os, shlex, shutil, sys, tempfile

path, mode, state_path = sys.argv[1], sys.argv[2], sys.argv[3]
FLAG = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"

# Exit 3 means "left settings.json alone"; the shell falls back to a launcher.
def refuse(reason):
    print(f"{reason}; leaving settings.json alone", file=sys.stderr)
    sys.exit(3)

# Write through a symlink, never over it. Settings managed from a dotfiles repo
# (stow, chezmoi, home-manager) are a link to the real file, and replacing the
# link with a regular file would silently cut it off from where it is managed.
target = os.path.realpath(path)
directory = os.path.dirname(target)

try:
    with open(target) as f:
        text = f.read()
    settings = json.loads(text) if text.strip() else {}
    exists = True
except FileNotFoundError:
    settings, exists = {}, False
except ValueError as error:
    refuse(f"settings.json is not valid JSON ({error})")
except OSError as error:
    refuse(f"settings.json could not be read ({error})")

if not isinstance(settings, dict):
    refuse("settings.json is not a JSON object")

if exists and not os.access(target, os.W_OK):
    refuse("settings.json is not writable, so it is probably managed elsewhere")
if os.path.isdir(directory) and not os.access(directory, os.W_OK):
    refuse(f"{directory} is not writable")

def load_state():
    try:
        with open(state_path) as f:
            loaded = json.load(f)
            return loaded if isinstance(loaded, dict) else {}
    except (OSError, ValueError):
        return {}

state = load_state()
before = json.dumps(settings, sort_keys=True)
changes = []

def is_old_claudelingo(command, verbs):
    """True only if the program being run *is* claudelingo, asked for one of `verbs`.

    The same rule the older claudelingo used to recognise its own entries. A
    command that merely mentions claudelingo, such as a user's `sh -c` that also
    runs it or a script called `notify-claudelingo`, is not ours and is kept.
    """
    try:
        words = shlex.split(str(command))
    except ValueError:
        return False
    return len(words) >= 2 and os.path.basename(words[0]) == "claudelingo" and words[1] in verbs

if mode == "install":
    env = settings.setdefault("env", {})
    if not isinstance(env, dict):
        refuse('settings.json "env" is not an object')

    if env.get(FLAG) != "1":
        # Remember what was there, so uninstall can put it back exactly.
        if "flag" not in state:
            state["flag"] = {"present": FLAG in env, "value": env.get(FLAG)}
        env[FLAG] = "1"
        changes.append(f"set env.{FLAG} = 1")

    line = settings.get("statusLine")
    if isinstance(line, dict) and is_old_claudelingo(line.get("command", ""), {"statusline"}):
        del settings["statusLine"]
        changes.append("removed the old claudelingo status line")

    hooks = settings.get("hooks")
    if isinstance(hooks, dict):
        removed = 0
        for event in list(hooks):
            groups = hooks[event]
            if not isinstance(groups, list):
                continue
            kept_groups = []
            for group in groups:
                inner = group.get("hooks") if isinstance(group, dict) else None
                if not isinstance(inner, list):
                    kept_groups.append(group)
                    continue
                kept = [
                    h for h in inner
                    if not (isinstance(h, dict) and is_old_claudelingo(h.get("command", ""), {"hook", "session-start"}))
                ]
                removed += len(inner) - len(kept)
                if kept:
                    group["hooks"] = kept
                    kept_groups.append(group)
            if kept_groups:
                hooks[event] = kept_groups
            else:
                del hooks[event]
        if not hooks:
            del settings["hooks"]
        if removed:
            changes.append(f"removed {removed} old claudelingo hook{'s' if removed != 1 else ''}")

elif mode == "uninstall":
    previous = state.get("flag")
    env = settings.get("env")
    if isinstance(previous, dict) and isinstance(env, dict) and env.get(FLAG) == "1":
        if previous.get("present"):
            env[FLAG] = previous.get("value")
            changes.append(f"restored env.{FLAG} to its previous value")
        else:
            del env[FLAG]
            if not env:
                del settings["env"]
            changes.append(f"removed env.{FLAG}")

if json.dumps(settings, sort_keys=True) != before:
    if exists:
        # Never overwrite an earlier backup: the first one holds the original.
        backup = f"{target}.claudelingo-backup"
        n = 1
        while os.path.exists(backup):
            n += 1
            backup = f"{target}.claudelingo-backup-{n}"
        shutil.copy2(target, backup)
        changes.append(f"backup: {backup}")
    else:
        os.makedirs(directory, exist_ok=True)

    fd, tmp = tempfile.mkstemp(prefix=".settings.", suffix=".claudelingo-tmp", dir=directory)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        # Keep the original's permissions. settings.json often holds API keys in
        # its env block, and a new file would otherwise get the umask's, usually 644.
        if exists:
            shutil.copymode(target, tmp)
        else:
            os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

# Only once the write has landed does a record of it mean anything.
if mode == "install":
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w") as f:
        json.dump(state, f)

for change in changes:
    print(change)
PY
}

install_launcher() {
  mkdir -p "$BIN"
  cat > "$LAUNCHER" <<'LAUNCH'
#!/bin/sh
# Claude Code with function hooks on, for claudelingo. Installed by claudelingo.
exec env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude "$@"
LAUNCH
  chmod +x "$LAUNCHER"
}

# Things earlier installs of claudelingo left behind that would now get in the
# way: a second copy of the plugin would draw a second band, and the old /lingo
# skill would compete with the mod's /lingo.
remove_leftovers() {
  legacy="$CLAUDE_DIR/skills/claudelingo-mod"
  if [ -f "$legacy/.claude-plugin/plugin.json" ] && grep -q '"name": *"claudelingo"' "$legacy/.claude-plugin/plugin.json"; then
    rm -rf "$legacy"
    step "removed an older copy at $legacy"
  fi

  skill="$CLAUDE_DIR/skills/lingo"
  if [ -L "$skill" ] && readlink "$skill" | grep -q '\.claudelingo'; then
    rm -f "$skill"
    step "removed the old /lingo skill link"
  fi

  # An earlier hand-made launcher ran Claude Code with a settings overlay this
  # removes. Replace it with the current one rather than leave it pointing at a
  # file that is no longer there.
  if [ -f "$LAUNCHER" ] && grep -q 'claudelingo-mod-trial' "$LAUNCHER"; then
    install_launcher
    step "updated $LAUNCHER"
  fi

  if [ -f "$CLAUDE_DIR/claudelingo-mod-trial.settings.json" ]; then
    rm -f "$CLAUDE_DIR/claudelingo-mod-trial.settings.json"
  fi
}

uninstall() {
  say "Uninstalling claudelingo"

  if [ -f "$SETTINGS" ] && [ -f "$STATE" ]; then
    if ! have_python; then
      warn "python3 not found; remove env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS from $SETTINGS by hand if you want it gone"
    elif output=$(edit_settings uninstall); then
      [ -n "$output" ] && printf '%s\n' "$output" | while IFS= read -r line; do step "$line"; done
    else
      warn "could not update $SETTINGS; remove env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS from it by hand if you want it gone"
    fi
  fi

  if [ -d "$DIR" ]; then
    rm -rf "$DIR"
    step "removed $DIR"
  fi

  if [ -f "$LAUNCHER" ] && grep -q 'Installed by claudelingo' "$LAUNCHER"; then
    rm -f "$LAUNCHER"
    step "removed $LAUNCHER"
  fi

  say ""
  say "Your decks are kept, in $CLAUDE_DIR/plugins/store/claudelingo_*.json."
  say "Reinstall any time and they will be there."
}

main() {
  mode=install
  use_settings=1

  for arg in "$@"; do
    case "$arg" in
      --uninstall) mode=uninstall ;;
      --no-settings) use_settings=0 ;;
      -h|--help)
        # `$0` is just "sh" when piped from curl, so the usage lives here.
        say "usage: install.sh [--uninstall] [--no-settings]"
        say "  --uninstall    remove claudelingo (your decks are kept)"
        say "  --no-settings  leave settings.json alone; start with claude-lingo instead"
        exit 0
        ;;
      *) die "unknown option: $arg" ;;
    esac
  done

  if [ "$mode" = uninstall ]; then
    uninstall
    exit 0
  fi

  say "Installing claudelingo"

  command -v git >/dev/null 2>&1 || die "git is required"
  command -v claude >/dev/null 2>&1 || die "Claude Code is required: https://docs.claude.com/en/docs/claude-code"

  version=$(claude --version 2>/dev/null | awk '{print $1}')
  if [ -n "$version" ] && ! version_at_least "$version" "$MIN_VERSION"; then
    die "Claude Code $version is too old; claudelingo needs $MIN_VERSION or newer, which is on the latest release channel (the stable channel may not have reached it yet)"
  fi

  mkdir -p "$CLAUDE_DIR/skills"

  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch --quiet --depth 1 origin "$REF"
    git -C "$DIR" reset --quiet --hard FETCH_HEAD
    step "updated to $(git -C "$DIR" log --oneline -1)"
  else
    rm -rf "$DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
    step "installed $(git -C "$DIR" log --oneline -1)"
  fi

  remove_leftovers

  if [ "$use_settings" = 1 ] && have_python; then
    if output=$(edit_settings install); then
      [ -n "$output" ] && printf '%s\n' "$output" | while IFS= read -r line; do step "$line"; done
      say ""
      say "Done. Start Claude Code as usual:  claude"
    else
      warn "left settings.json unchanged (see above)"
      use_settings=0
    fi
  elif [ "$use_settings" = 1 ]; then
    warn "python3 not found, so settings.json was not changed"
    use_settings=0
  fi

  if [ "$use_settings" = 0 ]; then
    install_launcher
    step "installed $LAUNCHER"
    say ""
    case ":$PATH:" in
      *":$BIN:"*) say "Done. Start Claude Code with:  claude-lingo" ;;
      *) say "Done. Start Claude Code with:  $LAUNCHER   (or add $BIN to your PATH)" ;;
    esac
  fi

  say ""
  say "Start a task and a card appears above your prompt; press the digit beside"
  say "your answer. Press 1 on the idle band for a quiz. /lingo shows the rest."
  say "Uninstall: curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh -s -- --uninstall"
}

main "$@"
